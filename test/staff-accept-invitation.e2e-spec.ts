import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { verify } from '@node-rs/argon2';
import type { Knex } from 'knex';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/app-config.js';
import { createKnex } from '../src/database/database.module.js';
import { StaffRole } from '../src/staff/permissions.js';
import { StaffStatus } from '../src/staff/staff.model.js';
import { StaffRepository } from '../src/staff/staff.repository.js';
import { StaffService } from '../src/staff/staff.service.js';

/** acceptStaffInvitation over GraphQL, against real MySQL (`npm run infra:up && npm run migrate`). */
describe('acceptStaffInvitation (e2e, real MySQL)', () => {
  let app: INestApplication;
  let db: Knex;
  let repo: StaffRepository;

  interface GqlResponse {
    data: Record<string, unknown> | null;
    errors?: { message: string; extensions: Record<string, unknown> }[];
  }

  const STAFF_ID = '1c7a4d3f-9e5b-4a8c-8d2e-3b6f7a8b9c0d';
  const ADMIN_ID = '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b';
  const TOKEN = 'known-token-1';
  const PASSWORD = 'Str0ng!Passw0rd';
  const INVALID = 'Invitation link is invalid or has expired';
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

  const accept = async (token: string, password: string): Promise<GqlResponse> =>
    (
      await request(app.getHttpServer() as App)
        .post('/graphql')
        .send({
          query:
            'mutation($input: AcceptStaffInvitationInput!) { acceptStaffInvitation(input: $input) }',
          variables: { input: { token, password } },
        })
    ).body as GqlResponse;

  const seedInvitation = async (
    token = TOKEN,
    options: { status?: StaffStatus; expiresAt?: Date } = {},
  ) => {
    const createdAt = new Date();
    await repo.insert({
      id: STAFF_ID,
      email: 'invited@test.com',
      role: StaffRole.SUPPORT,
      createdAt,
    });
    if (options.status) await repo.update(STAFF_ID, { status: options.status }, createdAt);
    await repo.insertInvitation({
      id: '5a1e8b7d-3c9f-4e2a-8b6c-7f0d1e2f3a4b',
      staffId: STAFF_ID,
      tokenHash: sha256(token),
      expiresAt: options.expiresAt ?? new Date(createdAt.getTime() + 48 * 60 * 60 * 1000),
      createdAt,
    });
  };

  const expectInvalid = (body: GqlResponse) => {
    expect(body.errors).toHaveLength(1);
    expect(body.errors![0].message).toBe(INVALID);
    expect(body.errors![0].extensions.code).toBe('INVALID_INVITATION');
  };

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
      .compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
    db = createKnex(process.env.DATABASE_URL!);
    repo = new StaffRepository(db);
  });

  beforeEach(async () => {
    await db('staff_sessions').delete();
    await db('staff_invitations').delete();
    await db('staff').delete();
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('a valid token returns true, activates the member and stores a verifiable hash', async () => {
    await seedInvitation();
    const body = await accept(TOKEN, PASSWORD);

    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ acceptStaffInvitation: true });
    const record = await repo.findById(STAFF_ID);
    expect(record?.status).toBe(StaffStatus.ACTIVE);
    await expect(verify(record!.passwordHash!, PASSWORD)).resolves.toBe(true);
  });

  it('the same token works once', async () => {
    await seedInvitation();
    await accept(TOKEN, PASSWORD);
    expectInvalid(await accept(TOKEN, 'An0ther!Passw0rd'));
    const record = await repo.findById(STAFF_ID);
    await expect(verify(record!.passwordHash!, PASSWORD)).resolves.toBe(true);
  });

  it('an expired token is refused and the member stays invited', async () => {
    await seedInvitation(TOKEN, { expiresAt: new Date(Date.now() - 1000) });
    expectInvalid(await accept(TOKEN, PASSWORD));
    expect((await repo.findById(STAFF_ID))?.status).toBe(StaffStatus.INVITED);
  });

  it('a resend replaces the link: the old token fails, the new one works', async () => {
    await repo.insert({
      id: ADMIN_ID,
      email: 'a@test.com',
      role: StaffRole.ADMIN,
      createdAt: new Date(),
    });
    await seedInvitation();
    const { link } = await app.get(StaffService).resendInvitationWithLink(ADMIN_ID, STAFF_ID);
    const newToken = new URL(link).searchParams.get('token')!;

    expectInvalid(await accept(TOKEN, PASSWORD));
    expect((await accept(newToken, PASSWORD)).data).toEqual({ acceptStaffInvitation: true });
  });

  it.each([
    ['unknown', 'no-such-token'],
    ['empty', ''],
    ['very long', 'x'.repeat(100_000)],
  ])('a %s token gets the one generic INVALID_INVITATION error', async (_name, token) => {
    await seedInvitation();
    expectInvalid(await accept(token, PASSWORD));
  });

  it('the token of a deactivated member gets the same error', async () => {
    await seedInvitation(TOKEN, { status: StaffStatus.DEACTIVATED });
    expectInvalid(await accept(TOKEN, PASSWORD));
    expect((await repo.findById(STAFF_ID))?.status).toBe(StaffStatus.DEACTIVATED);
  });

  it.each([
    ['weak', 'weak'],
    ['too long', `Aa1!${'a'.repeat(125)}`],
  ])(
    'a %s password is BAD_USER_INPUT on field password and keeps the invitation',
    async (_name, password) => {
      await seedInvitation();
      const body = await accept(TOKEN, password);

      expect(body.errors![0].extensions).toMatchObject({
        code: 'BAD_USER_INPUT',
        field: 'password',
      });
      expect((await accept(TOKEN, PASSWORD)).data).toEqual({ acceptStaffInvitation: true });
    },
  );

  it('two parallel accepts of one token: exactly one wins and its password is stored', async () => {
    await seedInvitation();
    const passwords = ['Winner!Passw0rd1', 'Winner!Passw0rd2'];
    const bodies = await Promise.all(passwords.map((password) => accept(TOKEN, password)));

    const winners = bodies.filter((b) => b.data?.acceptStaffInvitation === true);
    const losers = bodies.filter((b) => b.errors);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expectInvalid(losers[0]);
    const record = await repo.findById(STAFF_ID);
    const winnerPassword = passwords[bodies.indexOf(winners[0])];
    await expect(verify(record!.passwordHash!, winnerPassword)).resolves.toBe(true);
  });
});
