import type { Knex } from 'knex';
import { createKnex } from '../src/database/database.module.js';

/** Needs MySQL with migrations applied (`npm run infra:up && npm run migrate`). */
describe('createKnex (e2e, real MySQL)', () => {
  let db: Knex;

  beforeAll(() => {
    db = createKnex(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('keeps the values of a failed query out of the error message', async () => {
    const failed = db.raw('select * from no_such_table where email = ?', ['artem@test.com']);

    await expect(failed).rejects.toThrow(
      "select * from no_such_table where email = ? - Table 'wallet_core.no_such_table' doesn't exist",
    );
    await expect(failed).rejects.not.toThrow('artem@test.com');
  });

  it('keeps the values out of every field of a duplicate-key error, but not the key', async () => {
    const user = (id: string) => ({
      id,
      email: 'scrub@test.com',
      password_hash: '$argon2id$secret-hash',
      created_at: new Date(),
      updated_at: new Date(),
    });
    // Rolled back by the thrown duplicate: nothing stays in the table.
    const error: unknown = await db
      .transaction(async (trx) => {
        await trx('users').insert(user('00000000-0000-4000-8000-0000000000a1'));
        await trx('users').insert(user('00000000-0000-4000-8000-0000000000a2'));
      })
      .catch((err: unknown) => err);

    expect(error).toMatchObject({
      errno: 1062,
      sqlMessage: "Duplicate entry '?' for key 'users.users_email_unique'",
    });
    expect(error).not.toHaveProperty('sql');
    const everything = JSON.stringify({ ...(error as object), message: (error as Error).message });
    expect(everything).not.toContain('scrub@test.com');
    expect(everything).not.toContain('secret-hash');
  });

  it('keeps the value out of an "Incorrect … value" error', async () => {
    const error: unknown = await db('users')
      .insert({
        id: '00000000-0000-4000-8000-0000000000a3',
        email: 'scrub@test.com',
        password_hash: '$argon2id$secret-hash',
        failed_login_attempts: 'scrub@test.com',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .catch((err: unknown) => err);

    expect(error).toMatchObject({
      sqlMessage: "Incorrect integer value: '?' for column 'failed_login_attempts' at row 1",
    });
    const everything = JSON.stringify({ ...(error as object), message: (error as Error).message });
    expect(everything).not.toContain('scrub@test.com');
    expect(everything).not.toContain('secret-hash');
  });
});
