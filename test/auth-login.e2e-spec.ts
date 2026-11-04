import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Knex } from 'knex';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { accessTokenPayloadSchema } from '../src/auth/access-token.js';
import { hashRefreshToken } from '../src/auth/tokens.js';
import { LOCAL_JWT_SECRET } from '../src/config/env.schema.js';
import { createKnex } from '../src/database/database.module.js';
import { createApp } from './create-app.js';

/** Needs migrations applied (`npm run migrate`); empties users and sessions before each test. */
describe('login (e2e)', () => {
  const PASSWORD = 'Qwerty1!';
  let app: INestApplication;
  let db: Knex;

  interface LoginResponse {
    data: {
      login: {
        accessToken: string;
        accessTokenExpiresAt: string;
        user: { id: string; email: string };
      };
    } | null;
    errors?: { message: string; extensions: Record<string, unknown> }[];
  }

  const post = (query: string, variables: Record<string, unknown>) =>
    request(app.getHttpServer() as App)
      .post('/graphql')
      .send({ query, variables });
  const register = () =>
    post('mutation ($input: RegisterInput!) { register(input: $input) { id } }', {
      input: { email: 'artem@test.com', password: PASSWORD },
    });
  const login = (password = PASSWORD, email = 'artem@test.com') =>
    post(
      'mutation ($input: LoginInput!) { login(input: $input) { accessToken accessTokenExpiresAt user { id email } } }',
      { input: { email, password } },
    );
  const errorOf = (body: unknown) => (body as LoginResponse).errors?.[0];

  beforeAll(async () => {
    app = await createApp();
    db = createKnex(process.env.DATABASE_URL!);
  });

  beforeEach(async () => {
    await db('sessions').delete();
    await db('users').delete();
    // Another spec may leave auth.phoneRequiredAt = signup behind, and register would fail.
    await db('client_setting_changes').delete();
    await db('client_settings').delete();
    await register().expect(200);
  });

  afterAll(async () => {
    await db.destroy();
    await app.close();
  });

  it('returns an access token and sets the refresh token cookie of a new session', async () => {
    const res = await login(PASSWORD, ' ARTEM@test.com ').expect(200);
    const body = res.body as LoginResponse;

    expect(body.errors).toBeUndefined();
    expect(body.data?.login.user).toEqual({ id: expect.any(String), email: 'artem@test.com' });

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(
      /^refresh_token=[\w-]{43}; Path=\/graphql; Expires=.+; HttpOnly; SameSite=Strict$/,
    );
    const refreshToken = /^refresh_token=([\w-]+);/.exec(cookies[0])![1];

    const [session] = await db('sessions').select('user_id', 'refresh_token_hash', 'revoked_at');
    expect(session).toEqual({
      user_id: body.data?.login.user.id,
      refresh_token_hash: hashRefreshToken(refreshToken),
      revoked_at: null,
    });

    const claims: unknown = new JwtService().verify(body.data!.login.accessToken, {
      secret: LOCAL_JWT_SECRET,
      algorithms: ['HS256'],
      issuer: 'wallet-core',
    });
    expect(accessTokenPayloadSchema.parse(claims)).toMatchObject({
      sub: body.data?.login.user.id,
      permissions: ['wallet'],
    });
  });

  it('answers INVALID_CREDENTIALS for an unknown email or a wrong password, without a cookie', async () => {
    for (const res of [await login(PASSWORD, 'other@test.com'), await login('Wrong1!pass')]) {
      expect(errorOf(res.body)).toMatchObject({
        message: 'Invalid email or password',
        extensions: { code: 'INVALID_CREDENTIALS' },
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    await expect(db('sessions').select('id')).resolves.toEqual([]);
  });

  it('locks the account on the fifth wrong password, also for the right one, for 15 minutes', async () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(errorOf((await login('Wrong1!pass')).body)?.extensions.code).toBe(
        'INVALID_CREDENTIALS',
      );
    }
    const before = Date.now();
    const locked = errorOf((await login('Wrong1!pass')).body);
    expect(locked?.extensions.code).toBe('ACCOUNT_LOCKED');
    const lockedUntil = Date.parse(locked?.extensions.lockedUntil as string);
    expect(lockedUntil - before).toBeGreaterThanOrEqual(15 * 60 * 1000 - 1000);
    expect(lockedUntil - before).toBeLessThanOrEqual(15 * 60 * 1000 + 5000);

    const rightPassword = await login();
    expect(errorOf(rightPassword.body)).toMatchObject({
      extensions: { code: 'ACCOUNT_LOCKED', lockedUntil: locked?.extensions.lockedUntil },
    });
    expect(rightPassword.headers['set-cookie']).toBeUndefined();
  });

  it('logs in after the lock has expired and resets the counter', async () => {
    await db('users').update({
      failed_login_attempts: 3,
      locked_until: new Date(Date.now() - 1000),
    });

    const res = await login();
    expect((res.body as LoginResponse).errors).toBeUndefined();
    await expect(db('users').first('failed_login_attempts', 'locked_until')).resolves.toEqual({
      failed_login_attempts: 0,
      locked_until: null,
    });
  });
});
