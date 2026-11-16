import { Test } from '@nestjs/testing';
import { GraphQLError } from 'graphql';
import { CURRENCIES, type Currency } from '../common/currency.js';
import { ConfigModule } from '../config/config.module.js';
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

async function versionOf(
  service: LedgerService,
  userId: string,
  currency: Currency,
): Promise<number> {
  const balances = await service.getBalances(userId);
  return balances.find((balance) => balance.currency === currency)?.version ?? -1;
}

async function expectLedgerError(promise: Promise<unknown>, code: LedgerErrorCode): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GraphQLError);
  expect((error as GraphQLError).extensions['code']).toBe(code);
}

async function expectPlainError(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(GraphQLError);
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
      expect(balances).toEqual(
        CURRENCIES.map((currency) => ({ currency, amount: 0n, version: 0 })),
      );
    });

    it('credits a user from the platform funding account, which may go negative', async () => {
      const { replayed } = await service.post(credit('k1', 'user-1', 'UAH', 100000n));
      expect(replayed).toBe(false);
      expect(await balanceOf(service, 'user-1', 'UAH')).toBe(100000n);
      expect(await balanceOf(service, 'user-1', 'USD')).toBe(0n);
    });

    it('throws a plain Error for an operation that does not sum to zero and changes nothing', async () => {
      await expectPlainError(
        service.post(
          operation('k1', [
            { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: -100n },
            { account: userAccount('user-1', 'UAH'), amount: 90n },
          ]),
        ),
      );
      expect(await balanceOf(service, 'user-1', 'UAH')).toBe(0n);
    });

    it('throws a plain Error for an operation that balances in total but not per currency', async () => {
      await expectPlainError(
        service.post(
          operation('k1', [
            { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: -100n },
            { account: userAccount('user-1', 'USD'), amount: 100n },
          ]),
        ),
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

    it('replays after the funds moved: the original operation, nothing changes', async () => {
      await service.post(credit('k1', 'user-a', 'UAH', 500n));
      const move = operation('k2', [
        { account: userAccount('user-a', 'UAH'), amount: -500n },
        { account: userAccount('user-b', 'UAH'), amount: 500n },
      ]);
      const first = await service.post(move);
      const second = await service.post(move);
      expect(second.replayed).toBe(true);
      expect(second.operation.id).toBe(first.operation.id);
      expect(await balanceOf(service, 'user-a', 'UAH')).toBe(0n);
      expect(await balanceOf(service, 'user-b', 'UAH')).toBe(500n);
    });

    it('checks a user account that appears twice in one operation on its net change', async () => {
      const funding = platformAccount(PLATFORM_FUNDING, 'UAH');
      await service.post(credit('k1', 'user-a', 'UAH', 100n));
      await service.post(credit('k2', 'user-b', 'UAH', 100n));

      await service.post(
        operation('k3', [
          { account: userAccount('user-a', 'UAH'), amount: -150n },
          { account: userAccount('user-a', 'UAH'), amount: 100n },
          { account: funding, amount: 50n },
        ]),
      );
      expect(await balanceOf(service, 'user-a', 'UAH')).toBe(50n);

      await expectLedgerError(
        service.post(
          operation('k4', [
            { account: userAccount('user-b', 'UAH'), amount: -150n },
            { account: userAccount('user-b', 'UAH'), amount: 40n },
            { account: funding, amount: 110n },
          ]),
        ),
        LedgerErrorCode.InsufficientFunds,
      );
      expect(await balanceOf(service, 'user-b', 'UAH')).toBe(100n);
    });

    it('does not share objects with callers: changing what was passed or returned changes no replay', async () => {
      const posting = credit('k1', 'user-1', 'UAH', 500n);
      const first = await service.post(posting);
      posting.entries[1].amount = 1n;
      first.operation.entries[1].amount = 2n;

      const second = await service.post(credit('k1', 'user-1', 'UAH', 500n));
      expect(second.operation.entries).toEqual(credit('k1', 'user-1', 'UAH', 500n).entries);
      second.operation.entries[1].amount = 3n;

      const third = await service.post(credit('k1', 'user-1', 'UAH', 500n));
      expect(third.operation.entries).toEqual(credit('k1', 'user-1', 'UAH', 500n).entries);
    });

    it('bumps the version of a credited currency by 1 per posting and leaves the others at 0', async () => {
      await service.post(credit('k1', 'user-1', 'UAH', 100n));
      expect(await versionOf(service, 'user-1', 'UAH')).toBe(1);
      expect(await versionOf(service, 'user-1', 'USD')).toBe(0);

      await service.post(credit('k2', 'user-1', 'UAH', 100n));
      expect(await versionOf(service, 'user-1', 'UAH')).toBe(2);
      expect(await versionOf(service, 'user-1', 'USD')).toBe(0);
    });

    it('bumps the version once for a user account named twice in one operation', async () => {
      await service.post(credit('k1', 'user-a', 'UAH', 100n));
      await service.post(
        operation('k2', [
          { account: userAccount('user-a', 'UAH'), amount: -150n },
          { account: userAccount('user-a', 'UAH'), amount: 100n },
          { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: 50n },
        ]),
      );
      expect(await versionOf(service, 'user-a', 'UAH')).toBe(2);
    });

    it('bumps the versions of both users in a transfer', async () => {
      await service.post(credit('k1', 'user-a', 'UAH', 500n));
      await service.post(
        operation('k2', [
          { account: userAccount('user-a', 'UAH'), amount: -200n },
          { account: userAccount('user-b', 'UAH'), amount: 200n },
        ]),
      );
      expect(await versionOf(service, 'user-a', 'UAH')).toBe(2);
      expect(await versionOf(service, 'user-b', 'UAH')).toBe(1);
    });

    it('does not bump the version on a replay', async () => {
      await service.post(credit('k1', 'user-1', 'UAH', 500n));
      await service.post(credit('k1', 'user-1', 'UAH', 500n));
      expect(await versionOf(service, 'user-1', 'UAH')).toBe(1);
    });

    it('does not bump the version of any account of a rejected operation', async () => {
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
      expect(await versionOf(service, 'user-1', 'UAH')).toBe(1);
      expect(await versionOf(service, 'user-2', 'UAH')).toBe(0);
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
        await expectPlainError(service.post(mistake));
      }
    });

    it('reports business errors as GraphQLError with the ledger code', async () => {
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
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, LedgerModule],
    }).compile();
    expect(moduleRef.get(LedgerService)).toBeInstanceOf(FakeLedgerService);
  });
});
