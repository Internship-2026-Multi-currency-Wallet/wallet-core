import { jest } from '@jest/globals';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { GraphQLError } from 'graphql';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import type { ClientSettingsService } from '../settings/client-settings.service.js';
import { type ClientSettings, settingsCatalog } from '../settings/settings.schema.js';
import { accessTokenPayloadSchema } from './access-token.js';
import { AuthService } from './auth.service.js';
import type { ActiveSession, NewSession, SessionsRepository } from './sessions.repository.js';
import { TokenService, hashRefreshToken } from './tokens.js';
import type { User } from './user.model.js';
import {
  InsertUserResult,
  type LoginLockPolicy,
  type NewUser,
  type UserCredentials,
  type UsersRepository,
} from './users.repository.js';

const PASSWORD = 'Qwerty1!';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type PhoneRequiredAt = ClientSettings['auth.phoneRequiredAt'];
const PHONE_REQUIRED_AT: readonly PhoneRequiredAt[] =
  settingsCatalog['auth.phoneRequiredAt'].schema.options;

interface SetupOptions {
  insert?: InsertUserResult;
  phoneRequiredAt?: PhoneRequiredAt;
  /** What findByEmail answers. */
  credentials?: UserCredentials | null;
  /** What recordFailedLogin answers. */
  lockedUntil?: Date | null;
  /** What recordSuccessfulLogin answers. */
  lockedMeanwhile?: Date | null;
  /** What sessions.rotate answers. */
  rotated?: ActiveSession | null;
}

const config = AppConfig.fromEnv({});

function setup(options: SetupOptions = {}) {
  const users = {
    insert: jest.fn((_user: NewUser) =>
      Promise.resolve(options.insert ?? InsertUserResult.Created),
    ),
    findByEmail: jest.fn((_email: string) => Promise.resolve(options.credentials ?? null)),
    recordFailedLogin: jest.fn((_userId: string, _policy: LoginLockPolicy) =>
      Promise.resolve(options.lockedUntil ?? null),
    ),
    recordSuccessfulLogin: jest.fn((_userId: string, _now: Date) =>
      Promise.resolve(options.lockedMeanwhile ?? null),
    ),
  };
  const sessions = {
    create: jest.fn((_session: NewSession) => Promise.resolve()),
    rotate: jest.fn((_hash: string, _newHash: string, _now: Date) =>
      Promise.resolve(options.rotated ?? null),
    ),
    revoke: jest.fn((_hash: string, _now: Date) => Promise.resolve()),
    revokeAllOfUser: jest.fn((_userId: string, _now: Date, _except?: string) => Promise.resolve(3)),
  };
  const settings = {
    get: jest.fn((_key: string) => Promise.resolve(options.phoneRequiredAt ?? 'never')),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new AuthService(
    users as unknown as UsersRepository,
    sessions as unknown as SessionsRepository,
    new TokenService(new JwtService(), config),
    settings as unknown as ClientSettingsService,
    config,
    logger as unknown as PinoLogger,
  );
  return { service, users, sessions, settings, logger };
}

function inserted(users: ReturnType<typeof setup>['users']): NewUser {
  expect(users.insert).toHaveBeenCalledTimes(1);
  return users.insert.mock.calls[0][0];
}

async function graphqlErrorOf(promise: Promise<unknown>): Promise<GraphQLError> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(GraphQLError);
  return error as GraphQLError;
}

describe('AuthService.register', () => {
  it('creates the user and returns it without logging in', async () => {
    const { service, users } = setup();
    const user = await service.register({ email: '  Artem@Test.com ', password: PASSWORD });

    expect(user).toEqual({ id: expect.stringMatching(UUID), email: 'artem@test.com', phone: null });
    expect(inserted(users)).toEqual({
      id: user.id,
      email: 'artem@test.com',
      passwordHash: expect.any(String),
      phone: null,
      createdAt: expect.any(Date),
    });
  });

  it('stores an argon2 hash of the password, never the password', async () => {
    const { service, users } = setup();
    await service.register({ email: 'artem@test.com', password: PASSWORD });

    const { passwordHash } = inserted(users);
    expect(passwordHash).toMatch(/^\$argon2id\$/);
    expect(passwordHash).not.toContain(PASSWORD);
    await expect(verify(passwordHash, PASSWORD)).resolves.toBe(true);
  });

  it('keeps the phone', async () => {
    const { service, users } = setup();
    const user = await service.register({
      email: 'artem@test.com',
      password: PASSWORD,
      phone: '+380501234567',
    });
    expect(user.phone).toBe('+380501234567');
    expect(inserted(users).phone).toBe('+380501234567');
  });

  it('rejects invalid input before touching the database', async () => {
    const { service, users } = setup();
    const error = await graphqlErrorOf(
      service.register({ email: 'artem@test.com', password: 'short' }),
    );
    expect(error.extensions).toEqual({ code: 'BAD_USER_INPUT', field: 'password' });
    expect(users.insert).not.toHaveBeenCalled();
  });

  describe('when the client requires a phone at signup', () => {
    it('rejects a registration without a phone', async () => {
      const { service, users, settings } = setup({ phoneRequiredAt: 'signup' });
      const error = await graphqlErrorOf(
        service.register({ email: 'artem@test.com', password: PASSWORD }),
      );
      expect(settings.get).toHaveBeenCalledWith('auth.phoneRequiredAt');
      expect(error.message).toBe('Phone is required');
      expect(error.extensions).toEqual({ code: 'BAD_USER_INPUT', field: 'phone' });
      expect(users.insert).not.toHaveBeenCalled();
    });

    it('accepts a registration with a phone', async () => {
      const { service } = setup({ phoneRequiredAt: 'signup' });
      await expect(
        service.register({ email: 'artem@test.com', password: PASSWORD, phone: '+380501234567' }),
      ).resolves.toMatchObject({ phone: '+380501234567' });
    });
  });

  it.each(PHONE_REQUIRED_AT.filter((value) => value !== 'signup'))(
    'does not require a phone when auth.phoneRequiredAt is %s',
    async (phoneRequiredAt) => {
      const { service } = setup({ phoneRequiredAt });
      await expect(
        service.register({ email: 'artem@test.com', password: PASSWORD }),
      ).resolves.toMatchObject({ phone: null });
    },
  );

  it('answers EMAIL_ALREADY_REGISTERED for a taken email', async () => {
    const { service } = setup({ insert: InsertUserResult.EmailTaken });
    const error = await graphqlErrorOf(
      service.register({ email: 'artem@test.com', password: PASSWORD }),
    );
    expect(error.message).toBe('Email is already registered');
    expect(error.extensions).toEqual({ code: 'EMAIL_ALREADY_REGISTERED' });
  });

  it('rethrows unexpected repository errors', async () => {
    const { service, users } = setup();
    users.insert.mockRejectedValueOnce(new Error('connection lost'));
    await expect(service.register({ email: 'artem@test.com', password: PASSWORD })).rejects.toThrow(
      'connection lost',
    );
  });

  it('logs neither the password nor the email', async () => {
    for (const insert of Object.values(InsertUserResult)) {
      const { service, logger } = setup({ insert });
      await service.register({ email: 'artem@test.com', password: PASSWORD }).catch(() => {});
      const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
      expect(logged).not.toContain(PASSWORD);
      expect(logged).not.toContain('artem@test.com');
    }
  });
});

describe('AuthService.login', () => {
  const USER_ID = '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b';
  const NOW = new Date('2026-11-04T10:00:00.000Z');
  const LOCKED_UNTIL = new Date('2026-11-04T10:15:00.000Z');
  let credentials: UserCredentials;

  beforeAll(async () => {
    credentials = {
      id: USER_ID,
      email: 'artem@test.com',
      phone: null,
      passwordHash: await hash(PASSWORD),
      lockedUntil: null,
    };
  });

  const login = (service: AuthService, password = PASSWORD, email = 'artem@test.com') =>
    service.login({ email, password }, undefined, NOW);

  it('creates a session and returns an access token for the user', async () => {
    const { service, users, sessions } = setup({ credentials });
    const result = await login(service, PASSWORD, '  Artem@Test.com ');

    expect(users.findByEmail).toHaveBeenCalledWith('artem@test.com');
    expect(users.recordSuccessfulLogin).toHaveBeenCalledWith(USER_ID, NOW);
    expect(result.payload.user).toEqual({ id: USER_ID, email: 'artem@test.com', phone: null });
    expect(result.payload.accessTokenExpiresAt).toEqual(new Date('2026-11-04T10:15:00.000Z'));
    expect(result.sessionExpiresAt).toEqual(new Date('2026-12-04T10:00:00.000Z'));
    expect(sessions.create).toHaveBeenCalledWith({
      id: expect.stringMatching(UUID),
      userId: USER_ID,
      refreshTokenHash: hashRefreshToken(result.refreshToken),
      expiresAt: result.sessionExpiresAt,
      createdAt: NOW,
    });

    const claims: unknown = new JwtService().verify(result.payload.accessToken, {
      secret: config.jwt.secret,
      algorithms: ['HS256'],
      issuer: 'wallet-core',
      ignoreExpiration: true,
    });
    expect(accessTokenPayloadSchema.parse(claims)).toMatchObject({
      sub: USER_ID,
      permissions: ['wallet'],
    });
  });

  it('closes the session of the cookie the browser still sent', async () => {
    const { service, sessions } = setup({ credentials });
    await service.login({ email: 'artem@test.com', password: PASSWORD }, 'old-token', NOW);
    expect(sessions.revoke).toHaveBeenCalledWith(hashRefreshToken('old-token'), NOW);
  });

  it('closes no session without a previous cookie or when the login fails', async () => {
    const { service, sessions } = setup({ credentials });
    await login(service);
    await service
      .login({ email: 'artem@test.com', password: 'Wrong1!pass' }, 'old-token', NOW)
      .catch(() => undefined);
    expect(sessions.revoke).not.toHaveBeenCalled();
  });

  it('answers INVALID_CREDENTIALS for an unknown email', async () => {
    const { service, users, sessions } = setup({ credentials: null });
    const error = await graphqlErrorOf(login(service));
    expect(error.message).toBe('Invalid email or password');
    expect(error.extensions).toEqual({ code: 'INVALID_CREDENTIALS' });
    expect(users.recordFailedLogin).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('answers INVALID_CREDENTIALS for a too long password without looking up the user', async () => {
    const { service, users } = setup({ credentials });
    const error = await graphqlErrorOf(login(service, `${PASSWORD}${'x'.repeat(121)}`));
    expect(error.extensions).toEqual({ code: 'INVALID_CREDENTIALS' });
    expect(users.findByEmail).not.toHaveBeenCalled();
  });

  it('counts a wrong password and answers INVALID_CREDENTIALS', async () => {
    const { service, users, sessions } = setup({ credentials, lockedUntil: null });
    const error = await graphqlErrorOf(login(service, 'Wrong1!pass'));

    expect(error.extensions).toEqual({ code: 'INVALID_CREDENTIALS' });
    expect(users.recordFailedLogin).toHaveBeenCalledWith(USER_ID, {
      now: NOW,
      maxFailedAttempts: 5,
      lockDurationMs: 15 * 60 * 1000,
    });
    expect(users.recordSuccessfulLogin).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('answers ACCOUNT_LOCKED when the wrong password locks the account', async () => {
    const { service } = setup({ credentials, lockedUntil: LOCKED_UNTIL });
    const error = await graphqlErrorOf(login(service, 'Wrong1!pass'));
    expect(error.message).toBe('Account is locked until 2026-11-04T10:15:00.000Z');
    expect(error.extensions).toEqual({
      code: 'ACCOUNT_LOCKED',
      lockedUntil: '2026-11-04T10:15:00.000Z',
    });
  });

  it('answers ACCOUNT_LOCKED while locked, even for the right password, without counting', async () => {
    const { service, users, sessions } = setup({
      credentials: { ...credentials, lockedUntil: LOCKED_UNTIL },
    });
    const error = await graphqlErrorOf(login(service));
    expect(error.extensions).toEqual({
      code: 'ACCOUNT_LOCKED',
      lockedUntil: '2026-11-04T10:15:00.000Z',
    });
    expect(users.recordFailedLogin).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('logs in once the lock has expired', async () => {
    const { service } = setup({
      credentials: { ...credentials, lockedUntil: new Date('2026-11-04T09:59:59.999Z') },
    });
    await expect(login(service)).resolves.toMatchObject({ payload: { user: { id: USER_ID } } });
  });

  it('answers ACCOUNT_LOCKED for the right password when parallel failures locked the account meanwhile', async () => {
    const { service, sessions } = setup({ credentials, lockedMeanwhile: LOCKED_UNTIL });
    const error = await graphqlErrorOf(login(service));
    expect(error.extensions).toEqual({
      code: 'ACCOUNT_LOCKED',
      lockedUntil: '2026-11-04T10:15:00.000Z',
    });
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('logs neither the password, the email nor a token', async () => {
    for (const options of [
      { credentials },
      { credentials: null },
      { credentials, lockedUntil: LOCKED_UNTIL },
    ]) {
      const { service, logger } = setup(options);
      const result = await login(service).catch(() => undefined);
      await login(service, 'Wrong1!pass').catch(() => undefined);
      const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
      expect(logged).not.toContain(PASSWORD);
      expect(logged).not.toContain('artem@test.com');
      if (result) {
        expect(logged).not.toContain(result.refreshToken);
        expect(logged).not.toContain(result.payload.accessToken);
      }
    }
  });
});

describe('AuthService.refreshSession', () => {
  const NOW = new Date('2026-11-10T10:00:00.000Z');
  const SESSION_END = new Date('2026-12-04T10:00:00.000Z');
  const user: User = {
    id: '0b6f3c2e-8d4a-4f7e-9c1b-2a5d6e7f8a9b',
    email: 'artem@test.com',
    phone: null,
  };

  it('rotates the refresh token and keeps the session end', async () => {
    const { service, sessions } = setup({
      rotated: { user, expiresAt: SESSION_END },
    });
    const result = await service.refreshSession('old-token', NOW);

    expect(sessions.rotate).toHaveBeenCalledWith(
      hashRefreshToken('old-token'),
      hashRefreshToken(result.refreshToken),
      NOW,
    );
    expect(result.refreshToken).not.toBe('old-token');
    expect(result.sessionExpiresAt).toEqual(SESSION_END);
    expect(result.payload.user).toEqual(user);
    expect(result.payload.accessTokenExpiresAt).toEqual(new Date('2026-11-10T10:15:00.000Z'));
  });

  it.each([
    ['no cookie', undefined, {}],
    ['no active session with the token', 'old-token', { rotated: null }],
  ])('answers INVALID_REFRESH_TOKEN for %s', async (_case, token, options: SetupOptions) => {
    const { service } = setup(options);
    const error = await graphqlErrorOf(service.refreshSession(token, NOW));
    expect(error.message).toBe('Session expired, please log in again');
    expect(error.extensions).toEqual({ code: 'INVALID_REFRESH_TOKEN' });
  });
});

describe('AuthService.logout', () => {
  const NOW = new Date('2026-11-10T10:00:00.000Z');

  it('closes the session of the cookie', async () => {
    const { service, sessions } = setup();
    await service.logout('token', NOW);
    expect(sessions.revoke).toHaveBeenCalledWith(hashRefreshToken('token'), NOW);
  });

  it('does nothing without a cookie', async () => {
    const { service, sessions } = setup();
    await service.logout(undefined, NOW);
    expect(sessions.revoke).not.toHaveBeenCalled();
  });

  describe('endOtherSessions', () => {
    const NOW = new Date('2026-11-13T10:00:00.000Z');

    it('ends every session of the user except the one of the given refresh token', async () => {
      const { service, sessions } = setup();
      await expect(service.endOtherSessions('u1', 'keep-me', NOW)).resolves.toBe(3);
      expect(sessions.revokeAllOfUser).toHaveBeenCalledWith('u1', NOW, hashRefreshToken('keep-me'));
    });

    it('ends all of them without a refresh token', async () => {
      const { service, sessions } = setup();
      await service.endOtherSessions('u1', undefined, NOW);
      expect(sessions.revokeAllOfUser).toHaveBeenCalledWith('u1', NOW, undefined);
    });
  });
});
