import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { hash } from '@node-rs/argon2';
import type { Knex } from 'knex';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { accessTokenPayloadSchema } from '../src/auth/access-token.js';
import { hashRefreshToken } from '../src/auth/tokens.js';
import { AppConfig } from '../src/config/app-config.js';
import { LOCAL_JWT_SECRET } from '../src/config/env.schema.js';
import { createKnex } from '../src/database/database.module.js';
import { ROLE_PERMISSIONS, StaffRole } from '../src/staff/permissions.js';
import { StaffStatus } from '../src/staff/staff.model.js';
import { StaffRepository } from '../src/staff/staff.repository.js';

/** staffLogin and staffLogout over GraphQL, against real MySQL (`npm run infra:up && npm run migrate`). */
describe('staffLogin and staffLogout (e2e, real MySQL)', () => {
  let app: INestApplication;
  let db: Knex;
  let repo: StaffRepository;
  let passwordHash: string;

  interface GqlResponse {
    data: Record<string, { accessToken: string; staff: unknown }> | null;
    errors?: { message: string; extensions: Record<string, unknown> }[];
  }

  const PASSWORD = 'Str0ng!Passw0rd';
  const ADMIN_ID = '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b';
  const INVITED_ID = '4f0d7a6c-2b8e-4d1f-9a5b-6e9c0d1e2f3a';
  const FINANCE_ID = '5a1e8b7d-3c9f-4e2a-8b6c-7f0d1e2f3a4b';
  const COMPLIANCE_ID = '6b2f9c8e-4d0a-4f3b-9c7d-8a1e2f3a4b5c';
  const MEMBER_ID = '1c7a4d3f-9e5b-4a8c-8d2e-3b6f7a8b9c0d';
  const createdAt = new Date('2026-11-04T10:00:00.000Z');
  const emailOf = (id: string) => `${id.slice(0, 8)}@test.com`;
  const INVALID = 'Invalid email or password';

  const LOGIN = `mutation($input: StaffLoginInput!) { staffLogin(input: $input) {
    accessToken accessTokenExpiresAt staff { id email role permissions } } }`;

  const send = (query: string, variables?: object, cookie?: string, bearer?: string) => {
    const req = request(app.getHttpServer() as App)
      .post('/graphql')
      .send({ query, variables });
    if (cookie) void req.set('Cookie', cookie);
    if (bearer) void req.set('Authorization', `Bearer ${bearer}`);
    return req;
  };

  const login = (email: string, password = PASSWORD, cookie?: string) =>
    send(LOGIN, { input: { email, password } }, cookie);

  const gql = async (query: string, bearer: string): Promise<GqlResponse> =>
    (await send(query, undefined, undefined, bearer)).body as GqlResponse;

  const cookiesOf = (res: request.Response) =>
    (res.headers['set-cookie'] ?? []) as unknown as string[];

  const tokenOf = (res: request.Response) => (res.body as GqlResponse).data!.staffLogin.accessToken;

  const seedActive = async (id: string, role: StaffRole) => {
    await repo.insert({ id, email: emailOf(id), role, createdAt });
    await repo.activate(id, passwordHash, createdAt);
  };

  const errorOf = (res: request.Response) => (res.body as GqlResponse).errors![0];

  const unrevoked = async (staffId: string) =>
    (await db('staff_sessions').where({ staff_id: staffId }).whereNull('revoked_at')).length;

  beforeAll(async () => {
    passwordHash = await hash(PASSWORD);
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

  it.each(Object.values(StaffRole))(
    'logs in a %s with that role permissions and the staff cookie only',
    async (role) => {
      await seedActive(MEMBER_ID, role);
      const before = Date.now();
      const res = await login(` ${emailOf(MEMBER_ID).toUpperCase()} `).expect(200);

      const body = res.body as GqlResponse;
      expect(body.errors).toBeUndefined();
      const payload = body.data!.staffLogin;
      expect(payload.staff).toEqual({
        id: MEMBER_ID,
        email: emailOf(MEMBER_ID),
        role,
        permissions: [...ROLE_PERMISSIONS[role]],
      });
      const claims = accessTokenPayloadSchema.parse(
        new JwtService().verify(payload.accessToken, {
          secret: LOCAL_JWT_SECRET,
          algorithms: ['HS256'],
          issuer: 'wallet-core',
        }),
      );
      expect(claims).toMatchObject({
        sub: MEMBER_ID,
        aud: 'backoffice',
        permissions: [...ROLE_PERMISSIONS[role]],
      });

      const cookies = cookiesOf(res);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatch(
        /^staff_refresh_token=[\w-]{43}; Path=\/graphql; Expires=.+; HttpOnly; SameSite=Strict$/,
      );
      const expires = new Date(/Expires=([^;]+);/.exec(cookies[0])![1]).getTime();
      const eightHours = 8 * 60 * 60 * 1000;
      expect(expires).toBeGreaterThanOrEqual(before + eightHours - 1000);
      expect(expires).toBeLessThanOrEqual(Date.now() + eightHours + 1000);

      const token = /^staff_refresh_token=([\w-]+);/.exec(cookies[0])![1];
      const [session] = await db('staff_sessions').select('staff_id', 'refresh_token_hash');
      expect(session).toEqual({ staff_id: MEMBER_ID, refresh_token_hash: hashRefreshToken(token) });
    },
  );

  it('the issued token works for staffMe and enforces permissions per role', async () => {
    await seedActive(ADMIN_ID, StaffRole.ADMIN);
    await seedActive(MEMBER_ID, StaffRole.SUPPORT);
    await seedActive(FINANCE_ID, StaffRole.FINANCE);
    await seedActive(COMPLIANCE_ID, StaffRole.COMPLIANCE);
    const tokenFor = async (id: string) => tokenOf(await login(emailOf(id)));
    const me = '{ staffMe { id role } }';
    const members = '{ staffMembers { id } }';
    const settings = '{ staffSettings { key } }';
    const invite = 'mutation { inviteStaff(input: { email: "n@test.com", role: SUPPORT }) { id } }';
    const code = (body: GqlResponse) => body.errors?.[0].extensions.code;

    const admin = await tokenFor(ADMIN_ID);
    expect((await gql(me, admin)).data).toEqual({ staffMe: { id: ADMIN_ID, role: 'ADMIN' } });
    expect((await gql(members, admin)).errors).toBeUndefined();

    const roles = {
      [MEMBER_ID]: { staffSettings: 'FORBIDDEN' },
      [FINANCE_ID]: { staffSettings: undefined },
      [COMPLIANCE_ID]: { staffSettings: 'FORBIDDEN' },
    };
    for (const [id, expected] of Object.entries(roles)) {
      const token = await tokenFor(id);
      expect((await gql(me, token)).errors).toBeUndefined();
      expect(code(await gql(members, token))).toBe('FORBIDDEN');
      expect(code(await gql(invite, token))).toBe('FORBIDDEN');
      expect(code(await gql(settings, token))).toBe(expected.staffSettings);
    }
  });

  it('answers the same INVALID_CREDENTIALS for a wrong password, unknown email, invited and deactivated members', async () => {
    await seedActive(MEMBER_ID, StaffRole.SUPPORT);
    await seedActive(ADMIN_ID, StaffRole.SUPPORT);
    await repo.update(ADMIN_ID, { status: StaffStatus.DEACTIVATED }, createdAt);
    const invitedId = INVITED_ID;
    await repo.insert({
      id: invitedId,
      email: emailOf(invitedId),
      role: StaffRole.SUPPORT,
      createdAt,
    });

    const results = [
      await login(emailOf(MEMBER_ID), 'Wr0ng!Passw0rd'),
      await login('nobody@test.com'),
      await login(emailOf(invitedId)),
      await login(emailOf(ADMIN_ID)),
    ];

    for (const res of results) {
      expect(errorOf(res)).toMatchObject({
        message: INVALID,
        extensions: { code: 'INVALID_CREDENTIALS' },
      });
      expect(cookiesOf(res)).toEqual([]);
    }
    expect(await db('staff_sessions').count({ n: '*' })).toEqual([{ n: 0 }]);
  });

  it('locks on the fifth wrong password for 15 minutes, also against the right password', async () => {
    await seedActive(MEMBER_ID, StaffRole.SUPPORT);
    for (let i = 1; i <= 4; i += 1) {
      const res = await login(emailOf(MEMBER_ID), 'Wr0ng!Passw0rd');
      expect(errorOf(res).extensions.code).toBe('INVALID_CREDENTIALS');
    }
    const before = Date.now();
    const fifth = errorOf(await login(emailOf(MEMBER_ID), 'Wr0ng!Passw0rd'));

    expect(fifth.extensions.code).toBe('ACCOUNT_LOCKED');
    const until = new Date(fifth.extensions.lockedUntil as string).getTime();
    expect(Math.abs(until - (before + 15 * 60 * 1000))).toBeLessThan(5000);
    expect(fifth.message).toBe(`Account is locked until ${fifth.extensions.lockedUntil as string}`);

    const right = await login(emailOf(MEMBER_ID));
    expect(errorOf(right).extensions.code).toBe('ACCOUNT_LOCKED');
    expect(cookiesOf(right)).toEqual([]);
  });

  it('counts five parallel wrong guesses and locks the account', async () => {
    await seedActive(MEMBER_ID, StaffRole.SUPPORT);
    await Promise.all(Array.from({ length: 5 }, () => login(emailOf(MEMBER_ID), 'Wr0ng!Passw0rd')));

    const row = await repo.findById(MEMBER_ID);
    expect(row?.lockedUntil).not.toBeNull();
    expect(errorOf(await login(emailOf(MEMBER_ID))).extensions.code).toBe('ACCOUNT_LOCKED');
  });

  it('never leaves a live session for a member deactivated while logging in', async () => {
    await seedActive(ADMIN_ID, StaffRole.ADMIN);
    const admin = tokenOf(await login(emailOf(ADMIN_ID)));
    await db('staff_sessions').delete();

    for (let i = 0; i < 5; i += 1) {
      await db('staff').where({ id: MEMBER_ID }).delete();
      await seedActive(MEMBER_ID, StaffRole.SUPPORT);
      await Promise.all([
        login(emailOf(MEMBER_ID)),
        gql(`mutation { deactivateStaff(staffId: "${MEMBER_ID}") { id } }`, admin),
      ]);

      expect((await repo.findById(MEMBER_ID))?.status).toBe(StaffStatus.DEACTIVATED);
      expect(await unrevoked(MEMBER_ID)).toBe(0);
      await db('staff_sessions').where({ staff_id: MEMBER_ID }).delete();
    }
  });

  it('logout revokes the cookie session, clears the cookie and returns true', async () => {
    await seedActive(MEMBER_ID, StaffRole.SUPPORT);
    const cookie = cookiesOf(await login(emailOf(MEMBER_ID)))[0].split(';')[0];

    const res = await send('mutation { staffLogout }', undefined, cookie);

    expect(res.body).toEqual({ data: { staffLogout: true } });
    expect(cookiesOf(res)).toEqual([
      'staff_refresh_token=; Path=/graphql; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict',
    ]);
    const [session] = await db('staff_sessions').select('revoked_at');
    expect(session.revoked_at).not.toBeNull();
  });

  it('logout returns true without a cookie and with an unknown one', async () => {
    expect((await send('mutation { staffLogout }')).body).toEqual({ data: { staffLogout: true } });
    const unknown = `staff_refresh_token=${'x'.repeat(43)}`;
    expect((await send('mutation { staffLogout }', undefined, unknown)).body).toEqual({
      data: { staffLogout: true },
    });
  });

  it('a second login with the staff cookie revokes the earlier session', async () => {
    await seedActive(MEMBER_ID, StaffRole.SUPPORT);
    const cookie = cookiesOf(await login(emailOf(MEMBER_ID)))[0].split(';')[0];

    await login(emailOf(MEMBER_ID), PASSWORD, cookie);

    const sessions = await db('staff_sessions').orderBy('created_at').select('revoked_at');
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s) => s.revoked_at === null)).toHaveLength(1);
    expect(
      await db('staff_sessions')
        .where({ refresh_token_hash: hashRefreshToken(cookie.split('=')[1]) })
        .whereNotNull('revoked_at'),
    ).toHaveLength(1);
  });

  it('ignores the user refresh_token cookie on staff login', async () => {
    await seedActive(MEMBER_ID, StaffRole.SUPPORT);
    await login(emailOf(MEMBER_ID));
    await login(emailOf(MEMBER_ID), PASSWORD, 'refresh_token=abc');
    expect(await unrevoked(MEMBER_ID)).toBe(2);
  });
});
