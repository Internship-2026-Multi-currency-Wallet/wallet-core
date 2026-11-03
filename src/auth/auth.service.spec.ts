import { jest } from '@jest/globals';
import { verify } from '@node-rs/argon2';
import { GraphQLError } from 'graphql';
import type { PinoLogger } from 'nestjs-pino';
import type { ClientSettingsService } from '../settings/client-settings.service.js';
import { type ClientSettings, settingsCatalog } from '../settings/settings.schema.js';
import { AuthService } from './auth.service.js';
import type { InsertUserResult, NewUser, UsersRepository } from './users.repository.js';

const PASSWORD = 'Qwerty1!';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type PhoneRequiredAt = ClientSettings['auth.phoneRequiredAt'];
const PHONE_REQUIRED_AT: readonly PhoneRequiredAt[] =
  settingsCatalog['auth.phoneRequiredAt'].schema.options;

function setup(options: { insert?: InsertUserResult; phoneRequiredAt?: PhoneRequiredAt } = {}) {
  const users = {
    insert: jest.fn((_user: NewUser) => Promise.resolve(options.insert ?? 'created')),
  };
  const settings = {
    get: jest.fn((_key: string) => Promise.resolve(options.phoneRequiredAt ?? 'never')),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new AuthService(
    users as unknown as UsersRepository,
    settings as unknown as ClientSettingsService,
    logger as unknown as PinoLogger,
  );
  return { service, users, settings, logger };
}

/** The row the service handed to the repository. */
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
    const { service } = setup({ insert: 'emailTaken' });
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
    for (const insert of ['created', 'emailTaken'] as const) {
      const { service, logger } = setup({ insert });
      await service.register({ email: 'artem@test.com', password: PASSWORD }).catch(() => {});
      const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
      expect(logged).not.toContain(PASSWORD);
      expect(logged).not.toContain('artem@test.com');
    }
  });
});
