import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';
import type { PinoLogger } from 'nestjs-pino';
import { StaffRole } from './permissions.js';
import { StaffStatus } from './staff.model.js';
import {
  type NewInvitation,
  type NewStaff,
  type StaffRecord,
  type StaffRepository,
  InsertStaffResult,
} from './staff.repository.js';
import { StaffService } from './staff.service.js';

const ADMIN_ID = '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b';
const SUPPORT_ID = '1c7a4d3f-9e5b-4a8c-8d2e-3b6f7a8b9c0d';
const NOW = new Date('2026-11-05T10:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

interface Revocation {
  staffId: string;
  at: Date;
}

/** In-memory StaffRepository: same methods, same rules (email unique, case-insensitive). */
class FakeStaffRepository {
  readonly records = new Map<string, StaffRecord>();
  readonly invitations: (NewInvitation & { expired?: Date })[] = [];
  readonly revocations: Revocation[] = [];
  /** Lock, read and write calls in order, to check the locking protocol. */
  readonly calls: string[] = [];

  seed(id: string, overrides: Partial<StaffRecord> = {}): void {
    this.records.set(id, {
      id,
      email: `${id}@test.com`,
      role: StaffRole.SUPPORT,
      status: StaffStatus.ACTIVE,
      passwordHash: 'hash',
      failedLoginAttempts: 0,
      lockedUntil: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    });
  }

  insert(staff: NewStaff): Promise<InsertStaffResult> {
    const taken = [...this.records.values()].some((r) => r.email === staff.email);
    if (taken) return Promise.resolve(InsertStaffResult.EmailTaken);
    this.records.set(staff.id, {
      id: staff.id,
      email: staff.email,
      role: staff.role,
      status: StaffStatus.INVITED,
      passwordHash: null,
      failedLoginAttempts: 0,
      lockedUntil: null,
      createdAt: staff.createdAt,
      updatedAt: staff.createdAt,
    });
    return Promise.resolve(InsertStaffResult.Created);
  }

  findById(id: string): Promise<StaffRecord | undefined> {
    this.calls.push('findById');
    return Promise.resolve(this.find(id));
  }

  lockById(id: string): Promise<StaffRecord | undefined> {
    this.calls.push('lockById');
    return Promise.resolve(this.find(id));
  }

  /** Ids match in any case, as the MySQL id column does (case-insensitive collation). */
  private find(id: string): StaffRecord | undefined {
    return [...this.records.values()].find((r) => r.id.toLowerCase() === id.toLowerCase());
  }

  list(): Promise<StaffRecord[]> {
    return Promise.resolve([...this.records.values()]);
  }

  update(id: string, patch: { role?: StaffRole; status?: StaffStatus }, at: Date): Promise<void> {
    this.calls.push('update');
    const record = this.records.get(id);
    if (record) this.records.set(id, { ...record, ...patch, updatedAt: at });
    return Promise.resolve();
  }

  lockActiveAdminIds(): Promise<string[]> {
    this.calls.push('lockActiveAdminIds');
    const ids = [...this.records.values()]
      .filter((r) => r.role === StaffRole.ADMIN && r.status === StaffStatus.ACTIVE)
      .map((r) => r.id)
      .sort();
    return Promise.resolve(ids);
  }

  revokeSessions(staffId: string, at: Date): Promise<void> {
    this.calls.push('revokeSessions');
    this.revocations.push({ staffId, at });
    return Promise.resolve();
  }

  insertInvitation(invitation: NewInvitation): Promise<void> {
    this.invitations.push({ ...invitation });
    return Promise.resolve();
  }

  expireInvitations(staffId: string, at: Date): Promise<void> {
    this.calls.push('expireInvitations');
    for (const invitation of this.invitations) {
      if (invitation.staffId === staffId && !invitation.expired) invitation.expired = at;
    }
    return Promise.resolve();
  }

  transaction<T>(work: (tx: this) => Promise<T>): Promise<T> {
    return work(this);
  }
}

function setup() {
  const repo = new FakeStaffRepository();
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), setContext: jest.fn() };
  const service = new StaffService(
    repo as unknown as StaffRepository,
    logger as unknown as PinoLogger,
  );
  return { service, repo, logger };
}

async function graphqlErrorOf(promise: Promise<unknown>): Promise<GraphQLError> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(GraphQLError);
  return error as GraphQLError;
}

describe('StaffService.invite', () => {
  it('creates an INVITED member with a 48-hour invitation', async () => {
    const { service, repo } = setup();
    const member = await service.invite(
      ADMIN_ID,
      { email: 'New@Test.com', role: StaffRole.SUPPORT },
      NOW,
    );

    expect(member).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      email: 'new@test.com',
      role: StaffRole.SUPPORT,
      status: StaffStatus.INVITED,
      createdAt: NOW,
    });
    expect(repo.invitations).toEqual([
      {
        id: expect.any(String),
        staffId: member.id,
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        expiresAt: new Date(NOW.getTime() + 48 * HOUR_MS),
        createdAt: NOW,
      },
    ]);
  });

  it('answers STAFF_ALREADY_EXISTS for an email taken in another case', async () => {
    const { service, repo } = setup();
    await service.invite(ADMIN_ID, { email: 'taken@test.com', role: StaffRole.SUPPORT }, NOW);
    const error = await graphqlErrorOf(
      service.invite(ADMIN_ID, { email: 'TAKEN@test.com', role: StaffRole.FINANCE }, NOW),
    );
    expect(error.message).toBe('Staff member with this email already exists');
    expect(error.extensions).toEqual({ code: 'STAFF_ALREADY_EXISTS' });
    expect(repo.records.size).toBe(1);
    expect(repo.invitations).toHaveLength(1);
  });

  it('rejects an invalid email with BAD_USER_INPUT on field email, before touching the repository', async () => {
    const { service, repo } = setup();
    const error = await graphqlErrorOf(
      service.invite(ADMIN_ID, { email: 'not-an-email', role: StaffRole.SUPPORT }, NOW),
    );
    expect(error.extensions).toEqual({ code: 'BAD_USER_INPUT', field: 'email' });
    expect(repo.records.size).toBe(0);
  });

  it('logs an audit line with actor, action, staff id and role, but not the email', async () => {
    const { service, logger } = setup();
    const member = await service.invite(
      ADMIN_ID,
      { email: 'new@test.com', role: StaffRole.FINANCE },
      NOW,
    );

    expect(logger.info).toHaveBeenCalledWith(
      { audit: 'staff.invite', actorId: ADMIN_ID, staffId: member.id, role: StaffRole.FINANCE },
      'staff action',
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('new@test.com');
  });
});

describe('StaffService.resendInvitation', () => {
  it('answers NOT_INVITED for a member who is already active', async () => {
    const { service, repo } = setup();
    repo.seed(SUPPORT_ID, { status: StaffStatus.ACTIVE });
    const error = await graphqlErrorOf(service.resendInvitation(ADMIN_ID, SUPPORT_ID, NOW));
    expect(error.message).toBe('Staff member is not in the invited status');
    expect(error.extensions).toEqual({ code: 'NOT_INVITED' });
    expect(repo.invitations).toHaveLength(0);
  });

  it('answers STAFF_NOT_FOUND for an unknown staff id', async () => {
    const { service } = setup();
    const error = await graphqlErrorOf(service.resendInvitation(ADMIN_ID, SUPPORT_ID, NOW));
    expect(error.extensions).toEqual({ code: 'STAFF_NOT_FOUND' });
  });

  it('reads the invited member through lockById, before expiring the old invitation', async () => {
    const { service, repo } = setup();
    repo.seed(SUPPORT_ID, { status: StaffStatus.INVITED });
    await service.resendInvitation(ADMIN_ID, SUPPORT_ID, NOW);

    expect(repo.calls).toEqual(['lockById', 'expireInvitations']);
  });

  it('expires the old invitation and adds a new valid one', async () => {
    const { service, repo } = setup();
    const { id } = await service.invite(
      ADMIN_ID,
      { email: 'new@test.com', role: StaffRole.SUPPORT },
      NOW,
    );
    const resentAt = new Date(NOW.getTime() + HOUR_MS);

    const member = await service.resendInvitation(ADMIN_ID, id, resentAt);

    expect(member).toEqual({
      id,
      email: 'new@test.com',
      role: StaffRole.SUPPORT,
      status: StaffStatus.INVITED,
      createdAt: NOW,
    });
    expect(repo.invitations).toHaveLength(2);
    const [previous, fresh] = repo.invitations;
    expect(previous.expired).toEqual(resentAt);
    expect(fresh.staffId).toBe(id);
    expect(fresh.createdAt).toEqual(resentAt);
    expect(fresh.expiresAt).toEqual(new Date(resentAt.getTime() + 48 * HOUR_MS));
    expect(fresh.tokenHash).not.toBe(previous.tokenHash);
  });
});

describe('StaffService.deactivate', () => {
  const DEV_ACTOR_ID = '9e4d2a1b-7c3f-4b8e-a6d5-0f1e2d3c4b5a';

  it('refuses to deactivate the caller themselves', async () => {
    const { service, repo } = setup();
    repo.seed(ADMIN_ID, { role: StaffRole.ADMIN });
    repo.seed(SUPPORT_ID, { role: StaffRole.ADMIN });
    const error = await graphqlErrorOf(service.deactivate(ADMIN_ID, ADMIN_ID, NOW));
    expect(error.extensions).toEqual({ code: 'CANNOT_DEACTIVATE_SELF' });
    expect(repo.records.get(ADMIN_ID)?.status).toBe(StaffStatus.ACTIVE);
    expect(repo.revocations).toHaveLength(0);
  });

  it('refuses to deactivate the last active admin', async () => {
    const { service, repo } = setup();
    repo.seed(ADMIN_ID, { role: StaffRole.ADMIN });
    repo.seed(SUPPORT_ID, { role: StaffRole.SUPPORT });
    const error = await graphqlErrorOf(service.deactivate(DEV_ACTOR_ID, ADMIN_ID, NOW));
    expect(error.message).toBe('The last active admin cannot be deactivated or demoted');
    expect(error.extensions).toEqual({ code: 'LAST_ADMIN' });
    expect(repo.records.get(ADMIN_ID)?.status).toBe(StaffStatus.ACTIVE);
    expect(repo.revocations).toHaveLength(0);
  });

  it('deactivates an admin while another active admin exists, and revokes their sessions', async () => {
    const { service, repo, logger } = setup();
    repo.seed(ADMIN_ID, { role: StaffRole.ADMIN });
    repo.seed(SUPPORT_ID, { role: StaffRole.ADMIN });
    const member = await service.deactivate(DEV_ACTOR_ID, ADMIN_ID, NOW);

    expect(member).toEqual({
      id: ADMIN_ID,
      email: `${ADMIN_ID}@test.com`,
      role: StaffRole.ADMIN,
      status: StaffStatus.DEACTIVATED,
      createdAt: NOW,
    });
    expect(repo.records.get(ADMIN_ID)?.status).toBe(StaffStatus.DEACTIVATED);
    expect(repo.revocations).toEqual([{ staffId: ADMIN_ID, at: NOW }]);
    expect(logger.info).toHaveBeenCalledWith(
      { audit: 'staff.deactivate', actorId: DEV_ACTOR_ID, staffId: ADMIN_ID },
      'staff action',
    );
  });

  it('answers the member unchanged and writes no audit line when already deactivated', async () => {
    const { service, repo, logger } = setup();
    repo.seed(SUPPORT_ID, { status: StaffStatus.DEACTIVATED });
    const member = await service.deactivate(DEV_ACTOR_ID, SUPPORT_ID, NOW);

    expect(member).toMatchObject({ id: SUPPORT_ID, status: StaffStatus.DEACTIVATED });
    expect(repo.revocations).toHaveLength(0);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('locks the active admins, then the target, before changing anything', async () => {
    const { service, repo } = setup();
    repo.seed(ADMIN_ID, { role: StaffRole.ADMIN });
    repo.seed(SUPPORT_ID, { role: StaffRole.SUPPORT });
    await service.deactivate(DEV_ACTOR_ID, SUPPORT_ID, NOW);

    expect(repo.calls.slice(0, 2)).toEqual(['lockActiveAdminIds', 'lockById']);
  });

  it('deactivates a member given in upper case, and revokes their sessions by the stored id', async () => {
    const { service, repo } = setup();
    repo.seed(ADMIN_ID, { role: StaffRole.ADMIN });
    repo.seed(SUPPORT_ID, { role: StaffRole.SUPPORT });
    await service.deactivate(DEV_ACTOR_ID, SUPPORT_ID.toUpperCase(), NOW);

    expect(repo.records.get(SUPPORT_ID)?.status).toBe(StaffStatus.DEACTIVATED);
    expect(repo.revocations).toEqual([{ staffId: SUPPORT_ID, at: NOW }]);
  });

  it('refuses the sole admin deactivating their own id in upper case, and changes nothing', async () => {
    const { service, repo } = setup();
    repo.seed(ADMIN_ID, { role: StaffRole.ADMIN });
    const error = await graphqlErrorOf(service.deactivate(ADMIN_ID, ADMIN_ID.toUpperCase(), NOW));
    expect(error.extensions).toEqual({ code: 'CANNOT_DEACTIVATE_SELF' });
    expect(repo.records.get(ADMIN_ID)?.status).toBe(StaffStatus.ACTIVE);
    expect(repo.revocations).toHaveLength(0);
  });

  it('refuses to deactivate the sole active admin given in upper case: LAST_ADMIN', async () => {
    const { service, repo } = setup();
    repo.seed(ADMIN_ID, { role: StaffRole.ADMIN });
    repo.seed(SUPPORT_ID, { role: StaffRole.SUPPORT });
    const error = await graphqlErrorOf(
      service.deactivate(DEV_ACTOR_ID, ADMIN_ID.toUpperCase(), NOW),
    );
    expect(error.extensions).toEqual({ code: 'LAST_ADMIN' });
    expect(repo.records.get(ADMIN_ID)?.status).toBe(StaffStatus.ACTIVE);
    expect(repo.revocations).toHaveLength(0);
  });
});

describe('StaffService.changeRole', () => {
  const DEV_ACTOR_ID = '9e4d2a1b-7c3f-4b8e-a6d5-0f1e2d3c4b5a';

  it('refuses to demote the last active admin', async () => {
    const { service, repo } = setup();
    repo.seed(ADMIN_ID, { role: StaffRole.ADMIN });
    repo.seed(SUPPORT_ID, { role: StaffRole.SUPPORT });
    const error = await graphqlErrorOf(
      service.changeRole(DEV_ACTOR_ID, ADMIN_ID, StaffRole.FINANCE, NOW),
    );
    expect(error.extensions).toEqual({ code: 'LAST_ADMIN' });
    expect(repo.records.get(ADMIN_ID)?.role).toBe(StaffRole.ADMIN);
    expect(repo.revocations).toHaveLength(0);
  });

  it('changes the role of a non-admin and revokes their sessions', async () => {
    const { service, repo, logger } = setup();
    repo.seed(SUPPORT_ID, { role: StaffRole.SUPPORT });
    const member = await service.changeRole(DEV_ACTOR_ID, SUPPORT_ID, StaffRole.FINANCE, NOW);

    expect(member).toEqual({
      id: SUPPORT_ID,
      email: `${SUPPORT_ID}@test.com`,
      role: StaffRole.FINANCE,
      status: StaffStatus.ACTIVE,
      createdAt: NOW,
    });
    expect(repo.records.get(SUPPORT_ID)?.role).toBe(StaffRole.FINANCE);
    expect(repo.revocations).toEqual([{ staffId: SUPPORT_ID, at: NOW }]);
    expect(logger.info).toHaveBeenCalledWith(
      {
        audit: 'staff.changeRole',
        actorId: DEV_ACTOR_ID,
        staffId: SUPPORT_ID,
        from: StaffRole.SUPPORT,
        to: StaffRole.FINANCE,
      },
      'staff action',
    );
  });

  it('keeps the role, revokes nothing and writes no audit line for the same role', async () => {
    const { service, repo, logger } = setup();
    repo.seed(SUPPORT_ID, { role: StaffRole.SUPPORT });
    const member = await service.changeRole(DEV_ACTOR_ID, SUPPORT_ID, StaffRole.SUPPORT, NOW);

    expect(member).toMatchObject({ id: SUPPORT_ID, role: StaffRole.SUPPORT });
    expect(repo.revocations).toHaveLength(0);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('answers STAFF_NOT_FOUND for an unknown staff id', async () => {
    const { service } = setup();
    const error = await graphqlErrorOf(
      service.changeRole(DEV_ACTOR_ID, SUPPORT_ID, StaffRole.FINANCE, NOW),
    );
    expect(error.extensions).toEqual({ code: 'STAFF_NOT_FOUND' });
  });

  it('refuses to demote the sole active admin given in upper case: LAST_ADMIN', async () => {
    const { service, repo } = setup();
    repo.seed(ADMIN_ID, { role: StaffRole.ADMIN });
    repo.seed(SUPPORT_ID, { role: StaffRole.SUPPORT });
    const error = await graphqlErrorOf(
      service.changeRole(DEV_ACTOR_ID, ADMIN_ID.toUpperCase(), StaffRole.FINANCE, NOW),
    );
    expect(error.extensions).toEqual({ code: 'LAST_ADMIN' });
    expect(repo.records.get(ADMIN_ID)?.role).toBe(StaffRole.ADMIN);
    expect(repo.revocations).toHaveLength(0);
  });

  it('locks the active admins, then the target, before changing anything, also for a non-admin', async () => {
    const { service, repo } = setup();
    repo.seed(ADMIN_ID, { role: StaffRole.ADMIN });
    repo.seed(SUPPORT_ID, { role: StaffRole.SUPPORT });
    await service.changeRole(DEV_ACTOR_ID, SUPPORT_ID, StaffRole.FINANCE, NOW);

    expect(repo.calls.slice(0, 2)).toEqual(['lockActiveAdminIds', 'lockById']);
  });
});

describe('StaffService.list', () => {
  it('lists every staff member as a StaffMember, without password data', async () => {
    const { service, repo } = setup();
    repo.seed(ADMIN_ID, { role: StaffRole.ADMIN, passwordHash: 'secret-hash' });
    repo.seed(SUPPORT_ID, { status: StaffStatus.INVITED });

    const members = await service.list();

    expect(members).toEqual([
      {
        id: ADMIN_ID,
        email: `${ADMIN_ID}@test.com`,
        role: StaffRole.ADMIN,
        status: StaffStatus.ACTIVE,
        createdAt: NOW,
      },
      {
        id: SUPPORT_ID,
        email: `${SUPPORT_ID}@test.com`,
        role: StaffRole.SUPPORT,
        status: StaffStatus.INVITED,
        createdAt: NOW,
      },
    ]);
  });
});

describe('StaffService.me', () => {
  it('returns the member with the permissions of their role', async () => {
    const { service, repo } = setup();
    repo.seed(SUPPORT_ID, { role: StaffRole.FINANCE, email: 'finance@test.com' });

    await expect(service.me(SUPPORT_ID)).resolves.toEqual({
      id: SUPPORT_ID,
      email: 'finance@test.com',
      role: StaffRole.FINANCE,
      permissions: ['bo', 'bo:settings', 'bo:settings:modify'],
    });
  });

  it('answers STAFF_NOT_FOUND for an unknown staff id', async () => {
    const { service } = setup();
    const error = await graphqlErrorOf(service.me(SUPPORT_ID));
    expect(error.extensions).toEqual({ code: 'STAFF_NOT_FOUND' });
  });
});

describe('StaffService.deactivate of an invited member', () => {
  const DEV_ACTOR_ID = '9e4d2a1b-7c3f-4b8e-a6d5-0f1e2d3c4b5a';

  it('expires the pending invitation so its link stops working', async () => {
    const { service, repo } = setup();
    const { id } = await service.invite(
      DEV_ACTOR_ID,
      { email: 'new@test.com', role: StaffRole.SUPPORT },
      NOW,
    );
    const deactivatedAt = new Date(NOW.getTime() + HOUR_MS);

    await service.deactivate(DEV_ACTOR_ID, id, deactivatedAt);

    expect(repo.invitations).toHaveLength(1);
    expect(repo.invitations[0].staffId).toBe(id);
    expect(repo.invitations[0].expired).toEqual(deactivatedAt);
  });
});

describe('StaffService audit lines for resend and demotion', () => {
  const DEV_ACTOR_ID = '9e4d2a1b-7c3f-4b8e-a6d5-0f1e2d3c4b5a';

  it('logs the resend with actor and staff id, but not the email', async () => {
    const { service, logger } = setup();
    const { id } = await service.invite(
      DEV_ACTOR_ID,
      { email: 'new@test.com', role: StaffRole.SUPPORT },
      NOW,
    );
    logger.info.mockClear();

    await service.resendInvitation(DEV_ACTOR_ID, id, NOW);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { audit: 'staff.resendInvitation', actorId: DEV_ACTOR_ID, staffId: id },
      'staff action',
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('new@test.com');
  });

  it('demotes an active admin while another active admin exists, revokes sessions and logs from/to', async () => {
    const { service, repo, logger } = setup();
    repo.seed(ADMIN_ID, { role: StaffRole.ADMIN });
    repo.seed(SUPPORT_ID, { role: StaffRole.ADMIN });

    const member = await service.changeRole(ADMIN_ID, SUPPORT_ID, StaffRole.FINANCE, NOW);

    expect(member).toMatchObject({
      id: SUPPORT_ID,
      role: StaffRole.FINANCE,
      status: StaffStatus.ACTIVE,
    });
    expect(repo.records.get(SUPPORT_ID)?.role).toBe(StaffRole.FINANCE);
    expect(repo.revocations).toEqual([{ staffId: SUPPORT_ID, at: NOW }]);
    expect(logger.info).toHaveBeenCalledWith(
      {
        audit: 'staff.changeRole',
        actorId: ADMIN_ID,
        staffId: SUPPORT_ID,
        from: StaffRole.ADMIN,
        to: StaffRole.FINANCE,
      },
      'staff action',
    );
  });
});
