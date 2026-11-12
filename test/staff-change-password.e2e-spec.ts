import type { INestApplication } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import type { Knex } from 'knex';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createKnex } from '../src/database/database.module.js';
import { EmailService } from '../src/email/email.service.js';
import type { FakeEmailService } from '../src/email/fake-email.service.js';
import { StaffRole } from '../src/staff/permissions.js';
import { StaffRepository } from '../src/staff/staff.repository.js';
import { createApp } from './create-app.js';

/** changeOwnStaffPassword against real MySQL, with real staffLogin for tokens and cookies. */
describe('changeOwnStaffPassword (e2e, real MySQL)', () => {
  let app: INestApplication;
  let db: Knex;
  let repo: StaffRepository;
  let passwordHash: string;
  let sent: FakeEmailService['sent'];

  interface GqlResponse {
    data: Record<string, { accessToken: string } | boolean | null> | null;
    errors?: { message: string; extensions: Record<string, unknown> }[];
  }

  const PASSWORD = 'Str0ng!Passw0rd';
  const NEXT = 'N3w!Passw0rd-xyz';
  const ADMIN_ID = '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b';
  const MEMBER_ID = '1c7a4d3f-9e5b-4a8c-8d2e-3b6f7a8b9c0d';
  const createdAt = new Date('2026-11-04T10:00:00.000Z');
  const emailOf = (id: string) => `${id.slice(0, 8)}@test.com`;
  const COOKIE = /^staff_refresh_token=([\w-]+);/;

  const send = (query: string, variables?: object, headers: Record<string, string> = {}) => {
    const req = request(app.getHttpServer() as App)
      .post('/graphql')
      .send({ query, variables });
    for (const [name, value] of Object.entries(headers)) void req.set(name, value);
    return req;
  };
  const staffLogin = (id: string, password = PASSWORD) =>
    send('mutation($input: StaffLoginInput!) { staffLogin(input: $input) { accessToken } }', {
      input: { email: emailOf(id), password },
    });
  const loginOf = async (id: string) => {
    const res = await staffLogin(id);
    return {
      bearer: (res.body as GqlResponse).data!.staffLogin as { accessToken: string },
      cookie: COOKIE.exec(((res.headers['set-cookie'] ?? []) as unknown as string[])[0])![1],
    };
  };
  const asCookie = (token: string) => `staff_refresh_token=${token}`;
  const CHANGE =
    'mutation($input: ChangeOwnStaffPasswordInput!) { changeOwnStaffPassword(input: $input) }';
  const change = (
    bearer: string,
    input: { currentPassword: string; newPassword: string },
    cookie?: string,
  ) =>
    send(
      CHANGE,
      { input },
      {
        Authorization: `Bearer ${bearer}`,
        ...(cookie ? { Cookie: asCookie(cookie) } : {}),
      },
    );
  const codeOf = (res: request.Response) => (res.body as GqlResponse).errors?.[0].extensions.code;
  const refresh = (cookie: string) =>
    send('mutation { staffRefreshSession { accessToken } }', undefined, {
      Cookie: asCookie(cookie),
    });
  const canLogIn = async (id: string, password: string) =>
    (await staffLogin(id, password)).body.errors === undefined;
  const seedActive = async (id: string, role: StaffRole) => {
    await repo.insert({ id, email: emailOf(id), role, createdAt });
    await repo.activate(id, passwordHash, createdAt);
  };
  const unrevoked = async (staffId: string) =>
    (await db('staff_sessions').where({ staff_id: staffId }).whereNull('revoked_at')).length;

  beforeAll(async () => {
    passwordHash = await hash(PASSWORD);
    app = await createApp({ CLIENT: 'demo', BACKOFFICE_URL: 'https://bo.test/' });
    db = createKnex(process.env.DATABASE_URL!);
    repo = new StaffRepository(db);
    sent = app.get<FakeEmailService>(EmailService).sent;
  });

  beforeEach(async () => {
    await db('sessions').delete();
    await db('users').delete();
    await db('staff_sessions').delete();
    await db('staff_invitations').delete();
    await db('staff').delete();
    await seedActive(ADMIN_ID, StaffRole.ADMIN);
    await seedActive(MEMBER_ID, StaffRole.SUPPORT);
    sent.length = 0;
  });

  afterAll(async () => {
    await app.close();
    await db.destroy();
  });

  it('changes the password: the old one stops logging in, the new one works, one email is sent', async () => {
    const { bearer, cookie } = await loginOf(MEMBER_ID);
    sent.length = 0;

    const res = await change(
      bearer.accessToken,
      { currentPassword: PASSWORD, newPassword: NEXT },
      cookie,
    );

    expect(res.body).toEqual({ data: { changeOwnStaffPassword: true } });
    expect(await canLogIn(MEMBER_ID, PASSWORD)).toBe(false);
    expect(await canLogIn(MEMBER_ID, NEXT)).toBe(true);
    expect(sent).toEqual([{ template: 'passwordChanged', to: emailOf(MEMBER_ID), data: {} }]);
  });

  it('keeps the session of the cookie and ends the other sessions of the member', async () => {
    const current = await loginOf(MEMBER_ID);
    const other = await loginOf(MEMBER_ID);

    await change(
      current.bearer.accessToken,
      { currentPassword: PASSWORD, newPassword: NEXT },
      current.cookie,
    );

    expect(codeOf(await refresh(other.cookie))).toBe('INVALID_REFRESH_TOKEN');
    expect(codeOf(await refresh(current.cookie))).toBeUndefined();
  });

  it('ends every session of the caller when there is no cookie', async () => {
    const { bearer } = await loginOf(MEMBER_ID);
    await loginOf(MEMBER_ID);

    await change(bearer.accessToken, { currentPassword: PASSWORD, newPassword: NEXT });

    expect(await unrevoked(MEMBER_ID)).toBe(0);
  });

  it('does not treat the cookie of another member as the current session', async () => {
    const { bearer } = await loginOf(MEMBER_ID);
    const adminSession = await loginOf(ADMIN_ID);

    await change(
      bearer.accessToken,
      { currentPassword: PASSWORD, newPassword: NEXT },
      adminSession.cookie,
    );

    expect(await unrevoked(MEMBER_ID)).toBe(0);
    expect(await unrevoked(ADMIN_ID)).toBe(1);
  });

  it('answers INVALID_CURRENT_PASSWORD for a wrong current password and changes nothing', async () => {
    const { bearer, cookie } = await loginOf(MEMBER_ID);
    sent.length = 0;

    const res = await change(
      bearer.accessToken,
      { currentPassword: 'Wr0ng!Passw0rd', newPassword: NEXT },
      cookie,
    );

    expect(codeOf(res)).toBe('INVALID_CURRENT_PASSWORD');
    expect(await canLogIn(MEMBER_ID, PASSWORD)).toBe(true);
    expect(sent).toHaveLength(0);
    expect(await unrevoked(MEMBER_ID)).toBe(2);
    expect((await repo.findById(MEMBER_ID))?.failedLoginAttempts).toBe(0);
  });

  it('never locks the account however often the current password is wrong', async () => {
    const { bearer } = await loginOf(MEMBER_ID);

    for (let i = 0; i < 6; i += 1) {
      const res = await change(bearer.accessToken, {
        currentPassword: 'Wr0ng!Passw0rd',
        newPassword: NEXT,
      });
      expect(codeOf(res)).toBe('INVALID_CURRENT_PASSWORD');
    }

    expect(await canLogIn(MEMBER_ID, PASSWORD)).toBe(true);
  });

  it('rejects a weak new password with BAD_USER_INPUT on newPassword and changes nothing', async () => {
    const { bearer, cookie } = await loginOf(MEMBER_ID);
    sent.length = 0;

    const res = await change(
      bearer.accessToken,
      { currentPassword: PASSWORD, newPassword: 'weak' },
      cookie,
    );

    expect((res.body as GqlResponse).errors![0].extensions).toMatchObject({
      code: 'BAD_USER_INPUT',
      field: 'newPassword',
    });
    expect(await canLogIn(MEMBER_ID, PASSWORD)).toBe(true);
    expect(sent).toHaveLength(0);
    expect(await unrevoked(MEMBER_ID)).toBe(2);
  });

  it('answers FORBIDDEN for a client user token', async () => {
    await send(
      'mutation { register(input: { email: "artem@test.com", password: "Qwerty1!" }) { id } }',
    ).expect(200);
    const login = await send(
      'mutation { login(input: { email: "artem@test.com", password: "Qwerty1!" }) { accessToken } }',
    );
    const token = (login.body as GqlResponse).data!.login as { accessToken: string };

    const res = await change(token.accessToken, { currentPassword: PASSWORD, newPassword: NEXT });

    expect(codeOf(res)).toBe('FORBIDDEN');
    expect(await canLogIn(MEMBER_ID, PASSWORD)).toBe(true);
  });
});
