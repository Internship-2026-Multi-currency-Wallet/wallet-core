import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Redis } from 'ioredis';
import type { Knex } from 'knex';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../src/config/app-config.js';
import { createKnex } from '../src/database/database.module.js';
import type { BalanceChangedEvent } from '../src/events/catalog.js';
import { EventPublisher, EventSubscriber, type Unsubscribe } from '../src/events/event-bus.js';
import { LedgerErrorCode } from '../src/ledger/ledger-errors.js';
import { KnexLedgerService } from '../src/ledger/knex-ledger.service.js';
import { LedgerRepository } from '../src/ledger/ledger.repository.js';
import { PLATFORM_FUNDING, platformAccount, userAccount } from '../src/ledger/ledger.types.js';
import { credit, expectLedgerError, operation } from './ledger-contract.js';

/**
 * `balance.changed` after real postings (`npm run infra:up && npm run migrate`): real MySQL, real Redis
 * pub/sub. Everything the test creates is removed afterwards and the funding balances are put back.
 */
describe('balance.changed (e2e, real MySQL and Redis)', () => {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const prefix = AppConfig.fromEnv(process.env).appEnv;
  const userIds: string[] = [];
  const received: BalanceChangedEvent[] = [];
  let db: Knex;
  let redis: Redis;
  let subscriber: EventSubscriber;
  let unsubscribe: Unsubscribe;
  let service: KnexLedgerService;

  const newUserId = (): string => {
    const id = randomUUID();
    userIds.push(id);
    return id;
  };

  const eventsOf = (userId: string): BalanceChangedEvent[] =>
    received.filter((event) => event.userId === userId);

  const waitFor = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for a balance.changed event');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  /**
   * Proves a "nothing was published" claim without a blind sleep: one publisher connection delivers in
   * order, so once the event of a later posting has arrived, an earlier one would have arrived too.
   */
  const settle = async (): Promise<void> => {
    const sentinel = newUserId();
    await service.post(credit(randomUUID(), sentinel, 'UAH', 1n));
    await waitFor(() => eventsOf(sentinel).length === 1);
  };

  const cleanUp = async (): Promise<void> => {
    await db.transaction(async (trx) => {
      const ownIds = (await trx('accounts').whereIn('user_id', userIds).pluck('id')) as string[];
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

  beforeAll(async () => {
    db = createKnex(process.env.DATABASE_URL!);
    redis = new Redis(redisUrl);
    subscriber = new EventSubscriber(new Redis(redisUrl), prefix);
    unsubscribe = await subscriber.subscribe('balance.changed', (event) => {
      received.push(event);
    });
    const logger = { info: jest.fn(), warn: jest.fn() };
    service = new KnexLedgerService(
      new LedgerRepository(db),
      new EventPublisher(redis, prefix),
      logger as unknown as PinoLogger,
    );
  });

  afterAll(async () => {
    try {
      await cleanUp();
    } finally {
      await unsubscribe();
      await subscriber.close();
      await redis.quit();
      await db.destroy();
    }
  });

  it('delivers the full new balance of the user after a credit', async () => {
    const userId = newUserId();

    const first = await service.post(credit(randomUUID(), userId, 'UAH', 1000n));
    await waitFor(() => eventsOf(userId).length === 1);
    const second = await service.post(credit(randomUUID(), userId, 'UAH', 500n));
    await waitFor(() => eventsOf(userId).length === 2);

    expect(eventsOf(userId)).toEqual([
      {
        v: 1,
        operationId: first.operation.id,
        userId,
        balances: [{ currency: 'UAH', amount: '1000' }],
        occurredAt: first.operation.createdAt.toISOString(),
      },
      {
        v: 1,
        operationId: second.operation.id,
        userId,
        balances: [{ currency: 'UAH', amount: '1500' }],
        occurredAt: second.operation.createdAt.toISOString(),
      },
    ]);
  });

  it('delivers one event for each side of a transfer and none for the platform', async () => {
    const sender = newUserId();
    const receiver = newUserId();
    await service.post(credit(randomUUID(), sender, 'UAH', 1000n));
    await waitFor(() => eventsOf(sender).length === 1);

    const transfer = await service.post(
      operation(randomUUID(), [
        { account: userAccount(sender, 'UAH'), amount: -300n },
        { account: userAccount(receiver, 'UAH'), amount: 300n },
      ]),
    );
    await settle();

    expect(eventsOf(sender)).toHaveLength(2);
    expect(eventsOf(sender)[1]).toMatchObject({
      operationId: transfer.operation.id,
      balances: [{ currency: 'UAH', amount: '700' }],
    });
    expect(eventsOf(receiver)).toEqual([
      expect.objectContaining({
        operationId: transfer.operation.id,
        balances: [{ currency: 'UAH', amount: '300' }],
      }),
    ]);
    expect(received.every((event) => userIds.includes(event.userId))).toBe(true);
  });

  it('delivers one event listing both currencies of a user changed by one operation', async () => {
    const userId = newUserId();

    await service.post(
      operation(randomUUID(), [
        { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: -10n },
        { account: userAccount(userId, 'UAH'), amount: 10n },
        { account: platformAccount(PLATFORM_FUNDING, 'USD'), amount: -20n },
        { account: userAccount(userId, 'USD'), amount: 20n },
      ]),
    );
    await settle();

    expect(eventsOf(userId)).toEqual([
      expect.objectContaining({
        balances: [
          { currency: 'UAH', amount: '10' },
          { currency: 'USD', amount: '20' },
        ],
      }),
    ]);
  });

  it('delivers nothing for a rejected posting', async () => {
    const userId = newUserId();

    await expectLedgerError(
      service.post(
        operation(randomUUID(), [
          { account: userAccount(userId, 'UAH'), amount: -100n },
          { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: 100n },
        ]),
      ),
      LedgerErrorCode.InsufficientFunds,
    );
    await settle();

    expect(eventsOf(userId)).toEqual([]);
  });

  it('delivers nothing for a replay', async () => {
    const userId = newUserId();
    const key = randomUUID();
    await service.post(credit(key, userId, 'UAH', 100n));
    await waitFor(() => eventsOf(userId).length === 1);

    const replay = await service.post(credit(key, userId, 'UAH', 100n));
    await settle();

    expect(replay.replayed).toBe(true);
    expect(eventsOf(userId)).toHaveLength(1);
  });
});
