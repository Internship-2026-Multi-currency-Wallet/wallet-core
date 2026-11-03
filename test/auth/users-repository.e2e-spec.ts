import type { Knex } from 'knex';
import { type NewUser, UsersRepository } from '../../src/auth/users.repository.js';
import { createKnex } from '../../src/database/database.module.js';

/** Needs MySQL with migrations applied (`npm run infra:up && npm run migrate`). */
describe('UsersRepository (e2e, real MySQL)', () => {
  let db: Knex;
  let repo: UsersRepository;

  const user = (overrides: Partial<NewUser> = {}): NewUser => ({
    id: '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b',
    email: 'artem@test.com',
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
    phone: '+380501234567',
    createdAt: new Date('2026-11-03T10:00:00.123Z'),
    ...overrides,
  });

  beforeAll(() => {
    db = createKnex(process.env.DATABASE_URL!);
    repo = new UsersRepository(db);
  });

  beforeEach(async () => {
    // DELETE, not TRUNCATE: MySQL refuses to truncate a table referenced by a foreign key.
    await db('sessions').delete();
    await db('users').delete();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('stores a new user with the lockout columns at their defaults', async () => {
    await expect(repo.insert(user())).resolves.toBe('created');
    await expect(db('users').select('*')).resolves.toEqual([
      {
        id: '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b',
        email: 'artem@test.com',
        password_hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
        phone: '+380501234567',
        failed_login_attempts: 0,
        locked_until: null,
        created_at: new Date('2026-11-03T10:00:00.123Z'),
        updated_at: new Date('2026-11-03T10:00:00.123Z'),
      },
    ]);
  });

  it('stores a missing phone as NULL', async () => {
    await repo.insert(user({ phone: null }));
    await expect(db('users').first('phone')).resolves.toEqual({ phone: null });
  });

  it('answers emailTaken for a taken email, also in another case', async () => {
    await repo.insert(user());
    const second = { id: '1c7a4d3f-9e5b-4a8c-8d2e-3b6f7a8b9c0d' };
    await expect(repo.insert(user({ ...second, email: 'artem@test.com' }))).resolves.toBe(
      'emailTaken',
    );
    await expect(repo.insert(user({ ...second, email: 'ARTEM@test.com' }))).resolves.toBe(
      'emailTaken',
    );
    await expect(db('users').count({ count: '*' })).resolves.toEqual([{ count: 1 }]);
  });

  it('rethrows other database errors', async () => {
    await repo.insert(user());
    // Same id, other email: a duplicate primary key is a bug, not a taken email.
    await expect(repo.insert(user({ email: 'other@test.com' }))).rejects.toMatchObject({
      code: 'ER_DUP_ENTRY',
    });
  });
});
