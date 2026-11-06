import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Knex } from 'knex';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/app-config.js';
import { createKnex } from '../src/database/database.module.js';
import { EMAIL_SENDER, type EmailMessage } from '../src/email/email-sender.js';
import { StaffRole } from '../src/staff/permissions.js';
import { StaffStatus } from '../src/staff/staff.model.js';
import { StaffRepository } from '../src/staff/staff.repository.js';

/** Staff management over GraphQL, against real MySQL (`npm run infra:up && npm run migrate`). */
describe('staff management (e2e, DEV_AUTH=true, real MySQL)', () => {
  let app: INestApplication;
  let db: Knex;
  let repo: StaffRepository;
  const sent: EmailMessage[] = [];

  interface GqlResponse {
    data: Record<string, unknown> | null;
    errors?: { message: string; extensions: Record<string, unknown> }[];
  }

  const gql = async (query: string, authorization: string): Promise<GqlResponse> =>
    (
      await request(app.getHttpServer() as App)
        .post('/graphql')
        .set('Authorization', authorization)
        .send({ query })
    ).body as GqlResponse;

  const ADMIN_ID = '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b';
  const SUPPORT_ID = '1c7a4d3f-9e5b-4a8c-8d2e-3b6f7a8b9c0d';
  const FINANCE_ID = '2d8b5e4a-0f6c-4b9d-9e3f-4c7a8b9c0d1e';
  const COMPLIANCE_ID = '3e9c6f5b-1a7d-4c0e-8f4a-5d8b9c0d1e2f';
  /** Acts as an admin id that is not a staff member (no staff row). */
  const DEV_ACTOR_ID = '9e4d2a1b-7c3f-4b8e-a6d5-0f1e2d3c4b5a';
  const SESSION_ID = '5a1e8b7d-3c9f-4e2a-8b6c-7f0d1e2f3a4b';
  const createdAt = new Date('2026-11-04T10:00:00.000Z');

  const ADMIN = `Dev ${ADMIN_ID}:bo,bo:staff,bo:staff:modify`;
  const DEV_ADMIN = `Dev ${DEV_ACTOR_ID}:bo,bo:staff,bo:staff:modify`;

  /** Creates a staff member and sets its status directly (no invitation flow). */
  const seed = async (id: string, email: string, role: StaffRole, status: StaffStatus) => {
    await repo.insert({ id, email, role, createdAt });
    await repo.update(id, { status }, createdAt);
  };

  /** Sessions are created by staff login (later PR); here they are set up directly. */
  const session = (staffId: string) =>
    db('staff_sessions').insert({
      id: SESSION_ID,
      staff_id: staffId,
      refresh_token_hash: 'd'.repeat(64),
      expires_at: new Date('2030-01-01T00:00:00.000Z'),
      created_at: createdAt,
    });

  const revokedSessionIds = async () =>
    (await db('staff_sessions').whereNotNull('revoked_at').pluck('id')) as string[];

  const statusOf = async (id: string) => (await repo.findById(id))?.status;

  const tokenHashesOf = async (staffId: string) =>
    (await db('staff_invitations').where({ staff_id: staffId }).pluck('token_hash')) as string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppConfig)
      .useValue(
        AppConfig.fromEnv({
          ...process.env,
          DEV_AUTH: 'true',
          CLIENT: 'demo',
          BACKOFFICE_URL: 'https://bo.test/',
        }),
      )
      .overrideProvider(EMAIL_SENDER)
      .useValue({
        send: (message: EmailMessage) => {
          sent.push(message);
          return Promise.resolve();
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    db = createKnex(process.env.DATABASE_URL!);
    repo = new StaffRepository(db);
  });

  beforeEach(async () => {
    sent.length = 0;
    // DELETE, not TRUNCATE: MySQL refuses to truncate a table referenced by a foreign key.
    await db('staff_sessions').delete();
    await db('staff_invitations').delete();
    await db('staff').delete();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('an admin invites a member: INVITED, listed by staffMembers, with one invitation', async () => {
    const body = await gql(
      'mutation { inviteStaff(input: { email: "New@Test.com", role: SUPPORT }) { id email role status } }',
      ADMIN,
    );
    expect(body.errors).toBeUndefined();
    const invited = body.data?.inviteStaff as { id: string };
    expect(invited).toEqual({
      id: expect.any(String),
      email: 'new@test.com',
      role: 'SUPPORT',
      status: 'INVITED',
    });

    const listed = await gql('{ staffMembers { id email status } }', ADMIN);
    expect(listed.data).toEqual({
      staffMembers: [{ id: invited.id, email: 'new@test.com', status: 'INVITED' }],
    });
    await expect(db('staff_invitations').select('staff_id')).resolves.toEqual([
      { staff_id: invited.id },
    ]);
  });

  it('inviting and resending each email one link whose token hashes to the stored invitation', async () => {
    const invited = await gql(
      'mutation { inviteStaff(input: { email: "New@Test.com", role: SUPPORT }) { id } }',
      ADMIN,
    );
    const staffId = (invited.data?.inviteStaff as { id: string }).id;
    await gql(`mutation { resendStaffInvitation(staffId: "${staffId}") { id } }`, ADMIN);

    expect(sent).toHaveLength(2);
    const hashes = await tokenHashesOf(staffId);
    for (const message of sent) {
      expect(message.template).toBe('staffInvitation');
      expect(message.to).toBe('new@test.com');
      expect(Object.keys(message.data)).toEqual(['link']);
      const link = new URL(message.data.link);
      expect(`${link.origin}${link.pathname}`).toBe('https://bo.test/accept-invitation');
      const hash = createHash('sha256').update(link.searchParams.get('token')!).digest('hex');
      expect(hashes).toContain(hash);
    }
    expect(sent[0].data.link).not.toBe(sent[1].data.link);
  });

  it('sends no email when the invited address is taken or the resend is refused', async () => {
    await seed(SUPPORT_ID, 'taken@test.com', StaffRole.SUPPORT, StaffStatus.ACTIVE);
    await gql(
      'mutation { inviteStaff(input: { email: "taken@test.com", role: FINANCE }) { id } }',
      ADMIN,
    );
    await gql(`mutation { resendStaffInvitation(staffId: "${SUPPORT_ID}") { id } }`, ADMIN);
    expect(sent).toHaveLength(0);
  });

  it('answers STAFF_ALREADY_EXISTS for an email taken in another case', async () => {
    await seed(SUPPORT_ID, 'taken@test.com', StaffRole.SUPPORT, StaffStatus.ACTIVE);
    const body = await gql(
      'mutation { inviteStaff(input: { email: "TAKEN@test.com", role: FINANCE }) { id } }',
      ADMIN,
    );
    expect(body.errors?.[0].extensions).toEqual({ code: 'STAFF_ALREADY_EXISTS' });
    await expect(db('staff').count({ n: '*' }).first()).resolves.toEqual({ n: 1 });
  });

  it.each([
    ['Support', `Dev ${SUPPORT_ID}:bo`],
    ['Finance', `Dev ${FINANCE_ID}:bo,bo:settings,bo:settings:modify`],
    ['Compliance', `Dev ${COMPLIANCE_ID}:bo`],
  ])('%s cannot invite staff: FORBIDDEN, nothing created', async (_role, authorization) => {
    const body = await gql(
      'mutation { inviteStaff(input: { email: "new@test.com", role: SUPPORT }) { id } }',
      authorization,
    );
    expect(body.errors?.[0].extensions.code).toBe('FORBIDDEN');
    await expect(db('staff').count({ n: '*' }).first()).resolves.toEqual({ n: 0 });
  });

  it('refuses to deactivate the caller themselves: CANNOT_DEACTIVATE_SELF', async () => {
    await seed(ADMIN_ID, 'admin@test.com', StaffRole.ADMIN, StaffStatus.ACTIVE);
    await seed(SUPPORT_ID, 'support@test.com', StaffRole.ADMIN, StaffStatus.ACTIVE);
    const body = await gql(`mutation { deactivateStaff(staffId: "${ADMIN_ID}") { id } }`, ADMIN);
    expect(body.errors?.[0].extensions).toEqual({ code: 'CANNOT_DEACTIVATE_SELF' });
    await expect(statusOf(ADMIN_ID)).resolves.toBe(StaffStatus.ACTIVE);
  });

  it('refuses to deactivate the last active admin: LAST_ADMIN', async () => {
    await seed(ADMIN_ID, 'admin@test.com', StaffRole.ADMIN, StaffStatus.ACTIVE);
    const body = await gql(
      `mutation { deactivateStaff(staffId: "${ADMIN_ID}") { id } }`,
      DEV_ADMIN,
    );
    expect(body.errors?.[0].extensions).toEqual({ code: 'LAST_ADMIN' });
    await expect(statusOf(ADMIN_ID)).resolves.toBe(StaffStatus.ACTIVE);
  });

  it('deactivates a member and revokes their sessions', async () => {
    await seed(ADMIN_ID, 'admin@test.com', StaffRole.ADMIN, StaffStatus.ACTIVE);
    await seed(SUPPORT_ID, 'support@test.com', StaffRole.SUPPORT, StaffStatus.ACTIVE);
    await session(SUPPORT_ID);
    const body = await gql(
      `mutation { deactivateStaff(staffId: "${SUPPORT_ID}") { id status } }`,
      ADMIN,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ deactivateStaff: { id: SUPPORT_ID, status: 'DEACTIVATED' } });
    await expect(statusOf(SUPPORT_ID)).resolves.toBe(StaffStatus.DEACTIVATED);
    await expect(revokedSessionIds()).resolves.toEqual([SESSION_ID]);
  });

  it('changes a role and revokes the sessions of that member', async () => {
    await seed(ADMIN_ID, 'admin@test.com', StaffRole.ADMIN, StaffStatus.ACTIVE);
    await seed(SUPPORT_ID, 'support@test.com', StaffRole.SUPPORT, StaffStatus.ACTIVE);
    await session(SUPPORT_ID);
    const body = await gql(
      `mutation { changeStaffRole(staffId: "${SUPPORT_ID}", role: FINANCE) { id role } }`,
      ADMIN,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ changeStaffRole: { id: SUPPORT_ID, role: 'FINANCE' } });
    await expect(repo.findById(SUPPORT_ID)).resolves.toMatchObject({ role: StaffRole.FINANCE });
    await expect(revokedSessionIds()).resolves.toEqual([SESSION_ID]);
  });

  it('staffMe returns the member with the permissions of their role', async () => {
    await seed(FINANCE_ID, 'finance@test.com', StaffRole.FINANCE, StaffStatus.ACTIVE);
    const body = await gql('{ staffMe { id email role permissions } }', `Dev ${FINANCE_ID}:bo`);
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      staffMe: {
        id: FINANCE_ID,
        email: 'finance@test.com',
        role: 'FINANCE',
        permissions: ['bo', 'bo:settings', 'bo:settings:modify'],
      },
    });
  });

  it('staffMe refuses a user token (no bo permission): FORBIDDEN', async () => {
    const body = await gql('{ staffMe { id } }', `Dev ${FINANCE_ID}:wallet`);
    expect(body.errors?.[0].extensions.code).toBe('FORBIDDEN');
  });

  it('deactivating an invited member makes their invitation link unusable', async () => {
    const invited = await gql(
      'mutation { inviteStaff(input: { email: "new@test.com", role: SUPPORT }) { id } }',
      ADMIN,
    );
    const staffId = (invited.data?.inviteStaff as { id: string }).id;

    const body = await gql(`mutation { deactivateStaff(staffId: "${staffId}") { status } }`, ADMIN);
    expect(body.errors).toBeUndefined();

    const [tokenHash] = await tokenHashesOf(staffId);
    await expect(repo.consumeInvitation(tokenHash, new Date())).resolves.toBeNull();
  });

  it('resending an invitation returns the member and replaces the old link with a new one', async () => {
    const invited = await gql(
      'mutation { inviteStaff(input: { email: "new@test.com", role: SUPPORT }) { id } }',
      ADMIN,
    );
    const staffId = (invited.data?.inviteStaff as { id: string }).id;
    const [oldHash] = await tokenHashesOf(staffId);

    const body = await gql(
      `mutation { resendStaffInvitation(staffId: "${staffId}") { id email status } }`,
      ADMIN,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({
      resendStaffInvitation: { id: staffId, email: 'new@test.com', status: 'INVITED' },
    });

    const hashes = await tokenHashesOf(staffId);
    const newHash = hashes.find((hash) => hash !== oldHash);
    expect(hashes).toHaveLength(2);
    expect(newHash).toBeDefined();
    await expect(repo.consumeInvitation(oldHash, new Date())).resolves.toBeNull();
    await expect(repo.consumeInvitation(newHash!, new Date())).resolves.toBe(staffId);
  });

  it('refuses to resend an invitation to an active member: NOT_INVITED', async () => {
    await seed(SUPPORT_ID, 'support@test.com', StaffRole.SUPPORT, StaffStatus.ACTIVE);
    const body = await gql(
      `mutation { resendStaffInvitation(staffId: "${SUPPORT_ID}") { id } }`,
      ADMIN,
    );
    expect(body.errors?.[0].extensions).toEqual({ code: 'NOT_INVITED' });
    await expect(db('staff_invitations').count({ n: '*' }).first()).resolves.toEqual({ n: 0 });
  });

  it('refuses to demote the last active admin: LAST_ADMIN, role unchanged', async () => {
    await seed(ADMIN_ID, 'admin@test.com', StaffRole.ADMIN, StaffStatus.ACTIVE);
    const body = await gql(
      `mutation { changeStaffRole(staffId: "${ADMIN_ID}", role: SUPPORT) { id } }`,
      DEV_ADMIN,
    );
    expect(body.errors?.[0].extensions).toEqual({ code: 'LAST_ADMIN' });
    await expect(repo.findById(ADMIN_ID)).resolves.toMatchObject({ role: StaffRole.ADMIN });
  });

  it('refuses the sole admin deactivating their own id in upper case: CANNOT_DEACTIVATE_SELF', async () => {
    await seed(ADMIN_ID, 'admin@test.com', StaffRole.ADMIN, StaffStatus.ACTIVE);
    const body = await gql(
      `mutation { deactivateStaff(staffId: "${ADMIN_ID.toUpperCase()}") { id } }`,
      ADMIN,
    );
    expect(body.errors?.[0].extensions).toEqual({ code: 'CANNOT_DEACTIVATE_SELF' });
    await expect(statusOf(ADMIN_ID)).resolves.toBe(StaffStatus.ACTIVE);
  });

  it('refuses to demote the sole active admin given in upper case: LAST_ADMIN, row unchanged', async () => {
    await seed(ADMIN_ID, 'admin@test.com', StaffRole.ADMIN, StaffStatus.ACTIVE);
    const body = await gql(
      `mutation { changeStaffRole(staffId: "${ADMIN_ID.toUpperCase()}", role: SUPPORT) { id } }`,
      DEV_ADMIN,
    );
    expect(body.errors?.[0].extensions).toEqual({ code: 'LAST_ADMIN' });
    await expect(repo.findById(ADMIN_ID)).resolves.toMatchObject({
      role: StaffRole.ADMIN,
      status: StaffStatus.ACTIVE,
    });
  });
});
