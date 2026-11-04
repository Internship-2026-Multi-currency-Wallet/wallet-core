import type { INestApplication } from '@nestjs/common';
import type { Knex } from 'knex';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createKnex } from '../src/database/database.module.js';
import { createApp } from './create-app.js';

/** refreshSession and logout through GraphQL with the refresh token cookie. Needs migrations. */
describe('refreshSession and logout (e2e)', () => {
  const PASSWORD = 'Qwerty1!';
  const COOKIE = /^refresh_token=([\w-]*);/;
  let app: INestApplication;
  let db: Knex;

  interface GqlBody {
    data: Record<string, unknown> | null;
    errors?: { message: string; extensions: { code: string } }[];
  }

  const post = (query: string, cookie?: string) => {
    const req = request(app.getHttpServer() as App).post('/graphql');
    if (cookie) req.set('Cookie', `refresh_token=${cookie}`);
    return req.send({ query });
  };
  const tokenOf = (res: request.Response): string | undefined => {
    const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
    return cookies ? COOKIE.exec(cookies[0])?.[1] : undefined;
  };
  const login = async (cookie?: string): Promise<string> => {
    const res = await post(
      `mutation { login(input: { email: "artem@test.com", password: "${PASSWORD}" }) { accessToken } }`,
      cookie,
    );
    return tokenOf(res)!;
  };
  const refresh = (cookie?: string) =>
    post('mutation { refreshSession { accessToken user { email } } }', cookie);
  const logout = (cookie?: string) => post('mutation { logout }', cookie);
  const codeOf = (res: request.Response) => (res.body as GqlBody).errors?.[0].extensions.code;
  const activeSessions = () => db('sessions').whereNull('revoked_at').count({ count: '*' });

  beforeAll(async () => {
    app = await createApp();
    db = createKnex(process.env.DATABASE_URL!);
  });

  beforeEach(async () => {
    await db('sessions').delete();
    await db('users').delete();
    await db('client_setting_changes').delete();
    await db('client_settings').delete();
    await post(
      `mutation { register(input: { email: "artem@test.com", password: "${PASSWORD}" }) { id } }`,
    ).expect(200);
  });

  afterAll(async () => {
    await db.destroy();
    await app.close();
  });

  it('issues a new access token and a new refresh token, and the old one stops working', async () => {
    const first = await login();
    const [{ expires_at: sessionEnd }] = await db('sessions').select('expires_at');

    const res = await refresh(first);
    expect((res.body as GqlBody).errors).toBeUndefined();
    expect(res.body).toMatchObject({
      data: { refreshSession: { user: { email: 'artem@test.com' } } },
    });
    const second = tokenOf(res);
    expect(second).toMatch(/^[\w-]{43}$/);
    expect(second).not.toBe(first);
    await expect(db('sessions').select('expires_at')).resolves.toEqual([
      { expires_at: sessionEnd },
    ]);

    const reused = await refresh(first);
    expect(codeOf(reused)).toBe('INVALID_REFRESH_TOKEN');
    expect(tokenOf(reused)).toBe('');
    expect(codeOf(await refresh(second))).toBeUndefined();
  });

  it('answers INVALID_REFRESH_TOKEN without a cookie or with an unknown one', async () => {
    expect(codeOf(await refresh())).toBe('INVALID_REFRESH_TOKEN');
    expect(codeOf(await refresh('x'.repeat(43)))).toBe('INVALID_REFRESH_TOKEN');
  });

  it('ends the session and clears the cookie on logout', async () => {
    const token = await login();
    const res = await logout(token);

    expect(res.body).toEqual({ data: { logout: true } });
    expect(res.headers['set-cookie']).toEqual([
      'refresh_token=; Path=/graphql; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict',
    ]);
    await expect(activeSessions()).resolves.toEqual([{ count: 0 }]);
    expect(codeOf(await refresh(token))).toBe('INVALID_REFRESH_TOKEN');
  });

  it('answers true on logout without a session', async () => {
    expect((await logout()).body).toEqual({ data: { logout: true } });
    expect((await logout('x'.repeat(43))).body).toEqual({ data: { logout: true } });
  });

  it('closes the previous session when the same browser logs in again', async () => {
    const first = await login();
    const second = await login(first);

    await expect(activeSessions()).resolves.toEqual([{ count: 1 }]);
    expect(codeOf(await refresh(first))).toBe('INVALID_REFRESH_TOKEN');
    expect(codeOf(await refresh(second))).toBeUndefined();
  });
});
