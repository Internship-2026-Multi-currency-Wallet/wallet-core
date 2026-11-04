import type { Knex } from 'knex';
import { type NewSession, SessionsRepository } from '../src/auth/sessions.repository.js';
import { UsersRepository } from '../src/auth/users.repository.js';
import { createKnex } from '../src/database/database.module.js';

/** Needs MySQL with migrations applied (`npm run infra:up && npm run migrate`). */
describe('SessionsRepository (e2e, real MySQL)', () => {
  const USER_ID = '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b';
  let db: Knex;
  let repo: SessionsRepository;

  const session = (overrides: Partial<NewSession> = {}): NewSession => ({
    id: '5d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a',
    userId: USER_ID,
    refreshTokenHash: 'a'.repeat(64),
    expiresAt: new Date('2026-12-04T10:00:00.000Z'),
    createdAt: new Date('2026-11-04T10:00:00.000Z'),
    ...overrides,
  });

  beforeAll(() => {
    db = createKnex(process.env.DATABASE_URL!);
    repo = new SessionsRepository(db);
  });

  beforeEach(async () => {
    await db('sessions').delete();
    await db('users').delete();
    await new UsersRepository(db).insert({
      id: USER_ID,
      email: 'artem@test.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
      phone: null,
      createdAt: new Date('2026-11-03T10:00:00.000Z'),
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('stores an active session', async () => {
    await repo.create(session());
    await expect(db('sessions').select('*')).resolves.toEqual([
      {
        id: '5d1e2f3a-4b5c-4d6e-8f7a-9b0c1d2e3f4a',
        user_id: USER_ID,
        refresh_token_hash: 'a'.repeat(64),
        expires_at: new Date('2026-12-04T10:00:00.000Z'),
        revoked_at: null,
        created_at: new Date('2026-11-04T10:00:00.000Z'),
      },
    ]);
  });

  it('keeps one session per login of the same user', async () => {
    await repo.create(session());
    await repo.create(
      session({ id: '6e2f3a4b-5c6d-4e7f-9a8b-0c1d2e3f4a5b', refreshTokenHash: 'b'.repeat(64) }),
    );
    await expect(db('sessions').count({ count: '*' })).resolves.toEqual([{ count: 2 }]);
  });

  it('refuses a refresh token hash that is already stored', async () => {
    await repo.create(session());
    await expect(
      repo.create(session({ id: '6e2f3a4b-5c6d-4e7f-9a8b-0c1d2e3f4a5b' })),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it('refuses a session of an unknown user', async () => {
    await expect(
      repo.create(session({ userId: '7f3a4b5c-6d7e-4f8a-8b9c-1d2e3f4a5b6c' })),
    ).rejects.toMatchObject({ code: 'ER_NO_REFERENCED_ROW_2' });
  });
});
