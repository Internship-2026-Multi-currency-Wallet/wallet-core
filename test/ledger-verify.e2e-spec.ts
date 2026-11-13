import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import type { Knex } from 'knex';
import type { PinoLogger } from 'nestjs-pino';
import type { Currency } from '../src/common/currency.js';
import { createKnex } from '../src/database/database.module.js';
import type { EventPublisher } from '../src/events/event-bus.js';
import { KnexLedgerService } from '../src/ledger/knex-ledger.service.js';
import { LedgerRepository } from '../src/ledger/ledger.repository.js';
import {
  PLATFORM_FUNDING,
  platformAccount,
  userAccount,
  type PostOperation,
} from '../src/ledger/ledger.types.js';
import { verifyLedger, type LedgerVerifyReport } from '../src/ledger/ledger-verifier.js';
import { credit, operation, removeLedgerRows } from './ledger-contract.js';

/**
 * `verifyLedger` against real MySQL (`npm run infra:up && npm run migrate`). Postings go through the real
 * service, corruption is raw SQL. The dev database may hold other data, so assertions look only at the rows
 * of the test; check 2 (currencies) is global and is only asserted where the test breaks it. Everything the
 * test creates is removed afterwards and the funding balances and versions are put back.
 */
describe('verifyLedger (e2e, real MySQL)', () => {
  let db: Knex;
  let service: KnexLedgerService;
  const logger = { info: jest.fn(), warn: jest.fn() };
  let userIds: string[] = [];

  const newUserId = (): string => {
    const id = randomUUID();
    userIds.push(id);
    return id;
  };

  const post = async (posting: PostOperation): Promise<string> =>
    (await service.post(posting)).operation.id;

  const accountIdOf = async (userId: string, currency: Currency): Promise<string> => {
    const row = await db('accounts')
      .where({ user_id: userId, currency })
      .first<{ id: string }>('id');
    return row.id;
  };

  /** What a report says about the given accounts and operations; everything else in the database is ignored. */
  const mine = (
    report: LedgerVerifyReport,
    accountIds: string[],
    operationIds: string[],
  ): LedgerVerifyReport => ({
    balances: report.balances.filter((row) => accountIds.includes(row.accountId)),
    currencies: report.currencies,
    operations: report.operations.filter((row) => operationIds.includes(row.operationId)),
    versions: report.versions.filter((row) => accountIds.includes(row.accountId)),
  });

  /** A credit, a transfer and a conversion-like operation that balances in two currencies. */
  const postHealthyOperations = async (): Promise<{
    accountIds: string[];
    operationIds: string[];
    userA: string;
  }> => {
    const [userA, userB] = [newUserId(), newUserId()];
    const operationIds = [
      await post(credit(randomUUID(), userA, 'UAH', 10000n)),
      await post(
        operation(randomUUID(), [
          { account: userAccount(userA, 'UAH'), amount: -300n },
          { account: userAccount(userB, 'UAH'), amount: 300n },
        ]),
      ),
      await post(
        operation(randomUUID(), [
          { account: userAccount(userA, 'UAH'), amount: -4125n },
          { account: platformAccount(PLATFORM_FUNDING, 'UAH'), amount: 4125n },
          { account: platformAccount(PLATFORM_FUNDING, 'USD'), amount: -100n },
          { account: userAccount(userA, 'USD'), amount: 100n },
        ]),
      ),
    ];
    const accountIds = [
      await accountIdOf(userA, 'UAH'),
      await accountIdOf(userA, 'USD'),
      await accountIdOf(userB, 'UAH'),
    ];
    return { accountIds, operationIds, userA };
  };

  const cleanUp = async (): Promise<void> => {
    await removeLedgerRows(db, { userIds });
    userIds = [];
  };

  beforeAll(() => {
    db = createKnex(process.env.DATABASE_URL!);
    service = new KnexLedgerService(
      new LedgerRepository(db),
      { publish: () => Promise.resolve(null) } as unknown as EventPublisher,
      logger as unknown as PinoLogger,
    );
  });

  // After each test, so a corrupted row never outlives the test that made it.
  afterEach(cleanUp);

  afterAll(async () => {
    await db.destroy();
  });

  it('lists nothing of the test for healthy postings: a credit, a transfer and a two-currency operation', async () => {
    const { accountIds, operationIds } = await postHealthyOperations();

    const report = mine(await verifyLedger(db), accountIds, operationIds);

    expect([report.balances, report.operations, report.versions]).toEqual([[], [], []]);
  });

  it('lists only the account whose stored balance is off by one in the balance check', async () => {
    const { accountIds, operationIds, userA } = await postHealthyOperations();
    const broken = await accountIdOf(userA, 'UAH');
    await db('accounts')
      .where({ id: broken })
      .update({ balance: db.raw('balance + 1') });

    const report = mine(await verifyLedger(db), accountIds, operationIds);

    // 10000 - 300 - 4125 = 5575 is what the entries add up to.
    expect(report.balances).toEqual([
      { accountId: broken, currency: 'UAH', stored: 5576n, computed: 5575n },
    ]);
    expect(report.operations).toEqual([]);
    expect(report.versions).toEqual([]);
  });

  it('names the operation, the account and the currency when an entry amount is off by one', async () => {
    const { accountIds, operationIds, userA } = await postHealthyOperations();
    const broken = await accountIdOf(userA, 'UAH');
    const [, , conversion] = operationIds;
    await db('entries')
      .where({ operation_id: conversion, account_id: broken })
      .update({ amount: db.raw('amount + 1') });

    const full = await verifyLedger(db);
    const report = mine(full, accountIds, operationIds);

    expect(report.operations).toEqual([
      { operationId: conversion, type: 'test_credit', currency: 'UAH', sum: 1n },
    ]);
    expect(report.balances).toEqual([
      { accountId: broken, currency: 'UAH', stored: 5575n, computed: 5576n },
    ]);
    expect(full.currencies.map((row) => row.currency)).toContain('UAH');
    expect(report.versions).toEqual([]);
  });

  it('lists only the account whose version is off by one in the version check', async () => {
    const { accountIds, operationIds, userA } = await postHealthyOperations();
    const broken = await accountIdOf(userA, 'UAH');
    await db('accounts')
      .where({ id: broken })
      .update({ version: db.raw('version + 1') });

    const report = mine(await verifyLedger(db), accountIds, operationIds);

    // The credit, the transfer and the conversion each wrote user A's UAH account once.
    expect(report.versions).toEqual([
      { accountId: broken, currency: 'UAH', version: 4, operations: 3 },
    ]);
    expect(report.balances).toEqual([]);
    expect(report.operations).toEqual([]);
  });

  // Postings in flight must not look like corruption. Not a claim about one moment: each check is one statement
  // and consistent on its own; the shared transaction is what lines the four up.
  it('reports no mismatch for the test accounts while 20 postings run in parallel', async () => {
    const users = Array.from({ length: 5 }, newUserId);
    let running = true;
    const postings = Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        service.post(credit(randomUUID(), users[index % users.length], 'UAH', 100n)),
      ),
    ).finally(() => {
      running = false;
    });

    const reports: LedgerVerifyReport[] = [];
    do {
      reports.push(await verifyLedger(db));
    } while (running);
    await postings;
    reports.push(await verifyLedger(db));

    const accountIds = await Promise.all(users.map((userId) => accountIdOf(userId, 'UAH')));
    const operationIds = (await db('operations')
      .join('entries', 'entries.operation_id', 'operations.id')
      .whereIn('entries.account_id', accountIds)
      .distinct()
      .pluck('operations.id')) as string[];
    expect(operationIds).toHaveLength(20);
    for (const report of reports) {
      const own = mine(report, accountIds, operationIds);
      expect([own.balances, own.operations, own.versions]).toEqual([[], [], []]);
    }
  });
});
