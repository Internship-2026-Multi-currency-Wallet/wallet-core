import type { INestApplication } from '@nestjs/common';
import type { Knex } from 'knex';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { hashRefreshToken } from '../src/auth/tokens.js';
import { createKnex } from '../src/database/database.module.js';
import {
  GOOGLE_IDENTITY_VERIFIER,
  type GoogleAuthCode,
  type GoogleIdentity,
  type GoogleIdentityVerifier,
  InvalidGoogleCodeError,
} from '../src/google-auth/google-identity.js';
import { ClientSettingsService } from '../src/settings/client-settings.service.js';
import { createApp } from './create-app.js';

// Only Google is faked: the code `<who>|<nonce>` is Google account `<who>` signing in with `<nonce>`.
describe('google auth (e2e)', () => {
  const PASSWORD = 'Qwerty1!';
  const REDIRECT_URI = 'http://localhost:5173/auth/google/callback';
  const GOOGLE_USERS: Record<string, Omit<GoogleIdentity, 'nonce'>> = {
    a: { sub: 'google-sub-a', email: 'a@gmail.com', emailVerified: true },
    b: { sub: 'google-sub-b', email: 'b@gmail.com', emailVerified: true },
    c: { sub: 'google-sub-c', email: 'c@gmail.com', emailVerified: true },
    unverified: { sub: 'google-sub-u', email: 'u@example.com', emailVerified: false },
  };
  const googleCalls: GoogleAuthCode[] = [];
  const fakeGoogle: GoogleIdentityVerifier = {
    verify: (code) => {
      googleCalls.push(code);
      const [who, nonce] = code.code.split('|');
      const identity = GOOGLE_USERS[who];
      return identity
        ? Promise.resolve({ ...identity, nonce })
        : Promise.reject(new InvalidGoogleCodeError('unknown code'));
    },
  };

  let app: INestApplication;
  let db: Knex;

  interface GqlResponse {
    data: Record<string, unknown> | null;
    errors?: { message: string; extensions: Record<string, unknown> }[];
  }
  interface Caller {
    auth?: string;
    cookie?: string;
  }
  interface User {
    id: string;
    auth: string;
    refreshToken: string;
  }
  interface Started {
    state: string;
    nonce: string;
    expiresAt: string;
    cookie: string;
    setCookie: string;
  }

  const gql = async (
    query: string,
    variables: Record<string, unknown> = {},
    caller: Caller = {},
  ) => {
    const req = request(app.getHttpServer() as App).post('/graphql');
    if (caller.auth) req.set('Authorization', caller.auth);
    if (caller.cookie) req.set('Cookie', caller.cookie);
    const res = await req.send({ query, variables }).expect(200);
    return {
      body: res.body as GqlResponse,
      cookies: (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [],
    };
  };
  const errorOf = (body: GqlResponse) => body.errors?.[0];
  const codeOf = (body: GqlResponse) => errorOf(body)?.extensions.code;
  const cookieValue = (cookies: string[], name: string) =>
    cookies.map((c) => new RegExp(`^${name}=([^;]*);`).exec(c)?.[1]).find(Boolean);

  const START_LINK = 'mutation { startGoogleLink { state nonce expiresAt } }';
  const START_LOGIN = 'mutation { startGoogleLogin { state nonce expiresAt } }';
  const LINK =
    'mutation ($input: GoogleAuthInput!) { linkGoogleAccount(input: $input) { email linkedAt } }';
  const UNLINK = 'mutation { unlinkGoogleAccount }';
  const ACCOUNT = '{ googleAccount { email linkedAt } }';
  const LOGIN =
    'mutation ($input: GoogleAuthInput!) { loginWithGoogle(input: $input) { accessToken accessTokenExpiresAt user { id email phone } } }';
  const REFRESH = 'mutation { refreshSession { user { id } } }';

  const started = async (query: string, caller: Caller = {}): Promise<Started> => {
    const { body, cookies } = await gql(query, {}, caller);
    expect(body.errors).toBeUndefined();
    const start = Object.values(body.data!)[0] as Omit<Started, 'cookie' | 'setCookie'>;
    const setCookie = cookies.find((c) => c.startsWith('google_auth_state='))!;
    const value = cookieValue(cookies, 'google_auth_state')!;
    return { ...start, cookie: `google_auth_state=${value}`, setCookie };
  };
  const startLink = (user: User) => started(START_LINK, { auth: user.auth });
  const startLogin = () => started(START_LOGIN);

  const callback = (start: Started, who: string, extra: Record<string, unknown> = {}) => ({
    input: {
      code: `${who}|${start.nonce}`,
      state: start.state,
      redirectUri: REDIRECT_URI,
      ...extra,
    },
  });

  const link = async (user: User, who: string, extra: Record<string, unknown> = {}) => {
    const start = await startLink(user);
    return gql(LINK, callback(start, who, extra), { auth: user.auth, cookie: start.cookie });
  };
  const loginWithGoogle = async (who: string) => {
    const start = await startLogin();
    return gql(LOGIN, callback(start, who), { cookie: start.cookie });
  };

  const registered = async (email: string): Promise<User> => {
    await gql('mutation ($input: RegisterInput!) { register(input: $input) { id } }', {
      input: { email, password: PASSWORD },
    });
    return passwordLogin(email);
  };
  const passwordLogin = async (email: string): Promise<User> => {
    const { body, cookies } = await gql(
      'mutation ($input: LoginInput!) { login(input: $input) { accessToken user { id } } }',
      { input: { email, password: PASSWORD } },
    );
    const login = body.data?.login as { accessToken: string; user: { id: string } };
    return {
      id: login.user.id,
      auth: `Bearer ${login.accessToken}`,
      refreshToken: cookieValue(cookies, 'refresh_token')!,
    };
  };
  const refresh = (refreshToken: string) =>
    gql(REFRESH, {}, { cookie: `refresh_token=${refreshToken}` });

  const setGoogleLogin = (value: boolean) =>
    app.get(ClientSettingsService).update('auth.googleLogin', value, 'e2e');

  beforeAll(async () => {
    app = await createApp({}, new Map([[GOOGLE_IDENTITY_VERIFIER, fakeGoogle]]));
    db = createKnex(process.env.DATABASE_URL!);
  });

  beforeEach(async () => {
    await db('user_google_accounts').delete();
    await db('sessions').delete();
    await db('users').delete();
    await db('client_setting_changes').delete();
    await db('client_settings').delete();
    googleCalls.length = 0;
  });

  afterAll(async () => {
    await db.destroy();
    await app.close();
  });

  describe('who may call', () => {
    it.each([
      ['googleAccount', ACCOUNT],
      ['startGoogleLink', START_LINK],
      ['linkGoogleAccount', LINK],
      ['unlinkGoogleAccount', UNLINK],
    ])('%s needs a client token', async (_name, query) => {
      const variables = {
        input: { code: 'a|n', state: 's', redirectUri: REDIRECT_URI },
      };
      expect(codeOf((await gql(query, variables)).body)).toBe('UNAUTHENTICATED');
      expect(codeOf((await gql(query, variables, { auth: 'Dev 1:bo' })).body)).toBe('FORBIDDEN');
      expect(googleCalls).toHaveLength(0);
    });
  });

  describe('starting a sign-in', () => {
    it('returns state and nonce and sets the httpOnly state cookie for 10 minutes', async () => {
      const before = Date.now();
      const start = await startLogin();
      expect(start.state).toMatch(/^[\w-]{43}$/);
      expect(start.nonce).toMatch(/^[\w-]{43}$/);
      expect(start.nonce).not.toBe(start.state);
      const ttl = new Date(start.expiresAt).getTime() - before;
      expect(ttl).toBeGreaterThan(9 * 60 * 1000);
      expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
      expect(start.setCookie).toMatch(
        /^google_auth_state=[\w.-]+; Path=\/graphql; Expires=.+; HttpOnly; SameSite=Strict$/,
      );
      expect(start.setCookie).not.toContain(start.nonce);
    });
  });

  describe('linking', () => {
    it('links the Google account Google vouched for, and shows it', async () => {
      const user = await registered('a@test.com');
      expect((await gql(ACCOUNT, {}, { auth: user.auth })).body.data).toEqual({
        googleAccount: null,
      });

      const { body, cookies } = await link(user, 'a', { codeVerifier: 'pkce' });
      expect(body.errors).toBeUndefined();
      expect(body.data).toEqual({
        linkGoogleAccount: { email: 'a@gmail.com', linkedAt: expect.any(String) },
      });
      expect(googleCalls).toEqual([
        { code: expect.stringMatching(/^a\|/), redirectUri: REDIRECT_URI, codeVerifier: 'pkce' },
      ]);
      expect(cookies).toContainEqual(
        expect.stringMatching(/^google_auth_state=; .*Expires=Thu, 01 Jan 1970/),
      );
      expect((await gql(ACCOUNT, {}, { auth: user.auth })).body.data).toEqual({
        googleAccount: body.data?.linkGoogleAccount,
      });
      expect(await db('user_google_accounts').select('user_id', 'google_sub')).toEqual([
        { user_id: user.id, google_sub: 'google-sub-a' },
      ]);
    });

    it('returns the same link when the same Google account is linked again', async () => {
      const user = await registered('a@test.com');
      const first = (await link(user, 'a')).body.data;
      const again = await link(user, 'a');
      expect(again.body.errors).toBeUndefined();
      expect(again.body.data).toEqual(first);
    });

    it('refuses a Google account that is linked to another user', async () => {
      const a = await registered('a@test.com');
      const b = await registered('b@test.com');
      await link(a, 'a');

      const error = errorOf((await link(b, 'a')).body);
      expect(error?.extensions.code).toBe('GOOGLE_ACCOUNT_LINKED_TO_ANOTHER_USER');
      expect(error?.message).toBe('This Google account is already linked to another user');
      expect((await gql(ACCOUNT, {}, { auth: b.auth })).body.data).toEqual({ googleAccount: null });
    });

    it('links one Google account to one user only, also when two users link it at once', async () => {
      const users = await Promise.all(['a@test.com', 'b@test.com'].map(registered));
      const starts = await Promise.all(users.map(startLink));
      const results = await Promise.all(
        users.map((user, i) =>
          gql(LINK, callback(starts[i], 'a'), { auth: user.auth, cookie: starts[i].cookie }),
        ),
      );

      const codes = results.map(({ body }) => codeOf(body) ?? 'OK').sort();
      expect(codes).toEqual(['GOOGLE_ACCOUNT_LINKED_TO_ANOTHER_USER', 'OK']);
      expect(await db('user_google_accounts').count({ n: '*' })).toEqual([{ n: 1 }]);
    });

    it('refuses a second Google account until the first is unlinked', async () => {
      const user = await registered('a@test.com');
      await link(user, 'a');
      expect(codeOf((await link(user, 'b')).body)).toBe('GOOGLE_ACCOUNT_ALREADY_LINKED');

      await gql(UNLINK, {}, { auth: user.auth });
      expect((await link(user, 'b')).body.errors).toBeUndefined();
    });

    it('answers INVALID_GOOGLE_CODE when Google refuses the code', async () => {
      const user = await registered('a@test.com');
      expect(errorOf((await link(user, 'used-code')).body)).toMatchObject({
        message: 'Google sign-in failed, please try again',
        extensions: { code: 'INVALID_GOOGLE_CODE' },
      });
    });

    it('answers GOOGLE_EMAIL_NOT_VERIFIED for a Google account with an unverified email', async () => {
      const user = await registered('a@test.com');
      expect(codeOf((await link(user, 'unverified')).body)).toBe('GOOGLE_EMAIL_NOT_VERIFIED');
      expect(await db('user_google_accounts').count({ n: '*' })).toEqual([{ n: 0 }]);
    });

    it('refuses a redirect URI that is not a client-web callback, without asking Google', async () => {
      const user = await registered('a@test.com');
      const { body } = await link(user, 'a', {
        redirectUri: 'https://evil.example/auth/google/callback',
      });
      expect(errorOf(body)?.extensions).toMatchObject({
        code: 'BAD_USER_INPUT',
        field: 'redirectUri',
      });
      expect(googleCalls).toHaveLength(0);
    });
  });

  describe("an attacker's Google code cannot be linked to the victim", () => {
    let attacker: User;
    let victim: User;
    let attackersStart: Started;

    beforeEach(async () => {
      attacker = await registered('attacker@test.com');
      victim = await registered('victim@test.com');
      attackersStart = await startLink(attacker);
    });

    afterEach(async () => {
      expect(
        await db('user_google_accounts').where({ user_id: victim.id }).count({ n: '*' }),
      ).toEqual([{ n: 0 }]);
    });

    it('without a sign-in of its own in the victim browser', async () => {
      const { body } = await gql(LINK, callback(attackersStart, 'a'), { auth: victim.auth });
      expect(errorOf(body)).toMatchObject({
        message: 'Google sign-in expired or was started elsewhere, please start again',
        extensions: { code: 'INVALID_GOOGLE_STATE' },
      });
      expect(googleCalls).toHaveLength(0);
    });

    it('while the victim has a sign-in of their own going', async () => {
      const victimsStart = await startLink(victim);
      const { body } = await gql(LINK, callback(attackersStart, 'a'), {
        auth: victim.auth,
        cookie: victimsStart.cookie,
      });
      expect(codeOf(body)).toBe('INVALID_GOOGLE_STATE');
      expect(googleCalls).toHaveLength(0);
    });

    it("when the page also passes the victim's state, the nonce gives the code away", async () => {
      const victimsStart = await startLink(victim);
      const attackersCode = `a|${attackersStart.nonce}`;
      const { body } = await gql(
        LINK,
        { input: { code: attackersCode, state: victimsStart.state, redirectUri: REDIRECT_URI } },
        { auth: victim.auth, cookie: victimsStart.cookie },
      );
      expect(codeOf(body)).toBe('INVALID_GOOGLE_STATE');
    });

    it("even with the attacker's own cookie: the sign-in belongs to the attacker's user", async () => {
      const { body } = await gql(LINK, callback(attackersStart, 'a'), {
        auth: victim.auth,
        cookie: attackersStart.cookie,
      });
      expect(codeOf(body)).toBe('INVALID_GOOGLE_STATE');
      expect(googleCalls).toHaveLength(0);
    });
  });

  describe('unlinking', () => {
    it('removes the link, and answers true when nothing is linked', async () => {
      const user = await registered('a@test.com');
      await link(user, 'a');
      expect((await gql(UNLINK, {}, { auth: user.auth })).body.data).toEqual({
        unlinkGoogleAccount: true,
      });
      expect((await gql(ACCOUNT, {}, { auth: user.auth })).body.data).toEqual({
        googleAccount: null,
      });
      expect((await gql(UNLINK, {}, { auth: user.auth })).body.data).toEqual({
        unlinkGoogleAccount: true,
      });
    });

    it('frees the Google account for another user', async () => {
      const a = await registered('a@test.com');
      const b = await registered('b@test.com');
      await link(a, 'a');
      await gql(UNLINK, {}, { auth: a.auth });
      expect((await link(b, 'a')).body.errors).toBeUndefined();
    });

    it("ends the user's other sessions, including those started with Google, and keeps the current one", async () => {
      const user = await registered('a@test.com');
      const otherDevice = await passwordLogin('a@test.com');
      await link(user, 'a');
      const viaGoogle = await loginWithGoogle('a');
      const googleRefreshToken = cookieValue(viaGoogle.cookies, 'refresh_token')!;
      const bystander = await registered('b@test.com');

      await gql(UNLINK, {}, { auth: user.auth, cookie: `refresh_token=${user.refreshToken}` });

      expect(codeOf((await refresh(googleRefreshToken)).body)).toBe('INVALID_REFRESH_TOKEN');
      expect(codeOf((await refresh(otherDevice.refreshToken)).body)).toBe('INVALID_REFRESH_TOKEN');
      expect((await refresh(user.refreshToken)).body.errors).toBeUndefined();
      expect((await refresh(bystander.refreshToken)).body.errors).toBeUndefined();
    });
  });

  describe('loginWithGoogle', () => {
    it('starts a normal session for the linked user: access token, cookie, 30 days', async () => {
      const user = await registered('a@test.com');
      await link(user, 'a');
      await db('sessions').delete();

      const { body, cookies } = await loginWithGoogle('a');
      expect(body.errors).toBeUndefined();
      const login = body.data?.loginWithGoogle as {
        accessToken: string;
        user: { id: string; email: string; phone: null };
      };
      expect(login.user).toEqual({ id: user.id, email: 'a@test.com', phone: null });

      const refreshCookie = cookies.find((c) => c.startsWith('refresh_token='))!;
      expect(refreshCookie).toMatch(
        /^refresh_token=[\w-]{43}; Path=\/graphql; Expires=.+; HttpOnly; SameSite=Strict$/,
      );
      const refreshToken = cookieValue(cookies, 'refresh_token')!;
      const [session] = await db('sessions').select(
        'user_id',
        'refresh_token_hash',
        'created_at',
        'expires_at',
        'revoked_at',
      );
      expect(session).toMatchObject({
        user_id: user.id,
        refresh_token_hash: hashRefreshToken(refreshToken),
        revoked_at: null,
      });
      const ttlMs = (session.expires_at as Date).getTime() - (session.created_at as Date).getTime();
      expect(ttlMs).toBe(30 * 24 * 60 * 60 * 1000);

      const me = await gql('{ me { id kind } }', {}, { auth: `Bearer ${login.accessToken}` });
      expect(me.body.data).toEqual({ me: { id: user.id, kind: 'CLIENT' } });
      expect((await refresh(refreshToken)).body.data).toEqual({
        refreshSession: { user: { id: user.id } },
      });
    });

    it('answers GOOGLE_ACCOUNT_NOT_LINKED for an unlinked Google account, and starts no session', async () => {
      await registered('a@test.com');
      await db('sessions').delete();
      const { body, cookies } = await loginWithGoogle('c');
      expect(body.data).toBeNull();
      expect(errorOf(body)).toMatchObject({
        message: 'No account is linked to this Google account',
        extensions: { code: 'GOOGLE_ACCOUNT_NOT_LINKED' },
      });
      expect(cookieValue(cookies, 'refresh_token')).toBeUndefined();
      expect(await db('sessions').count({ n: '*' })).toEqual([{ n: 0 }]);
    });

    it('never creates a second account, even for a Google email that matches a registered user', async () => {
      const user = await registered('a@gmail.com');

      expect(codeOf((await loginWithGoogle('a')).body)).toBe('GOOGLE_ACCOUNT_NOT_LINKED');
      expect(await db('users').count({ n: '*' })).toEqual([{ n: 1 }]);
      expect(await db('user_google_accounts').count({ n: '*' })).toEqual([{ n: 0 }]);

      await link(user, 'a');
      const viaGoogle = (await loginWithGoogle('a')).body.data?.loginWithGoogle as {
        user: { id: string; email: string };
      };
      expect(viaGoogle.user).toEqual({ id: user.id, email: 'a@gmail.com', phone: null });
      expect((await passwordLogin('a@gmail.com')).id).toBe(user.id);
      expect(await db('users').count({ n: '*' })).toEqual([{ n: 1 }]);
    });

    it('stops working once the Google account is unlinked', async () => {
      const user = await registered('a@test.com');
      await link(user, 'a');
      await gql(UNLINK, {}, { auth: user.auth });
      expect(codeOf((await loginWithGoogle('a')).body)).toBe('GOOGLE_ACCOUNT_NOT_LINKED');
    });

    it('answers ACCOUNT_LOCKED while the account is locked', async () => {
      const user = await registered('a@test.com');
      await link(user, 'a');
      const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
      await db('users').where({ id: user.id }).update({ locked_until: lockedUntil });
      expect(codeOf((await loginWithGoogle('a')).body)).toBe('ACCOUNT_LOCKED');
    });

    it('answers INVALID_GOOGLE_CODE when Google refuses the code', async () => {
      expect(codeOf((await loginWithGoogle('used-code')).body)).toBe('INVALID_GOOGLE_CODE');
    });

    it("cannot log a browser in with somebody else's sign-in (login CSRF)", async () => {
      const user = await registered('attacker@test.com');
      await link(user, 'a');
      await db('sessions').delete();
      const attackersStart = await startLogin();

      const { body, cookies } = await gql(LOGIN, callback(attackersStart, 'a'));
      expect(codeOf(body)).toBe('INVALID_GOOGLE_STATE');
      expect(cookieValue(cookies, 'refresh_token')).toBeUndefined();
      expect(await db('sessions').count({ n: '*' })).toEqual([{ n: 0 }]);
      expect(googleCalls.filter((c) => c.code === `a|${attackersStart.nonce}`)).toHaveLength(0);
    });

    it('refuses a sign-in started for linking', async () => {
      const user = await registered('a@test.com');
      await link(user, 'a');
      const linkStart = await startLink(user);
      const { body } = await gql(LOGIN, callback(linkStart, 'a'), { cookie: linkStart.cookie });
      expect(codeOf(body)).toBe('INVALID_GOOGLE_STATE');
    });
  });

  describe('auth.googleLogin = false', () => {
    it('refuses starting, linking and logging in, but still allows unlinking', async () => {
      const user = await registered('a@test.com');
      await link(user, 'a');
      const linkStart = await startLink(user);
      const loginStart = await startLogin();
      await setGoogleLogin(false);
      googleCalls.length = 0;

      const attempts = [
        gql(START_LINK, {}, { auth: user.auth }),
        gql(START_LOGIN),
        gql(LINK, callback(linkStart, 'b'), { auth: user.auth, cookie: linkStart.cookie }),
        gql(LOGIN, callback(loginStart, 'a'), { cookie: loginStart.cookie }),
      ];
      for (const { body } of await Promise.all(attempts)) {
        expect(errorOf(body)).toMatchObject({
          message: 'Sign in with Google is disabled',
          extensions: { code: 'GOOGLE_LOGIN_DISABLED' },
        });
      }
      expect(googleCalls).toHaveLength(0);
      expect((await gql(UNLINK, {}, { auth: user.auth })).body.data).toEqual({
        unlinkGoogleAccount: true,
      });
    });
  });
});
