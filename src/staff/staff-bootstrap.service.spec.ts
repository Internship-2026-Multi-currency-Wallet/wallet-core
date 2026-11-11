import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import type { TokenService } from '../auth/tokens.js';
import type { AppConfig } from '../config/app-config.js';
import { FakeEmailService, type SentEmail } from '../email/fake-email.service.js';
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
import { StaffBootstrapService } from './staff-bootstrap.service.js';

const NOW = new Date('2026-11-05T10:00:00.000Z');
const LATER = new Date('2026-11-10T10:00:00.000Z');
const EXISTING_ID = '1c7a4d3f-9e5b-4a8c-8d2e-3b6f7a8b9c0d';

/** In-memory StaffRepository with the methods the bootstrap uses; emails are unique. */
class FakeRepo {
  readonly records = new Map<string, StaffRecord>();
  readonly invitations: (NewInvitation & { expired?: Date })[] = [];
  reads = 0;
  failWith: Error | undefined;

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

  private touch(): void {
    this.reads += 1;
    if (this.failWith) throw this.failWith;
  }

  anyAdminExists(): Promise<boolean> {
    this.touch();
    return Promise.resolve([...this.records.values()].some((r) => r.role === StaffRole.ADMIN));
  }

  lockAdminIds(): Promise<string[]> {
    return Promise.resolve(
      [...this.records.values()].filter((r) => r.role === StaffRole.ADMIN).map((r) => r.id),
    );
  }

  findByEmail(email: string): Promise<StaffRecord | undefined> {
    this.touch();
    return Promise.resolve([...this.records.values()].find((r) => r.email === email));
  }

  lockById(id: string): Promise<StaffRecord | undefined> {
    return Promise.resolve(this.records.get(id));
  }

  insert(staff: NewStaff): Promise<InsertStaffResult> {
    if ([...this.records.values()].some((r) => r.email === staff.email)) {
      return Promise.resolve(InsertStaffResult.EmailTaken);
    }
    this.seed(staff.id, {
      email: staff.email,
      role: staff.role,
      status: StaffStatus.INVITED,
      passwordHash: null,
      createdAt: staff.createdAt,
    });
    return Promise.resolve(InsertStaffResult.Created);
  }

  insertInvitation(invitation: NewInvitation): Promise<void> {
    this.invitations.push({ ...invitation });
    return Promise.resolve();
  }

  expireInvitations(staffId: string, at: Date): Promise<void> {
    for (const i of this.invitations) {
      if (i.staffId === staffId && !i.expired) i.expired = at;
    }
    return Promise.resolve();
  }

  async transaction<T>(work: (tx: this) => Promise<T>): Promise<T> {
    return work(this);
  }
}

function setup(bootstrapAdminEmail?: string) {
  const repo = new FakeRepo();
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), setContext: jest.fn() };
  const email = new FakeEmailService(logger as unknown as PinoLogger);
  const sent = email.sent;
  const config = { backofficeUrl: 'https://bo.test', bootstrapAdminEmail } as AppConfig;
  const service = new StaffService(
    repo as unknown as StaffRepository,
    logger as unknown as PinoLogger,
    email,
    config,
    {} as TokenService,
  );
  const bootstrap = new StaffBootstrapService(
    service,
    repo as unknown as StaffRepository,
    config,
    logger as unknown as PinoLogger,
  );
  return { bootstrap, repo, sent, logger };
}

const tokenOf = (m: SentEmail) => new URL(m.data.link).searchParams.get('token')!;
const allLogs = (logger: ReturnType<typeof setup>['logger']) =>
  JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);

describe('StaffBootstrapService.onApplicationBootstrap', () => {
  it('invites one admin with one email and an audit line when no admin exists', async () => {
    const { bootstrap, repo, sent, logger } = setup('admin@test.com');

    await bootstrap.onApplicationBootstrap();

    const members = [...repo.records.values()];
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({
      email: 'admin@test.com',
      role: StaffRole.ADMIN,
      status: StaffStatus.INVITED,
    });
    expect(repo.invitations).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      template: 'staffInvitation',
      to: 'admin@test.com',
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ audit: 'staff.invite', actorId: 'system:bootstrap' }),
      'staff action',
    );
  });

  it('does nothing on a second start while the admin is still invited with an expired link', async () => {
    const { bootstrap, repo, sent } = setup('admin@test.com');
    await bootstrap.onApplicationBootstrap();
    repo.invitations[0].expiresAt = new Date('2000-01-01T00:00:00.000Z');
    sent.length = 0;

    await bootstrap.onApplicationBootstrap();

    expect(repo.records.size).toBe(1);
    expect(repo.invitations).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it('creates nothing, warns without the email, when a non-admin already has that email', async () => {
    const { bootstrap, repo, sent, logger } = setup();
    repo.seed(EXISTING_ID, { email: 'admin@test.com' });

    await expect(bootstrap.bootstrapAdmin('admin@test.com')).resolves.toEqual({
      outcome: 'emailTaken',
    });

    expect(repo.records.size).toBe(1);
    expect(repo.records.get(EXISTING_ID)?.role).toBe(StaffRole.SUPPORT);
    expect(sent).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      {},
      'bootstrap skipped: BOOTSTRAP_ADMIN_EMAIL belongs to a staff member who is not an admin, no admin was invited',
    );
    expect(allLogs(logger)).not.toContain('admin@test.com');
  });

  it('creates nothing, logs without the email, when an admin already exists', async () => {
    const { bootstrap, repo, sent, logger } = setup();
    repo.seed(EXISTING_ID, { role: StaffRole.ADMIN });

    await expect(bootstrap.bootstrapAdmin('admin@test.com')).resolves.toEqual({
      outcome: 'adminExists',
    });

    expect(repo.records.size).toBe(1);
    expect(sent).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith({}, 'bootstrap skipped: an admin already exists');
    expect(allLogs(logger)).not.toContain('admin@test.com');
  });

  it('creates nothing and logs the skip when an admin appears after the pre-check', async () => {
    const { bootstrap, repo, sent, logger } = setup();
    repo.seed(EXISTING_ID, { role: StaffRole.ADMIN });
    repo.anyAdminExists = () => Promise.resolve(false);

    await expect(bootstrap.bootstrapAdmin('admin@test.com')).resolves.toEqual({
      outcome: 'adminExists',
    });

    expect(repo.records.size).toBe(1);
    expect(repo.invitations).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith({}, 'bootstrap skipped: an admin already exists');
    expect(allLogs(logger)).not.toContain('admin@test.com');
  });

  it('does not touch the repository when the env is unset', async () => {
    const { bootstrap, repo, logger } = setup();

    await bootstrap.onApplicationBootstrap();

    expect(repo.reads).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns without the value and creates nothing for an invalid email', async () => {
    const { bootstrap, repo, sent, logger } = setup('not-an-email');

    await expect(bootstrap.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(repo.records.size).toBe(0);
    expect(sent).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(allLogs(logger)).not.toContain('not-an-email');
  });

  it('logs the error and still resolves when the repository fails', async () => {
    const { bootstrap, repo, logger } = setup('admin@test.com');
    const failure = new Error('db down');
    repo.failWith = failure;

    await expect(bootstrap.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith({ err: failure }, expect.any(String));
  });

  it('stores an email with spaces and capitals trimmed and in lower case', async () => {
    const { bootstrap, repo, sent } = setup('  Admin@Test.COM ');

    await bootstrap.onApplicationBootstrap();

    expect([...repo.records.values()][0].email).toBe('admin@test.com');
    expect(sent[0].to).toBe('admin@test.com');
  });

  it('never logs the invitation token or link', async () => {
    const { bootstrap, sent, logger } = setup('admin@test.com');

    await bootstrap.onApplicationBootstrap();

    const logs = allLogs(logger);
    expect(logs).not.toContain(tokenOf(sent[0]));
    expect(logs).not.toContain('accept-invitation');
  });
});

describe('StaffBootstrapService.createAdminOrReissue', () => {
  it('creates the admin and returns the link when no admin exists', async () => {
    const { bootstrap, sent } = setup();

    const result = await bootstrap.createAdminOrReissue('Admin@Test.com', NOW);

    expect(result).toMatchObject({ outcome: 'created', link: sent[0].data.link });
    expect(sent).toHaveLength(1);
  });

  it('re-issues the invitation of an invited admin whose link expired', async () => {
    const { bootstrap, repo, sent } = setup();
    await bootstrap.bootstrapAdmin('admin@test.com', NOW);
    const oldToken = tokenOf(sent[0]);

    const result = await bootstrap.createAdminOrReissue('admin@test.com', LATER);

    expect(result).toMatchObject({ outcome: 'resent', link: sent[1].data.link });
    expect(tokenOf(sent[1])).not.toBe(oldToken);
    expect(repo.invitations).toHaveLength(2);
    expect(repo.invitations[0].expired).toEqual(LATER);
    expect(repo.invitations[1].expired).toBeUndefined();
  });

  it.each([
    ['active admin', { role: StaffRole.ADMIN, status: StaffStatus.ACTIVE }],
    ['deactivated admin', { role: StaffRole.ADMIN, status: StaffStatus.DEACTIVATED }],
    ['invited support', { role: StaffRole.SUPPORT, status: StaffStatus.INVITED }],
  ])('leaves a %s with that email untouched', async (_name, overrides) => {
    const { bootstrap, repo, sent } = setup();
    repo.seed(EXISTING_ID, { email: 'admin@test.com', ...overrides });

    const result = await bootstrap.createAdminOrReissue('admin@test.com', NOW);

    expect(result).toEqual({ outcome: 'emailTaken' });
    expect(repo.records.get(EXISTING_ID)).toMatchObject(overrides);
    expect(repo.invitations).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('changes nothing when another admin exists and nobody has that email', async () => {
    const { bootstrap, repo, sent } = setup();
    repo.seed(EXISTING_ID, { role: StaffRole.ADMIN });

    const result = await bootstrap.createAdminOrReissue('new@test.com', NOW);

    expect(result).toEqual({ outcome: 'adminExists' });
    expect(repo.records.size).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('reports adminExists when an admin appears after the pre-check', async () => {
    const { bootstrap, repo, sent } = setup();
    repo.seed(EXISTING_ID, { role: StaffRole.ADMIN });
    repo.anyAdminExists = () => Promise.resolve(false);

    const result = await bootstrap.createAdminOrReissue('new@test.com', NOW);

    expect(result).toEqual({ outcome: 'adminExists' });
    expect(repo.records.size).toBe(1);
    expect(repo.invitations).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('reports emailTaken when the email is taken between the lookup and the insert', async () => {
    const { bootstrap, repo, sent } = setup();
    const lookup = repo.findByEmail.bind(repo);
    repo.findByEmail = async (email) => {
      const found = await lookup(email);
      repo.seed(EXISTING_ID, { email: 'new@test.com' });
      return found;
    };

    await expect(bootstrap.createAdminOrReissue('new@test.com', NOW)).resolves.toEqual({
      outcome: 'emailTaken',
    });

    expect(repo.records.size).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('reports emailTaken when the invited admin becomes support between the lookup and the resend', async () => {
    const { bootstrap, repo, sent } = setup();
    await bootstrap.bootstrapAdmin('admin@test.com', NOW);
    const [id] = [...repo.records.keys()];
    sent.length = 0;
    const lookup = repo.findByEmail.bind(repo);
    repo.findByEmail = async (email) => {
      const found = await lookup(email);
      repo.records.set(id, { ...repo.records.get(id)!, role: StaffRole.SUPPORT });
      return found;
    };

    await expect(bootstrap.createAdminOrReissue('admin@test.com', LATER)).resolves.toEqual({
      outcome: 'emailTaken',
    });

    expect(repo.invitations).toHaveLength(1);
    expect(repo.invitations[0].expired).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('reports an invalid email', async () => {
    const { bootstrap, repo } = setup();

    await expect(bootstrap.createAdminOrReissue('nope')).resolves.toEqual({
      outcome: 'invalidEmail',
    });
    expect(repo.records.size).toBe(0);
  });
});
