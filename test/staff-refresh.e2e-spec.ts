import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash } from '@node-rs/argon2';
import type { Knex } from 'knex';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { accessTokenPayloadSchema } from '../src/auth/access-token.js';
import { LOCAL_JWT_SECRET } from '../src/config/env.schema.js';
import { createKnex } from '../src/database/database.module.js';
import { ROLE_PERMISSIONS, StaffRole } from '../src/staff/permissions.js';
import { StaffStatus } from '../src/staff/staff.model.js';
import { StaffRepository } from '../src/staff/staff.repository.js';
import { createApp } from './create-app.js';

/** staffRefreshSession and its isolation from user sessions, against real MySQL. */
describe('staffRefreshSession (e2e, real MySQL)', () => {
  let app: INestApplication;
  let db: Knex;
  let repo: StaffRepository;
  let passwordHash: string;

  interface GqlResponse {
    data: Record<string, { accessToken: string; staff: unknown }> | null;
    errors?: { message: string; extensions: { code: string } }[];
  }

  const PASSWORD = 'Str0ng!Passw0rd';
  const ADMIN_ID = '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b';
  const MEMBER_ID = '1c7a4d3f-9e5b-4a8c-8d2e-3b6f7a8b9c0d';
  const createdAt = new Date('2026-11-04T10:00:00.000Z');
  const emailOf = (id: string) => `${id.slice(0, 8)}@test.com`;
  const ADMIN_DEV = `Dev ${ADMIN_ID}:bo,bo:staff,bo:staff:modify`;
  const REFRESH = 'mutation { staffRefreshSession { accessToken staff { id role permissions } } }';
  const COOKIE = /^staff_refresh_token=([\w-]+);/;

  const send = (query: string, headers: Record<string, string> = {}) => {
    const req = request(app.getHttpServer() as App)
      .post('/graphql')
      .send({ query });
    for (const [name, value] of Object.entries(headers)) void req.set(name, value);
    return req;
  };
  const cookiesOf = (res: request.Response) =>
    (res.headers['set-cookie'] ?? []) as unknown as string[];
  const staffCookieOf = (res: request.Response) => COOKIE.exec(cookiesOf(res)[0])![1];
  const asCookie = (token: string) => ({ Cookie: `staff_refresh_token=${token}` });
  const codeOf = (res: request.Response) => (res.body as GqlResponse).errors?.[0].extensions.code;
  const refresh = (token?: string) => send(REFRESH, token ? asCookie(token) : {});

  const LOGIN = `mutation { staffLogin(input: { email: "${emailOf(MEMBER_ID)}", password: "${PASSWORD}" }) { accessToken } }`;
  const staffLogin = (headers: Record<string, string> = {}) => send(LOGIN, headers);
  const accessTokenOf = (res: request.Response, field: string) =>
    (res.body as GqlResponse).data![field].accessToken;
  const seedActive = async (id: string, role: StaffRole) => {
    await repo.insert({ id, email: emailOf(id), role, createdAt });
    await repo.activate(id, passwordHash, createdAt);
  };
  const admin = (query: string) => send(query, { Authorization: ADMIN_DEV });
  const unrevoked = async (staffId: string) =>
    (await db('staff_sessions').where({ staff_id: staffId }).whereNull('revoked_at')).length;

  beforeAll(async () => {
    passwordHash = await hash(PASSWORD);
    app = await createApp({ DEV_AUTH: 'true', CLIENT: 'demo', BACKOFFICE_URL: 'https://bo.test/' });
    db = createKnex(process.env.DATABASE_URL!);
    repo = new StaffRepository(db);
  });

  beforeEach(async () => {
    await db('sessions').delete();
    await db('users').delete();
    await db('staff_sessions').delete();
    await db('staff_invitations').delete();
    await db('staff').delete();
    await seedActive(ADMIN_ID, StaffRole.ADMIN);
    await seedActive(MEMBER_ID, StaffRole.SUPPORT);
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('issues a new backoffice token, rotates the cookie and keeps the session end', async () => {
    const login = await staffLogin();
    const loginCookie = cookiesOf(login)[0];
    const first = staffCookieOf(login);

    const res = await refresh(first).expect(200);

    const body = res.body as GqlResponse;
    expect(body.errors).toBeUndefined();
    const payload = body.data!.staffRefreshSession;
    expect(payload.staff).toEqual({
      id: MEMBER_ID,
      role: 'SUPPORT',
      permissions: [...ROLE_PERMISSIONS.SUPPORT],
    });
    const claims = accessTokenPayloadSchema.parse(
      new JwtService().verify(payload.accessToken, {
        secret: LOCAL_JWT_SECRET,
        algorithms: ['HS256'],
        issuer: 'wallet-core',
      }),
    );
    expect(claims).toMatchObject({ sub: MEMBER_ID, aud: 'backoffice', permissions: ['bo'] });

    const cookies = cookiesOf(res);
    expect(cookies).toHaveLength(1);
    expect(staffCookieOf(res)).not.toBe(first);
    // Same attributes and the same Expires as the login cookie: the session is not extended.
    expect(cookies[0].split('; ').slice(1)).toEqual(loginCookie.split('; ').slice(1));
    expect(cookies[0]).toMatch(/Path=\/graphql; Expires=.*; HttpOnly; SameSite=Strict$/);
    const [session] = await db<{ expires_at: Date }>('staff_sessions').select('expires_at');
    const expires = /Expires=([^;]+)/.exec(cookies[0])![1];
    expect(new Date(expires).getTime()).toBe(
      Math.floor(session.expires_at.getTime() / 1000) * 1000,
    );

    expect(codeOf(await refresh(first))).toBe('INVALID_REFRESH_TOKEN');
  });

  it('lets exactly one of two parallel refreshes with one token through', async () => {
    const token = staffCookieOf(await staffLogin());

    const results = await Promise.all([refresh(token), refresh(token)]);

    expect(results.map((r) => codeOf(r))).toContain('INVALID_REFRESH_TOKEN');
    expect(results.filter((r) => codeOf(r) === undefined)).toHaveLength(1);
  });

  it.each([
    ['deactivateStaff', `mutation { deactivateStaff(staffId: "${MEMBER_ID}") { id } }`],
    [
      'changeStaffRole',
      `mutation { changeStaffRole(staffId: "${MEMBER_ID}", role: FINANCE) { id } }`,
    ],
  ])('rejects the refresh after %s', async (_name, mutation) => {
    const token = staffCookieOf(await staffLogin());
    expect(((await admin(mutation)).body as GqlResponse).errors).toBeUndefined();

    expect(codeOf(await refresh(token))).toBe('INVALID_REFRESH_TOKEN');
  });

  it('carries the new role only after a fresh login following a role change', async () => {
    const token = staffCookieOf(await staffLogin());
    await admin(`mutation { changeStaffRole(staffId: "${MEMBER_ID}", role: FINANCE) { id } }`);
    expect(codeOf(await refresh(token))).toBe('INVALID_REFRESH_TOKEN');

    const res = await refresh(staffCookieOf(await staffLogin()));

    expect((res.body as GqlResponse).data!.staffRefreshSession.staff).toEqual({
      id: MEMBER_ID,
      role: 'FINANCE',
      permissions: [...ROLE_PERMISSIONS.FINANCE],
    });
  });

  it('rejects an expired session', async () => {
    const token = staffCookieOf(await staffLogin());
    await db('staff_sessions').update({ expires_at: new Date(Date.now() - 1000) });

    expect(codeOf(await refresh(token))).toBe('INVALID_REFRESH_TOKEN');
  });

  describe('isolation from user sessions', () => {
    const userLogin = async () => {
      await send(
        'mutation { register(input: { email: "artem@test.com", password: "Qwerty1!" }) { id } }',
      ).expect(200);
      return send(
        'mutation { login(input: { email: "artem@test.com", password: "Qwerty1!" }) { accessToken } }',
      );
    };

    it('does not accept the user refresh cookie value as a staff cookie', async () => {
      const userToken = /^refresh_token=([\w-]+);/.exec(cookiesOf(await userLogin())[0])![1];

      const res = await refresh(userToken);

      expect(codeOf(res)).toBe('INVALID_REFRESH_TOKEN');
      expect(cookiesOf(res)).toEqual([]);
    });

    it('does not accept the staff cookie value on the user refreshSession', async () => {
      const staffToken = staffCookieOf(await staffLogin());

      const res = await send('mutation { refreshSession { accessToken } }', {
        Cookie: `refresh_token=${staffToken}`,
      });

      expect(codeOf(res)).toBe('INVALID_REFRESH_TOKEN');
      expect(cookiesOf(res)).toEqual([]);
      expect(await unrevoked(MEMBER_ID)).toBe(1);
    });

    it('answers INVALID_REFRESH_TOKEN without a cookie and sets none', async () => {
      const res = await refresh();

      expect(codeOf(res)).toBe('INVALID_REFRESH_TOKEN');
      expect(cookiesOf(res)).toEqual([]);
    });

    it('keeps a staff access token off client endpoints', async () => {
      const token = accessTokenOf(await staffLogin(), 'staffLogin');

      await request(app.getHttpServer() as App)
        .get('/__test/wallet')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('keeps a user access token off staff endpoints', async () => {
      const token = accessTokenOf(await userLogin(), 'login');

      const res = await send('{ staffMe { id } }', { Authorization: `Bearer ${token}` });

      expect(codeOf(res)).toBe('FORBIDDEN');
    });
  });

  it('lets a real staff token call me and reports kind STAFF', async () => {
    const token = accessTokenOf(await staffLogin(), 'staffLogin');

    const res = await send('{ me { kind permissions } }', { Authorization: `Bearer ${token}` });

    expect((res.body as GqlResponse).data).toEqual({ me: { kind: 'STAFF', permissions: ['bo'] } });
  });

  it('never leaves a live session for a member deactivated while refreshing', async () => {
    for (let i = 0; i < 5; i += 1) {
      await db('staff_sessions').delete();
      await db('staff').where({ id: MEMBER_ID }).delete();
      await seedActive(MEMBER_ID, StaffRole.SUPPORT);
      const token = staffCookieOf(await staffLogin());

      const [refreshed, deactivated] = await Promise.all([
        refresh(token),
        admin(`mutation { deactivateStaff(staffId: "${MEMBER_ID}") { id } }`),
      ]);

      expect([undefined, 'INVALID_REFRESH_TOKEN']).toContain(codeOf(refreshed));
      expect((deactivated.body as GqlResponse).errors).toBeUndefined();
      expect((await repo.findById(MEMBER_ID))?.status).toBe(StaffStatus.DEACTIVATED);
      expect(await unrevoked(MEMBER_ID)).toBe(0);
    }
  });

  it('rejects the old token after logout and after a second login replaced the cookie', async () => {
    const first = staffCookieOf(await staffLogin());
    await send('mutation { staffLogout }', asCookie(first)).expect(200);
    expect(codeOf(await refresh(first))).toBe('INVALID_REFRESH_TOKEN');

    const second = staffCookieOf(await staffLogin());
    const third = await staffLogin(asCookie(second));

    expect(codeOf(await refresh(second))).toBe('INVALID_REFRESH_TOKEN');
    expect(codeOf(await refresh(staffCookieOf(third)))).toBeUndefined();
  });
});
