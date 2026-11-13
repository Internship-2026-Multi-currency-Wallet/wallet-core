import { randomUUID } from 'node:crypto';
import { GraphQLError } from 'graphql';
import { CURRENCIES, type Currency } from '../src/common/currency.js';
import { LedgerErrorCode } from '../src/ledger/ledger-errors.js';
import type { LedgerService } from '../src/ledger/ledger.service.js';
import {
  PLATFORM_FUNDING,
  accountKey,
  platformAccount,
  userAccount,
  type EntryInput,
  type OperationType,
  type PostOperation,
} from '../src/ledger/ledger.types.js';
import { MAX_AMOUNT } from '../src/ledger/money.js';

const TYPE: OperationType = 'test_credit';

export function operation(idempotencyKey: string, entries: EntryInput[]): PostOperation {
  return { type: TYPE, idempotencyKey, entries };
}

export function credit(
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

export async function balanceOf(
  service: LedgerService,
  userId: string,
  currency: Currency,
): Promise<bigint> {
  const balances = await service.getBalances(userId);
  return balances.find((balance) => balance.currency === currency)?.amount ?? -1n;
}

export async function versionOf(
  service: LedgerService,
  userId: string,
  currency: Currency,
): Promise<number> {
  const balances = await service.getBalances(userId);
  return balances.find((balance) => balance.currency === currency)?.version ?? -1;
}

export async function expectLedgerError(
  promise: Promise<unknown>,
  code: LedgerErrorCode,
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(GraphQLError);
  expect((error as GraphQLError).extensions['code']).toBe(code);
}

export async function expectPlainError(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(GraphQLError);
}

/** The order of entries is not significant (the fingerprint ignores it), so compare them sorted. */
function sortedEntries(entries: readonly EntryInput[]): [string, string][] {
  return entries
    .map((entry): [string, string] => [accountKey(entry.account), entry.amount.toString()])
    .sort(([keyA, amountA], [keyB, amountB]) =>
      keyA === keyB ? amountA.localeCompare(amountB) : keyA.localeCompare(keyB),
    );
}

export interface LedgerContractSetup {
  name: string;
  createService: () => LedgerService;
  /** A user nobody has used yet: a shared database would clash on a fixed id. */
  newUserId: () => string;
}

/**
 * The behaviour every `LedgerService` must have. It only uses the public API, so the fake (unit) and the
 * Knex implementation (e2e, real MySQL) run the same cases. Keys are random for the same reason as user ids.
 */
export function describeLedgerContract({
  name,
  createService,
  newUserId,
}: LedgerContractSetup): void {
  describe(`${name} (LedgerService contract)`, () => {
    let service: LedgerService;

    beforeEach(() => {
      service = createService();
    });

    it('gives a new user zero balances in all currencies, in CURRENCIES order', async () => {
      const balances = await service.getBalances(newUserId());
      expect(balances).toEqual(
        CURRENCIES.map((currency) => ({ currency, amount: 0n, version: 0 })),
      );
    });

    it('credits a user from the platform funding account, which may go negative', async () => {
      const userId = newUserId();
      const { replayed } = await service.post(credit(randomUUID(), userId, 'UAH', 100000n));
      expect(replayed).toBe(false);
      expect(await balanceOf(service, userId, 'UAH')).toBe(100000n);
      expect(await balanceOf(service, userId, 'USD')).toBe(0n);
    });

    it('keeps the balances between calls', async () => {
      const userId = newUserId();
      await service.post(credit(randomUUID(), userId, 'UAH', 700n));
      await service.post(credit(randomUUID(), userId, 'USDT', 5000000n));

      const first = await service.getBalances(userId);
      const second = await service.getBalances(userId);

      expect(second).toEqual(first);
      expect(first.map((balance) => balance.amount)).toEqual([700n, 0n, 0n, 0n, 5000000n]);
    });

    it('throws a plain Error for an operation that does not sum to zero and changes nothing', async () => {
      const userId = newUserId();
      await expectPlainError(
        service.post(
          operation(randomUUID(), [
            { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: -100n },
            { account: userAccount(userId, 'UAH'), amount: 90n },
          ]),
        ),
      );
      expect(await balanceOf(service, userId, 'UAH')).toBe(0n);
    });

    it('throws a plain Error for an operation that balances in total but not per currency', async () => {
      const userId = newUserId();
      await expectPlainError(
        service.post(
          operation(randomUUID(), [
            { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: -100n },
            { account: userAccount(userId, 'USD'), amount: 100n },
          ]),
        ),
      );
      expect(await balanceOf(service, userId, 'USD')).toBe(0n);
    });

    it('accepts a conversion-like operation that balances in each currency', async () => {
      const userId = newUserId();
      await service.post(credit(randomUUID(), userId, 'UAH', 10000n));
      await service.post(
        operation(randomUUID(), [
          { account: userAccount(userId, 'UAH'), amount: -4125n },
          { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: 4125n },
          { account: platformAccount(PLATFORM_FUNDING, 'USD'), amount: -100n },
          { account: userAccount(userId, 'USD'), amount: 100n },
        ]),
      );
      expect(await balanceOf(service, userId, 'UAH')).toBe(5875n);
      expect(await balanceOf(service, userId, 'USD')).toBe(100n);
    });

    it('rejects a negative user balance and applies none of the entries', async () => {
      const [sender, receiver] = [newUserId(), newUserId()];
      await service.post(credit(randomUUID(), sender, 'UAH', 1000n));
      await expectLedgerError(
        service.post(
          operation(randomUUID(), [
            { account: userAccount(sender, 'UAH'), amount: -1001n },
            { account: userAccount(receiver, 'UAH'), amount: 1001n },
          ]),
        ),
        LedgerErrorCode.InsufficientFunds,
      );
      expect(await balanceOf(service, sender, 'UAH')).toBe(1000n);
      expect(await balanceOf(service, receiver, 'UAH')).toBe(0n);
    });

    it('replays the same key and content: same operation, applied once', async () => {
      const [key, userId] = [randomUUID(), newUserId()];
      const first = await service.post(credit(key, userId, 'UAH', 500n));
      const second = await service.post(credit(key, userId, 'UAH', 500n));
      expect(second.replayed).toBe(true);
      expect(second.operation.id).toBe(first.operation.id);
      expect(await balanceOf(service, userId, 'UAH')).toBe(500n);
    });

    it('replays the same entries and the same timestamp', async () => {
      const [key, userId] = [randomUUID(), newUserId()];
      const first = await service.post(credit(key, userId, 'UAH', 500n));
      const second = await service.post(credit(key, userId, 'UAH', 500n));
      expect(second.operation.type).toBe(first.operation.type);
      expect(second.operation.idempotencyKey).toBe(key);
      expect(second.operation.createdAt).toEqual(first.operation.createdAt);
      expect(sortedEntries(second.operation.entries)).toEqual(
        sortedEntries(first.operation.entries),
      );
    });

    it('rejects the same key with a different amount as a conflict', async () => {
      const [key, userId] = [randomUUID(), newUserId()];
      await service.post(credit(key, userId, 'UAH', 500n));
      await expectLedgerError(
        service.post(credit(key, userId, 'UAH', 501n)),
        LedgerErrorCode.IdempotencyConflict,
      );
      expect(await balanceOf(service, userId, 'UAH')).toBe(500n);
    });

    it('treats the same entries in another order as a replay, not a conflict', async () => {
      const [key, userId] = [randomUUID(), newUserId()];
      const first = await service.post(credit(key, userId, 'UAH', 500n));
      const reordered = operation(key, [...credit(key, userId, 'UAH', 500n).entries].reverse());
      const second = await service.post(reordered);
      expect(second.replayed).toBe(true);
      expect(second.operation.id).toBe(first.operation.id);
    });

    it('replays after the funds moved: the original operation, nothing changes', async () => {
      const [userA, userB] = [newUserId(), newUserId()];
      await service.post(credit(randomUUID(), userA, 'UAH', 500n));
      const move = operation(randomUUID(), [
        { account: userAccount(userA, 'UAH'), amount: -500n },
        { account: userAccount(userB, 'UAH'), amount: 500n },
      ]);
      const first = await service.post(move);
      const second = await service.post(move);
      expect(second.replayed).toBe(true);
      expect(second.operation.id).toBe(first.operation.id);
      expect(await balanceOf(service, userA, 'UAH')).toBe(0n);
      expect(await balanceOf(service, userB, 'UAH')).toBe(500n);
    });

    it('checks a user account that appears twice in one operation on its net change', async () => {
      const [userA, userB] = [newUserId(), newUserId()];
      const funding = platformAccount(PLATFORM_FUNDING, 'UAH');
      await service.post(credit(randomUUID(), userA, 'UAH', 100n));
      await service.post(credit(randomUUID(), userB, 'UAH', 100n));

      await service.post(
        operation(randomUUID(), [
          { account: userAccount(userA, 'UAH'), amount: -150n },
          { account: userAccount(userA, 'UAH'), amount: 100n },
          { account: funding, amount: 50n },
        ]),
      );
      expect(await balanceOf(service, userA, 'UAH')).toBe(50n);

      await expectLedgerError(
        service.post(
          operation(randomUUID(), [
            { account: userAccount(userB, 'UAH'), amount: -150n },
            { account: userAccount(userB, 'UAH'), amount: 40n },
            { account: funding, amount: 110n },
          ]),
        ),
        LedgerErrorCode.InsufficientFunds,
      );
      expect(await balanceOf(service, userB, 'UAH')).toBe(100n);
    });

    it('does not share objects with callers: changing what was passed or returned changes no replay', async () => {
      const [key, userId] = [randomUUID(), newUserId()];
      const posting = credit(key, userId, 'UAH', 500n);
      const first = await service.post(posting);
      posting.entries[1].amount = 1n;
      first.operation.entries[1].amount = 2n;

      const second = await service.post(credit(key, userId, 'UAH', 500n));
      expect(sortedEntries(second.operation.entries)).toEqual(
        sortedEntries(credit(key, userId, 'UAH', 500n).entries),
      );
      second.operation.entries[1].amount = 3n;

      const third = await service.post(credit(key, userId, 'UAH', 500n));
      expect(sortedEntries(third.operation.entries)).toEqual(
        sortedEntries(credit(key, userId, 'UAH', 500n).entries),
      );
    });

    it('posts the operation as it was when post() was called, even if the caller changes it before it settles', async () => {
      const userId = newUserId();
      const posting = credit(randomUUID(), userId, 'UAH', 500n);
      const pending = service.post(posting);
      posting.entries[1].amount = 900n;

      const { operation: posted } = await pending;

      expect(sortedEntries(posted.entries)).toEqual(
        sortedEntries(credit(posting.idempotencyKey, userId, 'UAH', 500n).entries),
      );
      await expect(balanceOf(service, userId, 'UAH')).resolves.toBe(500n);
    });

    it('bumps the version of a credited currency by 1 per posting and leaves the others at 0', async () => {
      const userId = newUserId();
      await service.post(credit(randomUUID(), userId, 'UAH', 100n));
      expect(await versionOf(service, userId, 'UAH')).toBe(1);
      expect(await versionOf(service, userId, 'USD')).toBe(0);

      await service.post(credit(randomUUID(), userId, 'UAH', 100n));
      expect(await versionOf(service, userId, 'UAH')).toBe(2);
      expect(await versionOf(service, userId, 'USD')).toBe(0);
    });

    it('bumps the version once for a user account named twice in one operation', async () => {
      const userId = newUserId();
      await service.post(credit(randomUUID(), userId, 'UAH', 100n));
      await service.post(
        operation(randomUUID(), [
          { account: userAccount(userId, 'UAH'), amount: -150n },
          { account: userAccount(userId, 'UAH'), amount: 100n },
          { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: 50n },
        ]),
      );
      expect(await versionOf(service, userId, 'UAH')).toBe(2);
    });

    it('bumps the versions of both users in a transfer', async () => {
      const [userA, userB] = [newUserId(), newUserId()];
      await service.post(credit(randomUUID(), userA, 'UAH', 500n));
      await service.post(
        operation(randomUUID(), [
          { account: userAccount(userA, 'UAH'), amount: -200n },
          { account: userAccount(userB, 'UAH'), amount: 200n },
        ]),
      );
      expect(await versionOf(service, userA, 'UAH')).toBe(2);
      expect(await versionOf(service, userB, 'UAH')).toBe(1);
    });

    it('does not bump the version on a replay', async () => {
      const [key, userId] = [randomUUID(), newUserId()];
      await service.post(credit(key, userId, 'UAH', 500n));
      await service.post(credit(key, userId, 'UAH', 500n));
      expect(await versionOf(service, userId, 'UAH')).toBe(1);
    });

    it('does not bump the version of any account of a rejected operation', async () => {
      const [sender, receiver] = [newUserId(), newUserId()];
      await service.post(credit(randomUUID(), sender, 'UAH', 1000n));
      await expectLedgerError(
        service.post(
          operation(randomUUID(), [
            { account: userAccount(sender, 'UAH'), amount: -1001n },
            { account: userAccount(receiver, 'UAH'), amount: 1001n },
          ]),
        ),
        LedgerErrorCode.InsufficientFunds,
      );
      expect(await versionOf(service, sender, 'UAH')).toBe(1);
      expect(await versionOf(service, receiver, 'UAH')).toBe(0);
    });

    it('throws a plain Error for caller mistakes', async () => {
      const userId = newUserId();
      const mistakes: PostOperation[] = [
        operation(randomUUID(), []),
        operation(randomUUID(), [
          { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: 0n },
          { account: userAccount(userId, 'UAH'), amount: 0n },
        ]),
        operation(randomUUID(), [
          { account: platformAccount('unknown', 'UAH'), amount: -100n },
          { account: userAccount(userId, 'UAH'), amount: 100n },
        ]),
        operation(randomUUID(), [
          { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: -(MAX_AMOUNT + 1n) },
          { account: userAccount(userId, 'UAH'), amount: MAX_AMOUNT + 1n },
        ]),
      ];
      for (const mistake of mistakes) {
        await expectPlainError(service.post(mistake));
      }
    });

    it('reports business errors as GraphQLError with the ledger code', async () => {
      const [key, userId] = [randomUUID(), newUserId()];
      await expectLedgerError(
        service.post(
          operation(randomUUID(), [
            { account: userAccount(userId, 'UAH'), amount: -1n },
            { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: 1n },
          ]),
        ),
        'INSUFFICIENT_FUNDS',
      );
      await service.post(credit(key, userId, 'UAH', 1n));
      await expectLedgerError(service.post(credit(key, userId, 'UAH', 2n)), 'IDEMPOTENCY_CONFLICT');
    });
  });
}
