import type { Knex } from 'knex';
import { createKnex } from '../src/database/database.module.js';

/** Needs MySQL (`npm run infra:up`). */
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
});
