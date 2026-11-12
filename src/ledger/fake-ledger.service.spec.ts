import { Test } from '@nestjs/testing';
import { GraphQLError } from 'graphql';
import { CURRENCIES, type Currency } from '../common/currency.js';
import { FakeLedgerService } from './fake-ledger.service.js';
import { LedgerErrorCode } from './ledger-errors.js';
import { LedgerService } from './ledger.service.js';
import { LedgerModule } from './ledger.module.js';
import {
  PLATFORM_FUNDING,
  platformAccount,
  userAccount,
  type EntryInput,
  type OperationType,
  type PostOperation,
} from './ledger.types.js';

const TYPE: OperationType = 'test_credit';

function operation(idempotencyKey: string, entries: EntryInput[]): PostOperation {
  return { type: TYPE, idempotencyKey, entries };
}

function credit(
  idempotencyKey: string,
  userId: string,
  currency: Currency,
  amount: bigint,
): PostOperation {
  return operation(idempotencyKey, [
    { account: platformAccount(PLATFORM_FUNDING, currency), amount: -amount },
    { account: userAccount(userId, currency), amount },
  ]);
}

async function balanceOf(
  service: LedgerService,
  userId: string,
  currency: Currency,
): Promise<bigint> {
  const balances = await service.getBalances(userId);
  return balances.find((balance) => balance.currency === currency)?.amount ?? -1n;
}

async function expectLedgerError(promise: Promise<unknown>, code: LedgerErrorCode): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GraphQLError);
  expect((error as GraphQLError).extensions['code']).toBe(code);
}

/**
 * The behaviour every `LedgerService` must have. It only uses the public API, so the Knex
 * implementation can run the same cases.
 */
function describeLedgerContract(name: string, createService: () => LedgerService): void {
  describe(`${name} (LedgerService contract)`, () => {
    let service: LedgerService;

    beforeEach(() => {
      service = createService();
    });

    it('gives a new user zero balances in all currencies, in CURRENCIES order', async () => {
      const balances = await service.getBalances('user-1');
      expect(balances).toEqual(CURRENCIES.map((currency) => ({ currency, amount: 0n })));
    });

    it('credits a user from the platform funding account, which may go negative', async () => {
      const { replayed } = await service.post(credit('k1', 'user-1', 'UAH', 100000n));
      expect(replayed).toBe(false);
      expect(await balanceOf(service, 'user-1', 'UAH')).toBe(100000n);
      expect(await balanceOf(service, 'user-1', 'USD')).toBe(0n);
    });

    it('rejects an operation that does not sum to zero and changes nothing', async () => {
      await expectLedgerError(
        service.post(
          operation('k1', [
            { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: -100n },
            { account: userAccount('user-1', 'UAH'), amount: 90n },
          ]),
        ),
        LedgerErrorCode.UnbalancedOperation,
      );
      expect(await balanceOf(service, 'user-1', 'UAH')).toBe(0n);
    });

    it('rejects an operation that balances in total but not per currency', async () => {
      await expectLedgerError(
        service.post(
          operation('k1', [
            { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: -100n },
            { account: userAccount('user-1', 'USD'), amount: 100n },
          ]),
        ),
        LedgerErrorCode.UnbalancedOperation,
      );
      expect(await balanceOf(service, 'user-1', 'USD')).toBe(0n);
    });

    it('accepts a conversion-like operation that balances in each currency', async () => {
      await service.post(credit('k1', 'user-1', 'UAH', 10000n));
      await service.post(
        operation('k2', [
          { account: userAccount('user-1', 'UAH'), amount: -4125n },
          { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: 4125n },
          { account: platformAccount(PLATFORM_FUNDING, 'USD'), amount: -100n },
          { account: userAccount('user-1', 'USD'), amount: 100n },
        ]),
      );
      expect(await balanceOf(service, 'user-1', 'UAH')).toBe(5875n);
      expect(await balanceOf(service, 'user-1', 'USD')).toBe(100n);
    });

    it('rejects a negative user balance and applies none of the entries', async () => {
      await service.post(credit('k1', 'user-1', 'UAH', 1000n));
      await expectLedgerError(
        service.post(
          operation('k2', [
            { account: userAccount('user-1', 'UAH'), amount: -1001n },
            { account: userAccount('user-2', 'UAH'), amount: 1001n },
          ]),
        ),
        LedgerErrorCode.InsufficientFunds,
      );
      expect(await balanceOf(service, 'user-1', 'UAH')).toBe(1000n);
      expect(await balanceOf(service, 'user-2', 'UAH')).toBe(0n);
    });

    it('replays the same key and content: same operation, applied once', async () => {
      const first = await service.post(credit('k1', 'user-1', 'UAH', 500n));
      const second = await service.post(credit('k1', 'user-1', 'UAH', 500n));
      expect(second.replayed).toBe(true);
      expect(second.operation.id).toBe(first.operation.id);
      expect(await balanceOf(service, 'user-1', 'UAH')).toBe(500n);
    });

    it('rejects the same key with a different amount as a conflict', async () => {
      await service.post(credit('k1', 'user-1', 'UAH', 500n));
      await expectLedgerError(
        service.post(credit('k1', 'user-1', 'UAH', 501n)),
        LedgerErrorCode.IdempotencyConflict,
      );
      expect(await balanceOf(service, 'user-1', 'UAH')).toBe(500n);
    });

    it('treats the same entries in another order as a replay, not a conflict', async () => {
      const first = await service.post(credit('k1', 'user-1', 'UAH', 500n));
      const reordered = operation('k1', [...credit('k1', 'user-1', 'UAH', 500n).entries].reverse());
      const second = await service.post(reordered);
      expect(second.replayed).toBe(true);
      expect(second.operation.id).toBe(first.operation.id);
    });

    it('throws a plain Error for caller mistakes', async () => {
      const mistakes: PostOperation[] = [
        operation('k1', []),
        operation('k2', [
          { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: 0n },
          { account: userAccount('user-1', 'UAH'), amount: 0n },
        ]),
        operation('k3', [
          { account: platformAccount('unknown', 'UAH'), amount: -100n },
          { account: userAccount('user-1', 'UAH'), amount: 100n },
        ]),
      ];
      for (const mistake of mistakes) {
        const error: unknown = await service.post(mistake).then(
          () => undefined,
          (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(GraphQLError);
      }
    });

    it('reports business errors as GraphQLError with the ledger code', async () => {
      const unbalanced = service.post(
        operation('k1', [
          { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: -1n },
          { account: userAccount('user-1', 'UAH'), amount: 2n },
        ]),
      );
      await expectLedgerError(unbalanced, 'UNBALANCED_OPERATION');
      await expectLedgerError(
        service.post(
          operation('k2', [
            { account: userAccount('user-1', 'UAH'), amount: -1n },
            { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: 1n },
          ]),
        ),
        'INSUFFICIENT_FUNDS',
      );
      await service.post(credit('k3', 'user-1', 'UAH', 1n));
      await expectLedgerError(
        service.post(credit('k3', 'user-1', 'UAH', 2n)),
        'IDEMPOTENCY_CONFLICT',
      );
    });
  });
}

describeLedgerContract('FakeLedgerService', () => new FakeLedgerService());

describe('LedgerModule', () => {
  it('binds FakeLedgerService as LedgerService', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [LedgerModule] }).compile();
    expect(moduleRef.get(LedgerService)).toBeInstanceOf(FakeLedgerService);
  });
});
