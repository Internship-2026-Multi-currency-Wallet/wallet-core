import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { createKnex } from '../src/database/database.module.js';
import { isUniqueViolation } from '../src/database/unique-violation.js';

const ER_CHECK_CONSTRAINT_VIOLATED = 3819;

/**
 * The ledger tables and their safety nets (migrations/…_ledger.ts), against real MySQL
 * (`npm run infra:up && npm run migrate`). Rows use fresh ids and are removed after each test.
 */
describe('ledger schema (e2e, real MySQL)', () => {
  let db: Knex;
  const accountIds: string[] = [];
  const operationIds: string[] = [];

  const insertAccount = async (row: {
    type: string;
    userId?: string | null;
    code?: string | null;
    currency?: string;
    balance?: number;
  }): Promise<string> => {
    const id = randomUUID();
    accountIds.push(id);
    await db('accounts').insert({
      id,
      type: row.type,
      user_id: row.userId ?? null,
      code: row.code ?? null,
      currency: row.currency ?? 'UAH',
      balance: row.balance ?? 0,
      created_at: new Date(),
    });
    return id;
  };

  const insertOperation = async (): Promise<string> => {
    const id = randomUUID();
    operationIds.push(id);
    await db('operations').insert({
      id,
      type: 'test_credit',
      idempotency_key: `test:${id}`,
      fingerprint: 'f'.repeat(64),
      created_at: new Date(),
    });
    return id;
  };

  const errnoOf = async (query: Promise<unknown>): Promise<unknown> =>
    query.then(
      () => 'no error',
      (error: { errno?: unknown }) => error.errno,
    );

  beforeAll(() => {
    db = createKnex(process.env.DATABASE_URL!);
  });

  afterEach(async () => {
    // Entries first: they reference both other tables.
    await db('entries').whereIn('operation_id', operationIds).delete();
    await db('operations').whereIn('id', operationIds).delete();
    await db('accounts').whereIn('id', accountIds).delete();
    accountIds.length = 0;
    operationIds.length = 0;
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it('has the platform funding account in each of the five currencies', async () => {
    const rows = await db('accounts')
      .where({ type: 'platform', code: 'funding' })
      .orderBy('currency')
      .pluck('currency');
    expect(rows).toEqual(['EUR', 'PLN', 'UAH', 'USD', 'USDT']);
  });

  it('has an unsigned, non-null version column that starts at 0', async () => {
    const [rows] = (await db.raw(
      `SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS isNullable, COLUMN_DEFAULT AS columnDefault
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts' AND COLUMN_NAME = 'version'`,
    )) as [{ columnType: string; isNullable: string; columnDefault: string }[]];
    expect(rows).toEqual([{ columnType: 'bigint unsigned', isNullable: 'NO', columnDefault: '0' }]);

    const id = await insertAccount({ type: 'user', userId: randomUUID() });
    const row = await db('accounts').where({ id }).first<{ version: number }>('version');
    expect(row.version).toBe(0);
  });

  it('refuses a negative balance on a user account, but not on a platform account', async () => {
    await expect(
      errnoOf(insertAccount({ type: 'user', userId: randomUUID(), balance: -1 })),
    ).resolves.toBe(ER_CHECK_CONSTRAINT_VIOLATED);
    await expect(
      insertAccount({ type: 'platform', code: `test-${randomUUID().slice(0, 8)}`, balance: -1 }),
    ).resolves.toEqual(expect.any(String));
  });

  it('refuses an owner that does not match the account type', async () => {
    await expect(
      errnoOf(insertAccount({ type: 'user', userId: randomUUID(), code: 'funding' })),
    ).resolves.toBe(ER_CHECK_CONSTRAINT_VIOLATED);
    await expect(errnoOf(insertAccount({ type: 'user' }))).resolves.toBe(
      ER_CHECK_CONSTRAINT_VIOLATED,
    );
    await expect(errnoOf(insertAccount({ type: 'platform' }))).resolves.toBe(
      ER_CHECK_CONSTRAINT_VIOLATED,
    );
    await expect(
      errnoOf(insertAccount({ type: 'external', userId: randomUUID(), code: 'paygate' })),
    ).resolves.toBe(ER_CHECK_CONSTRAINT_VIOLATED);
  });

  it('allows one account per user and currency', async () => {
    const userId = randomUUID();
    await insertAccount({ type: 'user', userId, currency: 'UAH' });
    await insertAccount({ type: 'user', userId, currency: 'USD' });

    const duplicate = insertAccount({ type: 'user', userId, currency: 'UAH' });

    await expect(
      duplicate.then(
        () => false,
        (error: unknown) => isUniqueViolation(error, 'accounts_user_currency_unique'),
      ),
    ).resolves.toBe(true);
  });

  it('allows one platform account per code and currency', async () => {
    const code = `test-${randomUUID().slice(0, 8)}`;
    await insertAccount({ type: 'platform', code });

    const duplicate = insertAccount({ type: 'platform', code });

    await expect(
      duplicate.then(
        () => false,
        (error: unknown) => isUniqueViolation(error, 'accounts_type_code_currency_unique'),
      ),
    ).resolves.toBe(true);
  });

  it('keeps idempotency keys that differ only in a trailing space apart', async () => {
    const key = `space:${randomUUID()}`;
    const insert = (idempotencyKey: string) => {
      const id = randomUUID();
      operationIds.push(id);
      return db('operations').insert({
        id,
        type: 'test_credit',
        idempotency_key: idempotencyKey,
        fingerprint: 'f'.repeat(64),
        created_at: new Date(),
      });
    };

    await insert(key);

    await expect(insert(`${key} `)).resolves.toBeDefined();
  });

  it('keeps idempotency keys that differ only in case apart', async () => {
    const key = `Case:${randomUUID()}`;
    const operation = (idempotencyKey: string) => {
      const id = randomUUID();
      operationIds.push(id);
      return db('operations').insert({
        id,
        type: 'test_credit',
        idempotency_key: idempotencyKey,
        fingerprint: 'f'.repeat(64),
        created_at: new Date(),
      });
    };

    await operation(key);

    await expect(operation(key.toLowerCase())).resolves.toBeDefined();
    await expect(
      operation(key).then(
        () => false,
        (error: unknown) => isUniqueViolation(error, 'operations_idempotency_key_unique'),
      ),
    ).resolves.toBe(true);
  });

  it('keeps user ids and platform codes that differ only in case apart', async () => {
    const userId = randomUUID();
    const code = `Test-${randomUUID().slice(0, 8)}`;

    await insertAccount({ type: 'user', userId });
    await insertAccount({ type: 'user', userId: userId.toUpperCase() });
    await insertAccount({ type: 'platform', code });
    await insertAccount({ type: 'platform', code: code.toLowerCase() });

    const found = await db('accounts').where({ user_id: userId }).count({ total: '*' });
    expect(Number(found[0].total)).toBe(1);
  });

  it('refuses an entry with a zero amount', async () => {
    const accountId = await insertAccount({ type: 'user', userId: randomUUID() });
    const operationId = await insertOperation();
    const entry = (amount: number) => ({
      id: randomUUID(),
      operation_id: operationId,
      account_id: accountId,
      amount,
    });

    await expect(errnoOf(db('entries').insert(entry(0)))).resolves.toBe(
      ER_CHECK_CONSTRAINT_VIOLATED,
    );
    await expect(db('entries').insert(entry(-5))).resolves.toBeDefined();
  });

  it('refuses a second operation with the same idempotency key', async () => {
    const operationId = await insertOperation();
    const id = randomUUID();
    operationIds.push(id);

    const duplicate = db('operations').insert({
      id,
      type: 'test_credit',
      idempotency_key: `test:${operationId}`,
      fingerprint: 'f'.repeat(64),
      created_at: new Date(),
    });

    await expect(
      duplicate.then(
        () => false,
        (error: unknown) => isUniqueViolation(error, 'operations_idempotency_key_unique'),
      ),
    ).resolves.toBe(true);
  });
});
