import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';
import type { Knex } from 'knex';
import type { PinoLogger } from 'nestjs-pino';
import { CURRENCIES, type Currency } from '../src/common/currency.js';
import { createKnex } from '../src/database/database.module.js';
import type { EventPublisher } from '../src/events/event-bus.js';
import { LedgerErrorCode } from '../src/ledger/ledger-errors.js';
import { KnexLedgerService } from '../src/ledger/knex-ledger.service.js';
import { LedgerRepository } from '../src/ledger/ledger.repository.js';
import {
  PLATFORM_FUNDING,
  platformAccount,
  userAccount,
  type PostResult,
} from '../src/ledger/ledger.types.js';
import { MAX_AMOUNT } from '../src/ledger/money.js';
import {
  balanceOf,
  credit,
  describeLedgerContract,
  expectPlainError,
  operation,
} from './ledger-contract.js';

/**
 * `KnexLedgerService` against real MySQL (`npm run infra:up && npm run migrate`). Everything the test
 * creates is removed afterwards and the funding balances are put back, so the local database is left
 * as it was.
 */
describe('KnexLedgerService (e2e, real MySQL)', () => {
  let db: Knex;
  let service: KnexLedgerService;
  const logger = { info: jest.fn(), warn: jest.fn() };
  const userIds: string[] = [];
  const platformCodes: string[] = [];

  const newUserId = (): string => {
    const id = randomUUID();
    userIds.push(id);
    return id;
  };

  /** A platform account of its own, so a test can move huge amounts without depending on `funding`. */
  const newPlatformAccount = async (currency: Currency): Promise<string> => {
    const code = `test-${randomUUID().slice(0, 8)}`;
    platformCodes.push(code);
    await db('accounts').insert({
      id: randomUUID(),
      type: 'platform',
      code,
      currency,
      created_at: new Date(),
    });
    return code;
  };

  /**
   * Every retry after a deadlock logs a warning, so a concurrency test that expects none cannot pass on a
   * deadlock the retry silently absorbed.
   */
  const expectNoRetries = (): void => {
    expect(logger.warn).not.toHaveBeenCalled();
  };

  /** Creates the user's account up front, so the race in a test does not include first-time account creation. */
  const openAccount = async (userId: string, currency: Currency): Promise<void> => {
    await service.post(credit(randomUUID(), userId, currency, 1n));
  };

  const fundingBalance = async (currency: Currency): Promise<bigint> => {
    const row = await db('accounts')
      .where({ type: 'platform', code: PLATFORM_FUNDING, currency })
      .first<{ balance: string }>(db.raw('CAST(balance AS CHAR) AS balance'));
    return BigInt(row.balance);
  };

  const count = async (table: string, query: (q: Knex.QueryBuilder) => void): Promise<number> => {
    const q = db(table);
    query(q);
    const [row] = await q.count<{ total: number | string }[]>({ total: '*' });
    return Number(row.total);
  };

  const operationsWithKeys = (keys: string[]): Promise<number> =>
    count('operations', (q) => void q.whereIn('idempotency_key', keys));

  const entriesOfKeys = (keys: string[]): Promise<number> =>
    count(
      'entries',
      (q) =>
        void q
          .join('operations', 'operations.id', 'entries.operation_id')
          .whereIn('operations.idempotency_key', keys),
    );

  const ledgerCode = (reason: unknown): unknown =>
    reason instanceof GraphQLError ? reason.extensions['code'] : reason;

  const fulfilled = (results: PromiseSettledResult<PostResult>[]): PostResult[] =>
    results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));

  const rejections = (results: PromiseSettledResult<PostResult>[]): unknown[] =>
    results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));

  /** Undoes everything the tests wrote: entries, operations, test accounts, and the funding balances. */
  const cleanUp = async (): Promise<void> => {
    await db.transaction(async (trx) => {
      const ownIds = (await trx('accounts')
        .where((q) => {
          void q.whereIn('user_id', userIds).orWhere((p) => {
            void p.where('type', 'platform').whereIn('code', platformCodes);
          });
        })
        .pluck('id')) as string[];
      const operationIds = (await trx('entries')
        .whereIn('account_id', ownIds)
        .distinct()
        .pluck('operation_id')) as string[];

      // Every operation of a test moves money between the test's own accounts and `funding`.
      const foreign = await trx('entries')
        .whereIn('operation_id', operationIds)
        .whereNotIn('account_id', ownIds)
        .groupBy('account_id')
        .select<{ account_id: string; total: string }[]>(
          'account_id',
          trx.raw('CAST(SUM(amount) AS CHAR) AS total'),
        );
      for (const { account_id, total } of foreign) {
        await trx('accounts')
          .where({ id: account_id })
          .update({ balance: trx.raw('balance - ?', [total]) });
      }

      await trx('entries').whereIn('operation_id', operationIds).delete();
      await trx('operations').whereIn('id', operationIds).delete();
      await trx('accounts').whereIn('id', ownIds).delete();
    });
  };

  beforeAll(() => {
    db = createKnex(process.env.DATABASE_URL!);
    service = new KnexLedgerService(
      new LedgerRepository(db),
      { publish: () => Promise.resolve(null) } as unknown as EventPublisher,
      logger as unknown as PinoLogger,
    );
  });

  beforeEach(() => {
    logger.info.mockClear();
    logger.warn.mockClear();
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await db.destroy();
    }
  });

  describeLedgerContract({ name: 'KnexLedgerService', createService: () => service, newUserId });

  describe('concurrency', () => {
    it('keeps the exact balance after 50 parallel credits to one user, with no deadlock retry', async () => {
      const userId = newUserId();
      await openAccount(userId, 'UAH');
      const keys = Array.from({ length: 50 }, () => randomUUID());
      const fundingBefore = await fundingBalance('UAH');

      await Promise.all(keys.map((key) => service.post(credit(key, userId, 'UAH', 1000n))));

      expect(await balanceOf(service, userId, 'UAH')).toBe(50001n);
      expect(await fundingBalance('UAH')).toBe(fundingBefore - 50000n);
      expect(await operationsWithKeys(keys)).toBe(50);
      expect(await entriesOfKeys(keys)).toBe(100);
      expectNoRetries();
    });

    it('reads exact balances while postings change the same accounts, with no deadlock retry', async () => {
      const userId = newUserId();
      for (const currency of CURRENCIES) await openAccount(userId, currency);
      const credits = Array.from({ length: 40 }, (_, index) =>
        service.post(credit(randomUUID(), userId, CURRENCIES[index % CURRENCIES.length], 100n)),
      );
      const reads = Array.from({ length: 40 }, () => service.getBalances(userId));

      const [, observed] = await Promise.all([Promise.all(credits), Promise.all(reads)]);

      // Each currency gets 8 credits of 100 on top of the opening 1; a read never sees half a credit.
      for (const balance of observed.flat()) {
        expect((balance.amount - 1n) % 100n).toBe(0n);
        expect(balance.amount).toBeGreaterThanOrEqual(1n);
        expect(balance.amount).toBeLessThanOrEqual(801n);
      }
      expect((await service.getBalances(userId)).map((balance) => balance.amount)).toEqual(
        CURRENCIES.map(() => 801n),
      );
      expectNoRetries();
    });

    it('needs no deadlock retry for transfers in opposite directions', async () => {
      const [userA, userB] = [newUserId(), newUserId()];
      await service.post(credit(randomUUID(), userA, 'UAH', 10000n));
      await service.post(credit(randomUUID(), userB, 'UAH', 10000n));
      const transfer = (from: string, to: string, amount: bigint) =>
        service.post(
          operation(randomUUID(), [
            { account: userAccount(from, 'UAH'), amount: -amount },
            { account: userAccount(to, 'UAH'), amount },
          ]),
        );

      const results = await Promise.allSettled([
        ...Array.from({ length: 20 }, () => transfer(userA, userB, 100n)),
        ...Array.from({ length: 20 }, () => transfer(userB, userA, 50n)),
      ]);

      expect(rejections(results)).toEqual([]);
      expect(await balanceOf(service, userA, 'UAH')).toBe(10000n - 2000n + 1000n);
      expect(await balanceOf(service, userB, 'UAH')).toBe(10000n + 2000n - 1000n);
      expectNoRetries();
    });

    it('applies 10 parallel posts with the same key and content exactly once', async () => {
      const [key, userId] = [randomUUID(), newUserId()];
      await openAccount(userId, 'UAH');

      const results = await Promise.all(
        Array.from({ length: 10 }, () => service.post(credit(key, userId, 'UAH', 300n))),
      );

      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(results.filter((result) => result.replayed)).toHaveLength(9);
      expect(new Set(results.map((result) => result.operation.id)).size).toBe(1);
      expect(await balanceOf(service, userId, 'UAH')).toBe(301n);
      expect(await entriesOfKeys([key])).toBe(2);
      expectNoRetries();
    });

    it('lets one of several parallel posts with the same key win and rejects the other content as a conflict', async () => {
      const [key, userId] = [randomUUID(), newUserId()];
      await openAccount(userId, 'UAH');
      const amounts = [500n, 600n, 500n, 600n, 500n, 600n];

      const results = await Promise.allSettled(
        amounts.map((amount) => service.post(credit(key, userId, 'UAH', amount))),
      );

      const applied = fulfilled(results).filter((result) => !result.replayed);
      expect(applied).toHaveLength(1);
      expect(rejections(results).length).toBeGreaterThan(0);
      for (const reason of rejections(results)) {
        expect(ledgerCode(reason)).toBe(LedgerErrorCode.IdempotencyConflict);
      }
      const winner = applied[0].operation.entries.find((entry) => entry.amount > 0n)?.amount;
      expect(await balanceOf(service, userId, 'UAH')).toBe(1n + (winner ?? 0n));
      expect(await operationsWithKeys([key])).toBe(1);
      expect(await entriesOfKeys([key])).toBe(2);
      expectNoRetries();
    });

    it('leaks nothing but INSUFFICIENT_FUNDS when the same failing key is replayed in parallel', async () => {
      const [key, sender, receiver] = [randomUUID(), newUserId(), newUserId()];
      await openAccount(sender, 'UAH');
      await openAccount(receiver, 'UAH');
      const transfer = () =>
        service.post(
          operation(key, [
            { account: userAccount(sender, 'UAH'), amount: -100n },
            { account: userAccount(receiver, 'UAH'), amount: 100n },
          ]),
        );

      const results = await Promise.allSettled(Array.from({ length: 30 }, transfer));

      expect(fulfilled(results)).toEqual([]);
      expect(rejections(results).map(ledgerCode)).toEqual(
        Array.from({ length: 30 }, () => LedgerErrorCode.InsufficientFunds),
      );
      expect(await operationsWithKeys([key])).toBe(0);
      expect(await entriesOfKeys([key])).toBe(0);
      expect(await balanceOf(service, sender, 'UAH')).toBe(1n);
      expect(await balanceOf(service, receiver, 'UAH')).toBe(1n);
      expectNoRetries();
    });
  });

  describe('rollback and range', () => {
    it('leaves no operation and no entries behind when the funds are insufficient', async () => {
      const [key, sender, receiver] = [randomUUID(), newUserId(), newUserId()];

      const result = await Promise.allSettled([
        service.post(
          operation(key, [
            { account: userAccount(sender, 'UAH'), amount: -1n },
            { account: userAccount(receiver, 'UAH'), amount: 1n },
          ]),
        ),
      ]);

      expect(rejections(result).map(ledgerCode)).toEqual([LedgerErrorCode.InsufficientFunds]);
      expect(await operationsWithKeys([key])).toBe(0);
      expect(await entriesOfKeys([key])).toBe(0);
    });

    it('stores amounts above 2^53 exactly', async () => {
      const [userId, other] = [newUserId(), newUserId()];
      const big = 9_007_199_254_740_993n;

      const first = await service.post(credit(randomUUID(), userId, 'USDT', big));
      const move = await service.post(
        operation(randomUUID(), [
          { account: userAccount(userId, 'USDT'), amount: -big },
          { account: userAccount(other, 'USDT'), amount: big },
        ]),
      );

      expect(first.operation.entries[1].amount).toBe(big);
      expect(move.replayed).toBe(false);
      expect(await balanceOf(service, userId, 'USDT')).toBe(0n);
      expect(await balanceOf(service, other, 'USDT')).toBe(big);
    });

    it('throws a plain Error and writes nothing when a balance would pass MAX_AMOUNT', async () => {
      const userId = newUserId();
      const [first, second] = [await newPlatformAccount('UAH'), await newPlatformAccount('UAH')];
      await service.post(
        operation(randomUUID(), [
          { account: platformAccount(first, 'UAH'), amount: -MAX_AMOUNT },
          { account: userAccount(userId, 'UAH'), amount: MAX_AMOUNT },
        ]),
      );
      const key = randomUUID();

      await expectPlainError(
        service.post(
          operation(key, [
            { account: platformAccount(second, 'UAH'), amount: -1n },
            { account: userAccount(userId, 'UAH'), amount: 1n },
          ]),
        ),
      );

      expect(await balanceOf(service, userId, 'UAH')).toBe(MAX_AMOUNT);
      expect(await operationsWithKeys([key])).toBe(0);
      expect(await entriesOfKeys([key])).toBe(0);
    });

    it('throws a plain Error and writes nothing when a balance would pass -MAX_AMOUNT', async () => {
      const userId = newUserId();
      const [first, second] = [await newPlatformAccount('UAH'), await newPlatformAccount('UAH')];
      await service.post(
        operation(randomUUID(), [
          { account: platformAccount(first, 'UAH'), amount: -MAX_AMOUNT },
          { account: userAccount(userId, 'UAH'), amount: MAX_AMOUNT },
        ]),
      );
      const key = randomUUID();

      await expectPlainError(
        service.post(
          operation(key, [
            { account: platformAccount(first, 'UAH'), amount: -1n },
            { account: platformAccount(second, 'UAH'), amount: 1n },
          ]),
        ),
      );

      expect(await balanceOf(service, userId, 'UAH')).toBe(MAX_AMOUNT);
      expect(await operationsWithKeys([key])).toBe(0);
      expect(await entriesOfKeys([key])).toBe(0);
    });
  });
});
