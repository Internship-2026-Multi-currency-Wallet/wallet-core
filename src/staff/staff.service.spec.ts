import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { verify } from '@node-rs/argon2';
import { GraphQLError } from 'graphql';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { EmailService, type EmailTemplate, type EmailTemplates } from '../email/email.service.js';
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
  readonly invitations: (NewInvitation & { expired?: Date; used?: Date })[] = [];
  /** Runs once, after the first findInvitationStaffId: lets a test commit a concurrent change. */
  afterFirstFind: (() => Promise<void>) | undefined;
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

  lockAdminIds(): Promise<string[]> {
    this.calls.push('lockAdminIds');
    const ids = [...this.records.values()]
      .filter((r) => r.role === StaffRole.ADMIN)
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

  async findInvitationStaffId(tokenHash: string): Promise<string | undefined> {
    this.calls.push('findInvitationStaffId');
    const found = this.invitations.find((i) => i.tokenHash === tokenHash)?.staffId;
    const hook = this.afterFirstFind;
    this.afterFirstFind = undefined;
    await hook?.();
    return found;
  }

  consumeInvitation(tokenHash: string, at: Date): Promise<string | null> {
    this.calls.push('consumeInvitation');
    const invitation = this.invitations.find((i) => i.tokenHash === tokenHash);
    const expiresAt = invitation?.expired ?? invitation?.expiresAt;
    if (!invitation || invitation.used || expiresAt! <= at) return Promise.resolve(null);
    invitation.used = at;
    return Promise.resolve(invitation.staffId);
  }

  activate(id: string, passwordHash: string, at: Date): Promise<void> {
    this.calls.push('activate');
    const record = this.records.get(id);
    if (record) {
      this.records.set(id, {
        ...record,
        status: StaffStatus.ACTIVE,
        passwordHash,
        failedLoginAttempts: 0,
        lockedUntil: null,
        updatedAt: at,
      });
    }
    return Promise.resolve();
  }

  /** True while a transaction callback runs, to check that nothing is sent inside it. */
  inTransaction = false;

  async transaction<T>(work: (tx: this) => Promise<T>): Promise<T> {
    this.inTransaction = true;
    try {
      return await work(this);
    } finally {
      this.inTransaction = false;
    }
  }
}

type EmailMessage = {
  template: EmailTemplate;
  to: string;
  data: EmailTemplates['staffInvitation'];
};

class RecordingEmailService extends EmailService {
  readonly sent: (EmailMessage & { duringTransaction: boolean })[] = [];
  failWith: (() => Promise<void>) | undefined;

  constructor(private readonly repo: FakeStaffRepository) {
    super();
  }

  send<T extends EmailTemplate>(template: T, to: string, data: EmailTemplates[T]): Promise<void> {
    this.sent.push({
      template,
      to,
      data: data as EmailMessage['data'],
      duringTransaction: this.repo.inTransaction,
    });
    return this.failWith ? this.failWith() : Promise.resolve();
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenOf = (message: EmailMessage) => new URL(message.data.link).searchParams.get('token')!;

function setup(backofficeUrl = 'https://bo.test', config?: AppConfig) {
  const repo = new FakeStaffRepository();
  const email = new RecordingEmailService(repo);
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), setContext: jest.fn() };
  const service = new StaffService(
    repo as unknown as StaffRepository,
    logger as unknown as PinoLogger,
    email,
    config ?? ({ backofficeUrl } as AppConfig),
  );
  return { service, repo, logger, email };
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

  it('answers NOT_INVITED, rotating nothing, when the member has another role than expected', async () => {
    const { service, repo } = setup();
    const { id } = await service.invite(
      ADMIN_ID,
      { email: 'new@test.com', role: StaffRole.SUPPORT },
      NOW,
    );

    const error = await graphqlErrorOf(
      service.resendInvitationWithLink(ADMIN_ID, id, NOW, StaffRole.ADMIN),
    );

    expect(error.extensions).toEqual({ code: 'NOT_INVITED' });
    expect(repo.invitations).toHaveLength(1);
    expect(repo.invitations[0].expired).toBeUndefined();
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

describe('StaffService invitation emails', () => {
  const NEW = { email: 'New@Test.com', role: StaffRole.SUPPORT };

  it('invite sends one staffInvitation email to the normalized address with a link to the stored token', async () => {
    const { service, repo, email } = setup();
    await service.invite(ADMIN_ID, NEW, NOW);

    expect(email.sent).toHaveLength(1);
    const [message] = email.sent;
    expect(message.template).toBe('staffInvitation');
    expect(message.to).toBe('new@test.com');
    expect(message.data.link).toMatch(/^https:\/\/bo\.test\/accept-invitation\?token=[\w-]{43}$/);
    expect(sha256(tokenOf(message))).toBe(repo.invitations[0].tokenHash);
  });

  it('resend sends one email with a new token whose hash is stored, expiring the previous invitation', async () => {
    const { service, repo, email } = setup();
    const { id } = await service.invite(ADMIN_ID, NEW, NOW);
    const resentAt = new Date(NOW.getTime() + HOUR_MS);
    await service.resendInvitation(ADMIN_ID, id, resentAt);

    expect(email.sent).toHaveLength(2);
    const [first, second] = email.sent;
    expect(second.to).toBe('new@test.com');
    expect(tokenOf(second)).not.toBe(tokenOf(first));
    expect(sha256(tokenOf(second))).toBe(repo.invitations[1].tokenHash);
    expect(repo.invitations[0].expired).toEqual(resentAt);
  });

  it.each([
    [
      'throws',
      () => {
        throw new Error('smtp down to new@test.com');
      },
    ],
    ['rejects', () => Promise.reject(new Error('smtp down'))],
  ])(
    'a sender that %s does not fail invite or resend, and is logged without email or token',
    async (_how, fail) => {
      const { service, repo, logger, email } = setup();
      email.failWith = fail;

      const member = await service.invite(ADMIN_ID, NEW, NOW);
      expect(member.status).toBe(StaffStatus.INVITED);
      expect(repo.invitations).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error), staffId: member.id },
        'invitation email failed',
      );

      const resent = await service.resendInvitation(ADMIN_ID, member.id, NOW);
      expect(resent.id).toBe(member.id);
      expect(repo.invitations).toHaveLength(2);
      expect(logger.warn).toHaveBeenCalledTimes(2);
      const fields = logger.warn.mock.calls.map(([f]) => f) as object[];
      for (const field of fields) expect(Object.keys(field).sort()).toEqual(['err', 'staffId']);
      for (const message of email.sent)
        expect(JSON.stringify(fields)).not.toContain(tokenOf(message));
      expect(JSON.stringify(fields.map((f) => Object.keys(f)))).not.toContain('new@test.com');
    },
  );

  it('sends after the transaction commits, once, even when the callback is retried', async () => {
    const { service, repo, email } = setup();
    const original = repo.transaction.bind(repo);
    repo.transaction = async <T>(work: (tx: FakeStaffRepository) => Promise<T>) => {
      await original(async (tx) => {
        await work(tx);
        throw new Error('deadlock');
      }).catch(() => undefined);
      repo.records.clear();
      repo.invitations.length = 0;
      return original(work);
    };
    await service.invite(ADMIN_ID, NEW, NOW);

    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].duringTransaction).toBe(false);
    expect(repo.invitations).toHaveLength(1);
    expect(sha256(tokenOf(email.sent[0]))).toBe(repo.invitations[0].tokenHash);
  });

  it('sends nothing when the email is already taken', async () => {
    const { service, email } = setup();
    await service.invite(ADMIN_ID, NEW, NOW);
    email.sent.length = 0;
    await graphqlErrorOf(service.invite(ADMIN_ID, { ...NEW, email: 'new@test.com' }, NOW));
    expect(email.sent).toHaveLength(0);
  });

  it.each([StaffStatus.ACTIVE, StaffStatus.DEACTIVATED])(
    'resend to a %s member sends nothing',
    async (status) => {
      const { service, repo, email } = setup();
      repo.seed(SUPPORT_ID, { status });
      const error = await graphqlErrorOf(service.resendInvitation(ADMIN_ID, SUPPORT_ID, NOW));
      expect(error.extensions).toEqual({ code: 'NOT_INVITED' });
      expect(email.sent).toHaveLength(0);
    },
  );

  it.each([
    ['https://bo.test', 'https://bo.test/accept-invitation?token='],
    ['https://bo.test/', 'https://bo.test/accept-invitation?token='],
    ['https://bo.test///', 'https://bo.test/accept-invitation?token='],
  ])('builds the link from BACKOFFICE_URL %s with one slash', async (configured, prefix) => {
    const { service, email } = setup(undefined, AppConfig.fromEnv({ BACKOFFICE_URL: configured }));
    await service.invite(ADMIN_ID, NEW, NOW);
    expect(email.sent[0].data.link.startsWith(prefix)).toBe(true);
  });

  it('puts only the link in the email data and the token in no log line', async () => {
    const { service, logger, email } = setup();
    const { id } = await service.invite(ADMIN_ID, NEW, NOW);
    await service.resendInvitation(ADMIN_ID, id, NOW);

    for (const message of email.sent) {
      expect(Object.keys(message.data)).toEqual(['link']);
      const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
      expect(logged).not.toContain(tokenOf(message));
    }
  });
});

describe('StaffService.inviteFirstAdmin', () => {
  it('answers undefined and changes nothing when an admin appeared before the insert', async () => {
    const { service, repo, logger, email } = setup();
    repo.seed(SUPPORT_ID, { role: StaffRole.ADMIN, status: StaffStatus.INVITED });

    const result = await service.inviteFirstAdmin(ADMIN_ID, 'late@test.com', NOW);

    expect(result).toBeUndefined();
    expect(repo.records.size).toBe(1);
    expect(repo.invitations).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('invites an ADMIN like inviteWithLink: one invitation, one email after the commit, one audit line', async () => {
    const { service, repo, logger, email } = setup();

    const result = await service.inviteFirstAdmin(ADMIN_ID, 'First@Test.com', NOW);

    expect(result?.member).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      email: 'first@test.com',
      role: StaffRole.ADMIN,
      status: StaffStatus.INVITED,
      createdAt: NOW,
    });
    expect(repo.calls[0]).toBe('lockAdminIds');
    expect(repo.invitations).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ to: 'first@test.com', duringTransaction: false });
    expect(result?.link).toBe(email.sent[0].data.link);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      {
        audit: 'staff.invite',
        actorId: ADMIN_ID,
        staffId: result?.member.id,
        role: StaffRole.ADMIN,
      },
      'staff action',
    );
  });

  it('still answers STAFF_ALREADY_EXISTS for an email taken by a non-admin', async () => {
    const { service, repo } = setup();
    repo.seed(SUPPORT_ID, { email: 'taken@test.com' });

    const error = await graphqlErrorOf(service.inviteFirstAdmin(ADMIN_ID, 'taken@test.com', NOW));

    expect(error.extensions).toEqual({ code: 'STAFF_ALREADY_EXISTS' });
  });
});

describe('StaffService.acceptInvitation', () => {
  const TOKEN = 'known-token';
  const PASSWORD = 'Str0ng!Passw0rd';
  const INVALID = 'Invitation link is invalid or has expired';

  function invited() {
    const ctx = setup();
    ctx.repo.seed(SUPPORT_ID, {
      status: StaffStatus.INVITED,
      passwordHash: null,
      email: 'secret.person@test.com',
    });
    ctx.repo.invitations.push({
      id: 'inv-1',
      staffId: SUPPORT_ID,
      tokenHash: sha256(TOKEN),
      expiresAt: new Date(NOW.getTime() + 48 * HOUR_MS),
      createdAt: NOW,
    });
    return ctx;
  }

  it('activates the member with an argon2 hash of the password and logs an audit line', async () => {
    const { service, repo, logger } = invited();
    await service.acceptInvitation({ token: TOKEN, password: PASSWORD }, () => NOW);

    const record = repo.records.get(SUPPORT_ID)!;
    expect(record.status).toBe(StaffStatus.ACTIVE);
    await expect(verify(record.passwordHash!, PASSWORD)).resolves.toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      { audit: 'staff.acceptInvitation', actorId: SUPPORT_ID, staffId: SUPPORT_ID },
      'staff action',
    );
  });

  it('refuses the same token a second time', async () => {
    const { service } = invited();
    await service.acceptInvitation({ token: TOKEN, password: PASSWORD }, () => NOW);
    const error = await graphqlErrorOf(
      service.acceptInvitation({ token: TOKEN, password: 'An0ther!Passw0rd' }, () => NOW),
    );
    expect(error.extensions).toEqual({ code: 'INVALID_INVITATION' });
  });

  it('refuses a token after 48 hours, but accepts it just before', async () => {
    const { service } = invited();
    const expiry = NOW.getTime() + 48 * HOUR_MS;
    const error = await graphqlErrorOf(
      service.acceptInvitation({ token: TOKEN, password: PASSWORD }, () => new Date(expiry + 1)),
    );
    expect(error.extensions).toEqual({ code: 'INVALID_INVITATION' });
    await expect(
      service.acceptInvitation({ token: TOKEN, password: PASSWORD }, () => new Date(expiry - 1)),
    ).resolves.toBeUndefined();
  });

  it('refuses the token from before a resend, and accepts the new one', async () => {
    const { service, repo, email } = invited();
    const later = new Date(NOW.getTime() + HOUR_MS);
    await service.resendInvitationWithLink(ADMIN_ID, SUPPORT_ID, later);
    const newToken = tokenOf(email.sent[0]);

    const error = await graphqlErrorOf(
      service.acceptInvitation({ token: TOKEN, password: PASSWORD }, () => later),
    );
    expect(error.extensions).toEqual({ code: 'INVALID_INVITATION' });
    await service.acceptInvitation({ token: newToken, password: PASSWORD }, () => later);
    expect(repo.records.get(SUPPORT_ID)!.status).toBe(StaffStatus.ACTIVE);
  });

  it('answers one identical message for unknown, malformed, deactivated and used tokens, locking nothing for unknown ones', async () => {
    const { service, repo } = invited();
    const messages: string[] = [];
    for (const token of ['unknown', '', 'x'.repeat(100_000)]) {
      const error = await graphqlErrorOf(
        service.acceptInvitation({ token, password: PASSWORD }, () => NOW),
      );
      expect(error.extensions).toEqual({ code: 'INVALID_INVITATION' });
      messages.push(error.message);
    }
    expect(repo.calls).not.toContain('lockById');

    repo.seed(SUPPORT_ID, { status: StaffStatus.DEACTIVATED, passwordHash: null });
    const deactivated = await graphqlErrorOf(
      service.acceptInvitation({ token: TOKEN, password: PASSWORD }, () => NOW),
    );
    expect(deactivated.extensions).toEqual({ code: 'INVALID_INVITATION' });
    messages.push(deactivated.message);

    expect(new Set(messages)).toEqual(new Set([INVALID]));
  });

  it('answers INVALID_INVITATION, not STAFF_NOT_FOUND, when the staff row is gone', async () => {
    const { service, repo } = invited();
    repo.records.clear();
    const error = await graphqlErrorOf(
      service.acceptInvitation({ token: TOKEN, password: PASSWORD }, () => NOW),
    );
    expect(error.extensions).toEqual({ code: 'INVALID_INVITATION' });
  });

  it.each([
    ['a weak password', 'weak'],
    ['a password over 128 characters', `Aa1!${'a'.repeat(125)}`],
  ])(
    'rejects %s with BAD_USER_INPUT on field password and keeps the invitation',
    async (_name, password) => {
      const { service, repo } = invited();
      const error = await graphqlErrorOf(
        service.acceptInvitation({ token: TOKEN, password }, () => NOW),
      );
      expect(error.extensions).toEqual({ code: 'BAD_USER_INPUT', field: 'password' });
      expect(repo.calls).toEqual([]);
      await service.acceptInvitation({ token: TOKEN, password: PASSWORD }, () => NOW);
      expect(repo.records.get(SUPPORT_ID)!.status).toBe(StaffStatus.ACTIVE);
    },
  );

  it('takes the time after the locks, so a resend committed meanwhile wins', async () => {
    const { service, repo } = invited();
    const later = new Date(NOW.getTime() + HOUR_MS);
    repo.afterFirstFind = async () => {
      await service.resendInvitationWithLink(ADMIN_ID, SUPPORT_ID, later);
      repo.calls.length = 0;
    };
    const clock = jest.fn(() => {
      repo.calls.push('clock');
      return later;
    });

    const error = await graphqlErrorOf(
      service.acceptInvitation({ token: TOKEN, password: PASSWORD }, clock),
    );
    expect(error.extensions).toEqual({ code: 'INVALID_INVITATION' });
    expect(repo.calls.slice(0, 4)).toEqual([
      'findInvitationStaffId',
      'lockActiveAdminIds',
      'lockById',
      'clock',
    ]);
    expect(repo.records.get(SUPPORT_ID)!.status).toBe(StaffStatus.INVITED);
  });

  it('puts neither token, hash, email nor password into logs or error data', async () => {
    const { service, logger } = invited();
    const failure = await graphqlErrorOf(
      service.acceptInvitation({ token: 'unknown', password: PASSWORD }, () => NOW),
    );
    await service.acceptInvitation({ token: TOKEN, password: PASSWORD }, () => NOW);

    const seen = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
      logger.error.mock.calls,
      failure.message,
      failure.extensions,
    ]);
    for (const secret of [TOKEN, sha256(TOKEN), 'unknown', 'secret.person@test.com', PASSWORD]) {
      expect(seen).not.toContain(secret);
    }
  });
});
