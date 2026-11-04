import type { Knex } from 'knex';
import { InsertUserResult, type NewUser, UsersRepository } from '../src/auth/users.repository.js';
import { createKnex } from '../src/database/database.module.js';

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
    await expect(repo.insert(user())).resolves.toBe(InsertUserResult.Created);
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
      InsertUserResult.EmailTaken,
    );
    await expect(repo.insert(user({ ...second, email: 'ARTEM@test.com' }))).resolves.toBe(
      InsertUserResult.EmailTaken,
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

  describe('findByEmail', () => {
    it('returns the credentials of a user', async () => {
      await repo.insert(user());
      await expect(repo.findByEmail('artem@test.com')).resolves.toEqual({
        id: '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b',
        email: 'artem@test.com',
        phone: '+380501234567',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
        lockedUntil: null,
      });
    });

    it('returns null for an unknown email', async () => {
      await repo.insert(user());
      await expect(repo.findByEmail('other@test.com')).resolves.toBeNull();
    });
  });

  describe('recordFailedLogin', () => {
    const ID = '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b';
    const NOW = new Date('2026-11-04T10:00:00.000Z');
    const LOCK_UNTIL = new Date('2026-11-04T10:15:00.000Z');
    const policy = { now: NOW, maxFailedAttempts: 5, lockUntil: LOCK_UNTIL };

    const state = () =>
      db('users').where({ id: ID }).first('failed_login_attempts', 'locked_until', 'updated_at');

    it('counts failures and locks the account on the fifth one', async () => {
      await repo.insert(user());
      for (let attempt = 1; attempt <= 4; attempt++) {
        await expect(repo.recordFailedLogin(ID, policy)).resolves.toBeNull();
      }
      await expect(state()).resolves.toEqual({
        failed_login_attempts: 4,
        locked_until: null,
        updated_at: NOW,
      });

      await expect(repo.recordFailedLogin(ID, policy)).resolves.toEqual(LOCK_UNTIL);
      await expect(state()).resolves.toMatchObject({
        failed_login_attempts: 0,
        locked_until: LOCK_UNTIL,
      });
    });

    it('neither counts nor extends while the account is locked', async () => {
      await repo.insert(user());
      await db('users').where({ id: ID }).update({ locked_until: LOCK_UNTIL });
      const later = { ...policy, now: new Date('2026-11-04T10:05:00.000Z') };
      const extended = { ...later, lockUntil: new Date('2026-11-04T10:20:00.000Z') };

      await expect(repo.recordFailedLogin(ID, extended)).resolves.toEqual(LOCK_UNTIL);
      await expect(state()).resolves.toMatchObject({
        failed_login_attempts: 0,
        locked_until: LOCK_UNTIL,
      });
    });

    it('starts counting again once the lock has expired', async () => {
      await repo.insert(user());
      await db('users').where({ id: ID }).update({ locked_until: LOCK_UNTIL });
      const afterLock = { ...policy, now: new Date('2026-11-04T10:16:00.000Z') };

      await expect(repo.recordFailedLogin(ID, afterLock)).resolves.toBeNull();
      await expect(state()).resolves.toMatchObject({
        failed_login_attempts: 1,
        locked_until: null,
      });
    });

    it('counts parallel failures one by one and locks exactly once', async () => {
      await repo.insert(user());
      const results = await Promise.all(
        Array.from({ length: 5 }, () => repo.recordFailedLogin(ID, policy)),
      );
      expect(results.filter((lockedUntil) => lockedUntil !== null)).toEqual([LOCK_UNTIL]);
      await expect(state()).resolves.toMatchObject({
        failed_login_attempts: 0,
        locked_until: LOCK_UNTIL,
      });
    });

    it('returns null for an unknown user', async () => {
      await expect(repo.recordFailedLogin(ID, policy)).resolves.toBeNull();
    });
  });

  describe('recordSuccessfulLogin', () => {
    const ID = '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b';
    const NOW = new Date('2026-11-04T10:30:00.000Z');
    const state = () =>
      db('users').where({ id: ID }).first('failed_login_attempts', 'locked_until', 'updated_at');

    it('clears the counter and an expired lock', async () => {
      await repo.insert(user());
      await db('users')
        .where({ id: ID })
        .update({ failed_login_attempts: 3, locked_until: new Date('2026-11-04T10:15:00.000Z') });

      await expect(repo.recordSuccessfulLogin(ID, NOW)).resolves.toBeNull();
      await expect(state()).resolves.toEqual({
        failed_login_attempts: 0,
        locked_until: null,
        updated_at: NOW,
      });
    });

    it('does not write when there is nothing to reset', async () => {
      await repo.insert(user());
      await expect(repo.recordSuccessfulLogin(ID, NOW)).resolves.toBeNull();
      await expect(state()).resolves.toMatchObject({
        updated_at: new Date('2026-11-03T10:00:00.123Z'),
      });
    });

    it('returns the lock and keeps it while the account is locked', async () => {
      const lockedUntil = new Date('2026-11-04T10:45:00.000Z');
      await repo.insert(user());
      await db('users').where({ id: ID }).update({ locked_until: lockedUntil });

      await expect(repo.recordSuccessfulLogin(ID, NOW)).resolves.toEqual(lockedUntil);
      await expect(state()).resolves.toMatchObject({ locked_until: lockedUntil });
    });

    it('cannot lift a lock that a parallel failure sets', async () => {
      const lockUntil = new Date('2026-11-04T10:45:00.000Z');
      await repo.insert(user());
      await db('users').where({ id: ID }).update({ failed_login_attempts: 4 });

      const [failure, success] = await Promise.all([
        repo.recordFailedLogin(ID, { now: NOW, maxFailedAttempts: 5, lockUntil }),
        repo.recordSuccessfulLogin(ID, NOW),
      ]);

      // Either order is fine, but the success must see a lock the failure set before it.
      const row = await state();
      if (success === null && failure === null) {
        expect(row).toMatchObject({ failed_login_attempts: 1, locked_until: null });
      } else {
        expect({ failure, success }).toEqual({ failure: lockUntil, success: lockUntil });
        expect(row).toMatchObject({ failed_login_attempts: 0, locked_until: lockUntil });
      }
    });

    it('returns null for an unknown user', async () => {
      await expect(repo.recordSuccessfulLogin(ID, NOW)).resolves.toBeNull();
    });
  });
});
