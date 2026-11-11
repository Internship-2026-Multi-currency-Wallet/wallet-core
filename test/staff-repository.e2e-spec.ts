import type { Knex } from 'knex';
import { createKnex } from '../src/database/database.module.js';
import { StaffRole } from '../src/staff/permissions.js';
import { StaffStatus } from '../src/staff/staff.model.js';
import {
  InsertStaffResult,
  type NewStaff,
  StaffRepository,
} from '../src/staff/staff.repository.js';

/** Needs MySQL with migrations applied (`npm run infra:up && npm run migrate`). */
describe('StaffRepository (e2e, real MySQL)', () => {
  let db: Knex;
  let repo: StaffRepository;

  const ADMIN_ID = '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b';
  const at = new Date('2026-11-04T10:00:00.123Z');

  const staff = (overrides: Partial<NewStaff> = {}): NewStaff => ({
    id: ADMIN_ID,
    email: 'admin@test.com',
    role: StaffRole.ADMIN,
    createdAt: at,
    ...overrides,
  });

  beforeAll(() => {
    db = createKnex(process.env.DATABASE_URL!);
    repo = new StaffRepository(db);
  });

  beforeEach(async () => {
    // DELETE, not TRUNCATE: MySQL refuses to truncate a table referenced by a foreign key.
    await db('staff_sessions').delete();
    await db('staff_invitations').delete();
    await db('staff').delete();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('stores a new staff member as invited, without a password', async () => {
    await expect(repo.insert(staff())).resolves.toBe(InsertStaffResult.Created);
    await expect(repo.findById(ADMIN_ID)).resolves.toEqual({
      id: ADMIN_ID,
      email: 'admin@test.com',
      role: StaffRole.ADMIN,
      status: StaffStatus.INVITED,
      passwordHash: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
      createdAt: at,
      updatedAt: at,
    });
  });

  const OTHER_ID = '1c7a4d3f-9e5b-4a8c-8d2e-3b6f7a8b9c0d';

  it('answers emailTaken for a taken email, also in another case', async () => {
    await repo.insert(staff());
    await expect(repo.insert(staff({ id: OTHER_ID, email: 'ADMIN@test.com' }))).resolves.toBe(
      InsertStaffResult.EmailTaken,
    );
    await expect(repo.findById(OTHER_ID)).resolves.toBeUndefined();
  });

  it('finds a staff member by email, case-insensitively', async () => {
    await repo.insert(staff());
    await expect(repo.findByEmail('Admin@Test.com')).resolves.toMatchObject({ id: ADMIN_ID });
    await expect(repo.findByEmail('nobody@test.com')).resolves.toBeUndefined();
  });

  it('lists staff oldest first, ties by id', async () => {
    const later = new Date('2026-11-04T11:00:00.000Z');
    await repo.insert(staff({ id: OTHER_ID, email: 'late@test.com', createdAt: later }));
    await repo.insert(staff({ id: '2d8b5e4a-0f6c-4b9d-9e3f-4c7a8b9c0d1e', email: 'b@test.com' }));
    await repo.insert(staff());
    const listed = await repo.list();
    expect(listed.map(({ email }) => email)).toEqual([
      'admin@test.com',
      'b@test.com',
      'late@test.com',
    ]);
  });

  it('knows whether any admin exists, in any status (bootstrap)', async () => {
    await repo.insert(staff({ role: StaffRole.SUPPORT }));
    await expect(repo.anyAdminExists()).resolves.toBe(false);
    await repo.insert(staff({ id: OTHER_ID, email: 'invited-admin@test.com' }));
    await expect(repo.anyAdminExists()).resolves.toBe(true);
  });

  it('updates role and status and records the update time', async () => {
    await repo.insert(staff());
    const changedAt = new Date('2026-11-04T13:00:00.000Z');
    await repo.update(ADMIN_ID, { role: StaffRole.FINANCE, status: StaffStatus.ACTIVE }, changedAt);
    await expect(repo.findById(ADMIN_ID)).resolves.toMatchObject({
      role: StaffRole.FINANCE,
      status: StaffStatus.ACTIVE,
      createdAt: at,
      updatedAt: changedAt,
    });
  });

  describe('last-admin rule support', () => {
    const changedAt = new Date('2026-11-04T13:00:00.000Z');

    beforeEach(async () => {
      await repo.insert(staff());
      await repo.update(ADMIN_ID, { status: StaffStatus.ACTIVE }, changedAt);
      await repo.insert(staff({ id: OTHER_ID, email: 'invited-admin@test.com' }));
      await repo.insert(
        staff({
          id: '2d8b5e4a-0f6c-4b9d-9e3f-4c7a8b9c0d1e',
          email: 's@test.com',
          role: StaffRole.SUPPORT,
        }),
      );
    });

    it('locks and answers only the active admins inside a transaction', async () => {
      await expect(repo.transaction((tx) => tx.lockActiveAdminIds())).resolves.toEqual([ADMIN_ID]);
    });

    it('locks and answers the admins of every status, and no other role', async () => {
      const DEACTIVATED_ID = '4f0d7a6c-2b8e-4d1f-9a5b-6e9c0d1e2f3a';
      await repo.insert(staff({ id: DEACTIVATED_ID, email: 'gone@test.com' }));
      await repo.update(DEACTIVATED_ID, { status: StaffStatus.DEACTIVATED }, changedAt);

      const ids = await repo.transaction((tx) => tx.lockAdminIds());

      expect(ids).toEqual([ADMIN_ID, OTHER_ID, DEACTIVATED_ID].sort());
    });

    it('keeps the admin rows locked inside the transaction, so another connection cannot lock them', async () => {
      await repo.transaction(async (tx) => {
        await tx.lockAdminIds();
        const error = await db
          .raw('SELECT id FROM staff WHERE id = ? FOR UPDATE NOWAIT', [OTHER_ID])
          .then(
            () => undefined,
            (err: { code?: string; errno?: number }) => err,
          );
        expect(error).toMatchObject({ code: 'ER_LOCK_NOWAIT', errno: 3572 });
      });
    });

    it('applies nothing when the transaction fails', async () => {
      await expect(
        repo.transaction(async (tx) => {
          await tx.update(ADMIN_ID, { status: StaffStatus.DEACTIVATED }, changedAt);
          throw new Error('rule broken');
        }),
      ).rejects.toThrow('rule broken');
      await expect(repo.findById(ADMIN_ID)).resolves.toMatchObject({ status: StaffStatus.ACTIVE });
    });
  });

  describe('deadlock retry', () => {
    const deadlock = () =>
      Object.assign(new Error('Deadlock'), { errno: 1213, code: 'ER_LOCK_DEADLOCK' });

    beforeEach(async () => {
      await repo.insert(staff());
      await repo.update(ADMIN_ID, { status: StaffStatus.ACTIVE }, at);
    });

    it('reruns the transaction after a deadlock, and drops the failed attempt', async () => {
      let attempts = 0;
      const result = await repo.transaction(async (tx) => {
        attempts += 1;
        if (attempts === 1) {
          await tx.update(ADMIN_ID, { status: StaffStatus.DEACTIVATED }, at);
          throw deadlock();
        }
        await tx.update(ADMIN_ID, { role: StaffRole.FINANCE }, at);
        return 'second attempt';
      });
      expect(result).toBe('second attempt');
      expect(attempts).toBe(2);
      await expect(repo.findById(ADMIN_ID)).resolves.toMatchObject({
        role: StaffRole.FINANCE,
        status: StaffStatus.ACTIVE,
      });
    });

    it('gives up after 3 attempts and rethrows the deadlock', async () => {
      let attempts = 0;
      const error = deadlock();
      await expect(
        repo.transaction(() => {
          attempts += 1;
          return Promise.reject(error);
        }),
      ).rejects.toBe(error);
      expect(attempts).toBe(3);
    });

    it('does not rerun the transaction for other errors', async () => {
      let attempts = 0;
      await expect(
        repo.transaction(() => {
          attempts += 1;
          return Promise.reject(new Error('rule broken'));
        }),
      ).rejects.toThrow('rule broken');
      expect(attempts).toBe(1);
    });
  });

  describe('locking', () => {
    beforeEach(async () => {
      await repo.insert(staff());
    });

    it('answers the staff record under lock, and undefined for an unknown id', async () => {
      await repo.transaction(async (tx) => {
        await expect(tx.lockById(ADMIN_ID)).resolves.toMatchObject({
          id: ADMIN_ID,
          email: 'admin@test.com',
        });
        await expect(tx.lockById(OTHER_ID)).resolves.toBeUndefined();
      });
    });

    it('keeps the row locked inside the transaction, so another connection cannot lock it', async () => {
      await repo.transaction(async (tx) => {
        await tx.lockById(ADMIN_ID);
        const error = await db
          .raw('SELECT id FROM staff WHERE id = ? FOR UPDATE NOWAIT', [ADMIN_ID])
          .then(
            () => undefined,
            (err: { code?: string; errno?: number }) => err,
          );
        expect(error).toMatchObject({ code: 'ER_LOCK_NOWAIT', errno: 3572 });
      });
    });
  });

  describe('invitations', () => {
    const HASH = 'a'.repeat(64);
    const expiresAt = new Date('2026-11-06T10:00:00.123Z');
    const invite = (overrides: Partial<{ id: string; tokenHash: string; expiresAt: Date }> = {}) =>
      repo.insertInvitation({
        id: '3e9c6f5b-1a7d-4c0e-8f4a-5d8b9c0d1e2f',
        staffId: ADMIN_ID,
        tokenHash: HASH,
        expiresAt,
        createdAt: at,
        ...overrides,
      });

    beforeEach(async () => {
      await repo.insert(staff());
    });

    it('consumes a valid invitation once and answers its staff id', async () => {
      await invite();
      const later = new Date('2026-11-05T10:00:00.000Z');
      await expect(repo.consumeInvitation(HASH, later)).resolves.toBe(ADMIN_ID);
      await expect(repo.consumeInvitation(HASH, later)).resolves.toBeNull();
    });

    it('refuses an expired invitation, from the expiry moment on', async () => {
      await invite();
      await expect(repo.consumeInvitation(HASH, expiresAt)).resolves.toBeNull();
    });

    it('refuses an unknown token', async () => {
      await invite();
      await expect(repo.consumeInvitation('b'.repeat(64), at)).resolves.toBeNull();
    });

    it('expires the unused invitations of a staff member, so only a newer one works', async () => {
      await invite();
      const resentAt = new Date('2026-11-05T09:00:00.000Z');
      await repo.expireInvitations(ADMIN_ID, resentAt);
      const NEW_HASH = 'c'.repeat(64);
      await invite({ id: '4f0d7a6c-2b8e-4d1f-9a5b-6e9c0d1e2f3a', tokenHash: NEW_HASH });

      await expect(repo.consumeInvitation(HASH, resentAt)).resolves.toBeNull();
      await expect(repo.consumeInvitation(NEW_HASH, resentAt)).resolves.toBe(ADMIN_ID);
    });

    describe('findInvitationStaffId', () => {
      const now = new Date('2026-11-05T10:00:00.000Z');

      it('answers the staff id of a live invitation', async () => {
        await invite();
        await expect(repo.findInvitationStaffId(HASH, now)).resolves.toBe(ADMIN_ID);
      });

      it('answers undefined for an unknown token', async () => {
        await invite();
        await expect(repo.findInvitationStaffId('b'.repeat(64), now)).resolves.toBeUndefined();
      });

      it('answers undefined for a used invitation', async () => {
        await invite();
        await repo.consumeInvitation(HASH, now);
        await expect(repo.findInvitationStaffId(HASH, now)).resolves.toBeUndefined();
      });

      it('answers undefined for an expired invitation, from the expiry moment on', async () => {
        await invite();
        await expect(repo.findInvitationStaffId(HASH, expiresAt)).resolves.toBeUndefined();
      });

      it('answers undefined for an invitation replaced by a newer one', async () => {
        await invite();
        await repo.expireInvitations(ADMIN_ID, now);
        await invite({ id: '4f0d7a6c-2b8e-4d1f-9a5b-6e9c0d1e2f3a', tokenHash: 'c'.repeat(64) });
        await expect(repo.findInvitationStaffId(HASH, now)).resolves.toBeUndefined();
        await expect(repo.findInvitationStaffId('c'.repeat(64), now)).resolves.toBe(ADMIN_ID);
      });
    });
  });

  describe('sessions', () => {
    const S1 = '5a1e8b7d-3c9f-4e2a-8b6c-7f0d1e2f3a4b';
    const S2 = '6b2f9c8e-4d0a-4f3b-9c7d-8a1e2f3a4b5c';
    const OTHER_S = '7c3a0d9f-5e1b-4a4c-8d8e-9b2f3a4b5c6d';
    const revokedAt = new Date('2026-11-04T12:00:00.000Z');
    // Sessions are created by staff login (later PR); here they are set up directly.
    const session = (id: string, staffId: string, hash: string) =>
      db('staff_sessions').insert({
        id,
        staff_id: staffId,
        refresh_token_hash: hash.repeat(64),
        expires_at: new Date('2026-11-04T18:00:00.000Z'),
        created_at: at,
      });
    const revokedIds = async () =>
      (await db('staff_sessions').whereNotNull('revoked_at').orderBy('id').pluck('id')) as string[];

    beforeEach(async () => {
      await repo.insert(staff());
      await repo.insert(staff({ id: OTHER_ID, email: 'other@test.com' }));
      await session(S1, ADMIN_ID, 'd');
      await session(S2, ADMIN_ID, 'e');
      await session(OTHER_S, OTHER_ID, 'f');
    });

    it('revokes all active sessions of one staff member', async () => {
      await repo.revokeSessions(ADMIN_ID, revokedAt);
      await expect(revokedIds()).resolves.toEqual([S1, S2]);
    });

    it('can keep one session (the current one) active', async () => {
      await repo.revokeSessions(ADMIN_ID, revokedAt, { except: S1 });
      await expect(revokedIds()).resolves.toEqual([S2]);
    });
  });

  it('activate sets ACTIVE and the hash, and resets failed attempts and the lockout', async () => {
    await repo.insert(staff());
    await db('staff')
      .where({ id: ADMIN_ID })
      .update({ failed_login_attempts: 4, locked_until: new Date('2030-01-01T00:00:00.000Z') });
    const later = new Date('2026-11-05T10:00:00.456Z');

    await repo.activate(ADMIN_ID, 'argon-hash', later);

    await expect(repo.findById(ADMIN_ID)).resolves.toMatchObject({
      status: StaffStatus.ACTIVE,
      passwordHash: 'argon-hash',
      failedLoginAttempts: 0,
      lockedUntil: null,
      updatedAt: later,
    });
  });
});
