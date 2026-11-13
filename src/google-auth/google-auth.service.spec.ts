import { jest } from '@jest/globals';
import { JwtService } from '@nestjs/jwt';
import { GraphQLError } from 'graphql';
import type { PinoLogger } from 'nestjs-pino';
import type { AuthService, LoginResult } from '../auth/auth.service.js';
import type { User } from '../auth/user.model.js';
import { AppConfig } from '../config/app-config.js';
import type { ClientSettingsService } from '../settings/client-settings.service.js';
import {
  type GoogleAccountsRepository,
  type GoogleLoginUser,
  LinkGoogleResult,
  type LinkedGoogleAccount,
} from './google-accounts.repository.js';
import { GoogleAuthStateService } from './google-auth-state.js';
import type { GoogleAuthInput } from './google-auth.inputs.js';
import { type GoogleAuthCookies, GoogleAuthService } from './google-auth.service.js';
import {
  type GoogleAuthCode,
  type GoogleIdentity,
  type GoogleIdentityVerifier,
  InvalidGoogleCodeError,
} from './google-identity.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-11-13T10:00:00.000Z');
const REDIRECT_URI = 'http://localhost:5173/auth/google/callback';
const SUB = 'google-sub-1';
const EMAIL = 'user@gmail.com';
const LINKED: LinkedGoogleAccount = {
  userId: USER_ID,
  googleSub: SUB,
  email: EMAIL,
  linkedAt: new Date('2026-11-01T00:00:00.000Z'),
};
const LOGIN_USER: GoogleLoginUser = {
  id: USER_ID,
  email: 'user@example.com',
  phone: null,
  lockedUntil: null,
};
const LOGIN_RESULT: LoginResult = {
  payload: {
    accessToken: 'access',
    accessTokenExpiresAt: NOW,
    user: { id: USER_ID, email: 'user@example.com', phone: null },
  },
  refreshToken: 'refresh',
  sessionExpiresAt: NOW,
};

const config = AppConfig.fromEnv({
  CORS_ORIGINS: 'http://localhost:5173, https://wallet.example/',
});

interface SetupOptions {
  googleLogin?: boolean;
  verifier?: GoogleIdentityVerifier | null;
  identity?: Partial<GoogleIdentity>;
  insert?: LinkGoogleResult;
  linked?: LinkedGoogleAccount | null;
  loginUser?: GoogleLoginUser | null;
  deleted?: boolean;
}

function setup(options: SetupOptions = {}) {
  const states = new GoogleAuthStateService(new JwtService(), config);
  let startedNonce: string | undefined;
  const verify = jest.fn((_code: GoogleAuthCode) =>
    Promise.resolve<GoogleIdentity>({
      sub: SUB,
      email: EMAIL,
      emailVerified: true,
      nonce: startedNonce,
      ...options.identity,
    }),
  );
  const verifier = options.verifier === undefined ? { verify } : options.verifier;
  const accounts = {
    insert: jest.fn((_account: LinkedGoogleAccount) =>
      Promise.resolve(options.insert ?? LinkGoogleResult.Linked),
    ),
    findByUser: jest.fn((_userId: string) => Promise.resolve(options.linked ?? null)),
    findUserBySub: jest.fn((_sub: string) =>
      Promise.resolve(options.loginUser === undefined ? LOGIN_USER : options.loginUser),
    ),
    deleteByUser: jest.fn((_userId: string) => Promise.resolve(options.deleted ?? true)),
  };
  const auth = {
    startSession: jest.fn((_user: User, _previous: string | undefined, _now: Date) =>
      Promise.resolve(LOGIN_RESULT),
    ),
    endOtherSessions: jest.fn((_userId: string, _keep: string | undefined, _now: Date) =>
      Promise.resolve(2),
    ),
  };
  const settings = {
    get: jest.fn((_key: string) => Promise.resolve(options.googleLogin ?? true)),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new GoogleAuthService(
    accounts as unknown as GoogleAccountsRepository,
    auth as unknown as AuthService,
    states,
    settings as unknown as ClientSettingsService,
    config,
    verifier,
    logger as unknown as PinoLogger,
  );

  const started = (userId: string | null, at: Date = NOW) => {
    const issued = states.issue(userId === null ? 'login' : 'link', userId, at);
    startedNonce = issued.nonce;
    const input: GoogleAuthInput = {
      code: '4/0Ab-code',
      state: issued.state,
      redirectUri: REDIRECT_URI,
    };
    const cookies: GoogleAuthCookies = { state: issued.cookie, refreshToken: 'previous' };
    return { input, cookies, issued };
  };
  return { service, started, states, verify, accounts, auth, settings, logger };
}

async function errorOf(promise: Promise<unknown>): Promise<GraphQLError> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(GraphQLError);
  return error as GraphQLError;
}

type Setup = ReturnType<typeof setup>;
type Flow = {
  userId: string | null;
  finish: (s: Setup, input: GoogleAuthInput, cookies: GoogleAuthCookies) => Promise<unknown>;
};

const FLOWS: [string, Flow][] = [
  [
    'link',
    {
      userId: USER_ID,
      finish: (s, input, cookies) => s.service.link(USER_ID, input, cookies, NOW),
    },
  ],
  ['login', { userId: null, finish: (s, input, cookies) => s.service.login(input, cookies, NOW) }],
];

describe('GoogleAuthService', () => {
  describe('start', () => {
    it('issues a link sign-in bound to the user, and a login sign-in bound to nobody', async () => {
      const { service, states } = setup();
      const link = await service.start(USER_ID, NOW);
      expect(link.expiresAt).toEqual(new Date(NOW.getTime() + 10 * 60 * 1000));
      expect(
        states.check(link.cookie, { purpose: 'link', userId: USER_ID, state: link.state }, NOW),
      ).toBe(link.nonce);

      const login = await service.start(null, NOW);
      expect(
        states.check(login.cookie, { purpose: 'login', userId: null, state: login.state }, NOW),
      ).toBe(login.nonce);
    });

    it('answers GOOGLE_LOGIN_DISABLED when the setting is off or Google is not configured', async () => {
      for (const options of [{ googleLogin: false }, { verifier: null }]) {
        const error = await errorOf(setup(options).service.start(null, NOW));
        expect(error.extensions.code).toBe('GOOGLE_LOGIN_DISABLED');
      }
    });
  });

  describe.each(FLOWS)('%s: checks before asking Google', (_name, flow) => {
    it('answers GOOGLE_LOGIN_DISABLED when the client setting is off', async () => {
      const s = setup({ googleLogin: false });
      const { input, cookies } = s.started(flow.userId);
      const error = await errorOf(flow.finish(s, input, cookies));
      expect(error.extensions.code).toBe('GOOGLE_LOGIN_DISABLED');
      expect(error.message).toBe('Sign in with Google is disabled');
      expect(s.settings.get).toHaveBeenCalledWith('auth.googleLogin');
      expect(s.verify).not.toHaveBeenCalled();
    });

    it('answers GOOGLE_LOGIN_DISABLED and warns when the Google client is not configured', async () => {
      const s = setup({ verifier: null });
      const { input, cookies } = s.started(flow.userId);
      expect((await errorOf(flow.finish(s, input, cookies))).extensions.code).toBe(
        'GOOGLE_LOGIN_DISABLED',
      );
      expect(s.logger.warn).toHaveBeenCalled();
    });

    it.each([
      ['code', { code: '  ' }],
      ['state', { state: '' }],
    ])('refuses an empty %s', async (field, change) => {
      const s = setup();
      const { input, cookies } = s.started(flow.userId);
      const error = await errorOf(flow.finish(s, { ...input, ...change }, cookies));
      expect(error.extensions).toEqual({ code: 'BAD_USER_INPUT', field });
      expect(s.verify).not.toHaveBeenCalled();
    });

    it.each([
      'https://evil.example/auth/google/callback',
      'http://localhost:5173/other',
      'http://localhost:5173/auth/google/callback/',
      'http://localhost:5173/auth/google/callback?x=1',
      'http://localhost:5174/auth/google/callback',
    ])('refuses the redirect URI %s', async (redirectUri) => {
      const s = setup();
      const { input, cookies } = s.started(flow.userId);
      const error = await errorOf(flow.finish(s, { ...input, redirectUri }, cookies));
      expect(error.extensions).toEqual({ code: 'BAD_USER_INPUT', field: 'redirectUri' });
      expect(s.verify).not.toHaveBeenCalled();
    });

    it('accepts the callback of every CORS origin, ignoring a trailing slash of the origin', async () => {
      const s = setup();
      const { input, cookies } = s.started(flow.userId);
      const redirectUri = 'https://wallet.example/auth/google/callback';
      await flow.finish(s, { ...input, redirectUri }, cookies);
      expect(s.verify).toHaveBeenCalledWith({
        code: input.code,
        redirectUri,
        codeVerifier: undefined,
      });
    });

    it('passes the PKCE code verifier to Google', async () => {
      const s = setup();
      const { input, cookies } = s.started(flow.userId);
      await flow.finish(s, { ...input, codeVerifier: 'verifier' }, cookies);
      expect(s.verify).toHaveBeenCalledWith({
        code: input.code,
        redirectUri: REDIRECT_URI,
        codeVerifier: 'verifier',
      });
    });

    it('answers INVALID_GOOGLE_STATE without the cookie of a started sign-in, without asking Google', async () => {
      const s = setup();
      const { input } = s.started(flow.userId);
      const error = await errorOf(
        flow.finish(s, input, { state: undefined, refreshToken: undefined }),
      );
      expect(error.extensions.code).toBe('INVALID_GOOGLE_STATE');
      expect(s.verify).not.toHaveBeenCalled();
    });

    it('answers INVALID_GOOGLE_STATE when the state from Google is not the one of the cookie', async () => {
      const s = setup();
      const { cookies } = s.started(flow.userId);
      const other = s.started(flow.userId);
      const error = await errorOf(flow.finish(s, other.input, cookies));
      expect(error.extensions.code).toBe('INVALID_GOOGLE_STATE');
      expect(s.verify).not.toHaveBeenCalled();
    });

    it('answers INVALID_GOOGLE_STATE for an expired sign-in', async () => {
      const s = setup();
      const { input, cookies } = s.started(flow.userId, new Date(NOW.getTime() - 11 * 60 * 1000));
      expect((await errorOf(flow.finish(s, input, cookies))).extensions.code).toBe(
        'INVALID_GOOGLE_STATE',
      );
    });

    it('answers INVALID_GOOGLE_STATE for a forged cookie', async () => {
      const s = setup();
      const { input, cookies } = s.started(flow.userId);
      const [header, payload] = cookies.state!.split('.');
      const forged = `${header}.${payload}.${'A'.repeat(43)}`;
      expect(
        (await errorOf(flow.finish(s, input, { ...cookies, state: forged }))).extensions.code,
      ).toBe('INVALID_GOOGLE_STATE');
    });

    it('answers INVALID_GOOGLE_STATE when the ID token carries the nonce of another sign-in', async () => {
      const s = setup({ identity: { nonce: 'the-attackers-nonce' } });
      const { input, cookies } = s.started(flow.userId);
      const error = await errorOf(flow.finish(s, input, cookies));
      expect(error.extensions.code).toBe('INVALID_GOOGLE_STATE');
      expect(s.accounts.insert).not.toHaveBeenCalled();
      expect(s.accounts.findUserBySub).not.toHaveBeenCalled();
    });

    it('answers INVALID_GOOGLE_STATE when the ID token has no nonce', async () => {
      const s = setup({ identity: { nonce: undefined } });
      const { input, cookies } = s.started(flow.userId);
      expect((await errorOf(flow.finish(s, input, cookies))).extensions.code).toBe(
        'INVALID_GOOGLE_STATE',
      );
    });

    it('answers GOOGLE_EMAIL_NOT_VERIFIED when Google has not verified the email', async () => {
      const s = setup({ identity: { emailVerified: false } });
      const { input, cookies } = s.started(flow.userId);
      const error = await errorOf(flow.finish(s, input, cookies));
      expect(error.extensions.code).toBe('GOOGLE_EMAIL_NOT_VERIFIED');
      expect(s.accounts.insert).not.toHaveBeenCalled();
      expect(s.accounts.findUserBySub).not.toHaveBeenCalled();
    });

    it('answers INVALID_GOOGLE_CODE when Google refuses the code', async () => {
      const verify = jest.fn(() => Promise.reject(new InvalidGoogleCodeError('refused')));
      const s = setup({ verifier: { verify } });
      const { input, cookies } = s.started(flow.userId);
      const error = await errorOf(flow.finish(s, input, cookies));
      expect(error.extensions.code).toBe('INVALID_GOOGLE_CODE');
      expect(error.message).toBe('Google sign-in failed, please try again');
      expect(s.accounts.insert).not.toHaveBeenCalled();
      expect(s.accounts.findUserBySub).not.toHaveBeenCalled();
    });

    it('lets other failures through, so they are masked as internal errors', async () => {
      const failure = new Error('timeout');
      const s = setup({ verifier: { verify: () => Promise.reject(failure) } });
      const { input, cookies } = s.started(flow.userId);
      await expect(flow.finish(s, input, cookies)).rejects.toBe(failure);
    });
  });

  it('refuses a link sign-in for logging in, and a login sign-in for linking', async () => {
    const s = setup();
    const link = s.started(USER_ID);
    expect((await errorOf(s.service.login(link.input, link.cookies, NOW))).extensions.code).toBe(
      'INVALID_GOOGLE_STATE',
    );
    const login = s.started(null);
    expect(
      (await errorOf(s.service.link(USER_ID, login.input, login.cookies, NOW))).extensions.code,
    ).toBe('INVALID_GOOGLE_STATE');
    expect(s.verify).not.toHaveBeenCalled();
  });

  describe('link', () => {
    it('stores the identity Google returned for the current user', async () => {
      const s = setup();
      const { input, cookies } = s.started(USER_ID);
      await expect(s.service.link(USER_ID, input, cookies, NOW)).resolves.toEqual({
        email: EMAIL,
        linkedAt: NOW,
      });
      expect(s.accounts.insert).toHaveBeenCalledWith({
        userId: USER_ID,
        googleSub: SUB,
        email: EMAIL,
        linkedAt: NOW,
      });
    });

    it("refuses a sign-in another user started: the attacker's code cannot reach this account", async () => {
      const s = setup();
      const { input, cookies } = s.started(OTHER_USER_ID);
      const error = await errorOf(s.service.link(USER_ID, input, cookies, NOW));
      expect(error.extensions.code).toBe('INVALID_GOOGLE_STATE');
      expect(s.verify).not.toHaveBeenCalled();
    });

    it('returns the existing link when the same Google account is linked again', async () => {
      const s = setup({ insert: LinkGoogleResult.UserHasGoogleAccount, linked: LINKED });
      const { input, cookies } = s.started(USER_ID);
      await expect(s.service.link(USER_ID, input, cookies, NOW)).resolves.toEqual({
        email: LINKED.email,
        linkedAt: LINKED.linkedAt,
      });
    });

    it('returns the existing link when a parallel request of this user linked it first', async () => {
      const s = setup({ insert: LinkGoogleResult.GoogleAccountTaken, linked: LINKED });
      const { input, cookies } = s.started(USER_ID);
      await expect(s.service.link(USER_ID, input, cookies, NOW)).resolves.toMatchObject({
        email: LINKED.email,
      });
    });

    it('answers GOOGLE_ACCOUNT_LINKED_TO_ANOTHER_USER when another user has it', async () => {
      const s = setup({ insert: LinkGoogleResult.GoogleAccountTaken, linked: null });
      const { input, cookies } = s.started(OTHER_USER_ID);
      const error = await errorOf(s.service.link(OTHER_USER_ID, input, cookies, NOW));
      expect(error.extensions.code).toBe('GOOGLE_ACCOUNT_LINKED_TO_ANOTHER_USER');
      expect(error.message).toBe('This Google account is already linked to another user');
    });

    it('answers GOOGLE_ACCOUNT_ALREADY_LINKED when the user has another Google account', async () => {
      const s = setup({
        insert: LinkGoogleResult.UserHasGoogleAccount,
        linked: { ...LINKED, googleSub: 'google-sub-other' },
      });
      const { input, cookies } = s.started(USER_ID);
      const error = await errorOf(s.service.link(USER_ID, input, cookies, NOW));
      expect(error.extensions.code).toBe('GOOGLE_ACCOUNT_ALREADY_LINKED');
    });

    it('never logs the Google email, sub, state or nonce', async () => {
      const rejected = setup({ insert: LinkGoogleResult.GoogleAccountTaken, linked: null });
      const first = rejected.started(USER_ID);
      await rejected.service.link(USER_ID, first.input, first.cookies, NOW).catch(() => undefined);
      const linked = setup();
      const second = linked.started(USER_ID);
      await linked.service.link(USER_ID, second.input, second.cookies, NOW);
      const logged = JSON.stringify(
        [rejected.logger, linked.logger].map((l) => [l.info.mock.calls, l.warn.mock.calls]),
      );
      expect(logged).toContain(USER_ID);
      for (const secret of [
        EMAIL,
        SUB,
        first.issued.state,
        first.issued.nonce,
        first.cookies.state,
      ]) {
        expect(logged).not.toContain(secret);
      }
    });
  });

  describe('unlink', () => {
    it('deletes the link and ends the other sessions, keeping the current one', async () => {
      const { service, accounts, auth } = setup();
      await expect(service.unlink(USER_ID, 'current', NOW)).resolves.toBe(true);
      expect(accounts.deleteByUser).toHaveBeenCalledWith(USER_ID);
      expect(auth.endOtherSessions).toHaveBeenCalledWith(USER_ID, 'current', NOW);
    });

    it('still ends the other sessions when nothing was linked, so a retry after a failure works', async () => {
      const { service, auth } = setup({ deleted: false });
      await expect(service.unlink(USER_ID, undefined, NOW)).resolves.toBe(true);
      expect(auth.endOtherSessions).toHaveBeenCalledWith(USER_ID, undefined, NOW);
    });

    it('works while Google login is disabled', async () => {
      const { service, accounts } = setup({ googleLogin: false, verifier: null });
      await expect(service.unlink(USER_ID, undefined, NOW)).resolves.toBe(true);
      expect(accounts.deleteByUser).toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('returns the linked account without the Google id', async () => {
      await expect(setup({ linked: LINKED }).service.get(USER_ID)).resolves.toEqual({
        email: LINKED.email,
        linkedAt: LINKED.linkedAt,
      });
    });

    it('returns null when nothing is linked', async () => {
      await expect(setup().service.get(USER_ID)).resolves.toBeNull();
    });
  });

  describe('login', () => {
    it('starts a normal session for the user the Google account is linked to', async () => {
      const s = setup();
      const { input, cookies } = s.started(null);
      await expect(s.service.login(input, cookies, NOW)).resolves.toBe(LOGIN_RESULT);
      expect(s.accounts.findUserBySub).toHaveBeenCalledWith(SUB);
      expect(s.auth.startSession).toHaveBeenCalledWith(
        { id: USER_ID, email: 'user@example.com', phone: null },
        'previous',
        NOW,
      );
    });

    it('answers GOOGLE_ACCOUNT_NOT_LINKED for an unlinked Google account', async () => {
      const s = setup({ loginUser: null });
      const { input, cookies } = s.started(null);
      const error = await errorOf(s.service.login(input, cookies, NOW));
      expect(error.extensions.code).toBe('GOOGLE_ACCOUNT_NOT_LINKED');
      expect(error.message).toBe('No account is linked to this Google account');
      expect(s.auth.startSession).not.toHaveBeenCalled();
    });

    it('answers ACCOUNT_LOCKED while the account is locked', async () => {
      const lockedUntil = new Date(NOW.getTime() + 60_000);
      const s = setup({ loginUser: { ...LOGIN_USER, lockedUntil } });
      const { input, cookies } = s.started(null);
      const error = await errorOf(s.service.login(input, cookies, NOW));
      expect(error.extensions).toEqual({
        code: 'ACCOUNT_LOCKED',
        lockedUntil: lockedUntil.toISOString(),
      });
      expect(s.auth.startSession).not.toHaveBeenCalled();
    });

    it('logs in once the lock has expired', async () => {
      const s = setup({ loginUser: { ...LOGIN_USER, lockedUntil: new Date(NOW.getTime() - 1) } });
      const { input, cookies } = s.started(null);
      await expect(s.service.login(input, cookies, NOW)).resolves.toBe(LOGIN_RESULT);
    });
  });
});
