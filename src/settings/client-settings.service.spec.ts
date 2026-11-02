import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { ClientSettingsService } from './client-settings.service.js';
import type {
  ApplyChangeInput,
  SettingOverride,
  SettingsRepository,
} from './settings.repository.js';
import { type SettingKey, settingsCatalog } from './settings.schema.js';

/** In-memory stand-in for the overrides table. */
function fakeRepository(rows: SettingOverride[] = []) {
  return {
    find: jest.fn((key: string) => Promise.resolve(rows.find((row) => row.key === key))),
    findAll: jest.fn(() => Promise.resolve(rows)),
    applyChange: jest.fn((input: ApplyChangeInput) =>
      Promise.resolve<{ oldValue: unknown; newValue: unknown } | null>({
        oldValue: input.fallback,
        newValue: input.next ? input.next.value : input.fallback,
      }),
    ),
  };
}

/** What MySQL (mysql2) throws when it rolls a transaction back to break a deadlock. */
const deadlock = () => Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' });

async function graphqlErrorOf(promise: Promise<unknown>): Promise<GraphQLError> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(GraphQLError);
  return error as GraphQLError;
}

function setup(rows: SettingOverride[] = []) {
  const repository = fakeRepository(rows);
  const logger = { info: jest.fn(), warn: jest.fn(), setContext: jest.fn() };
  const service = new ClientSettingsService(
    AppConfig.fromEnv({ CLIENT: 'kvitka' }),
    repository as unknown as SettingsRepository,
    logger as unknown as PinoLogger,
  );
  return { service, repository, logger };
}

describe('ClientSettingsService', () => {
  describe('get', () => {
    it('returns typed defaults when there are no overrides', async () => {
      const { service } = setup();
      await expect(service.get('auth.phoneRequiredAt')).resolves.toBe('never');
      await expect(service.get('auth.googleLogin')).resolves.toBe(true);
      await expect(service.get('products.enabled')).resolves.toEqual(['wallet']);
    });

    it.each(Object.keys(settingsCatalog) as SettingKey[])(
      'returns the catalog default for %s',
      async (key) => {
        const { service } = setup();
        await expect(service.get(key)).resolves.toEqual(settingsCatalog[key].default);
      },
    );

    it('returns the override when one is stored', async () => {
      const { service, repository } = setup([{ key: 'auth.phoneRequiredAt', value: 'signup' }]);
      await expect(service.get('auth.phoneRequiredAt')).resolves.toBe('signup');
      expect(repository.find).toHaveBeenCalledWith('auth.phoneRequiredAt');
    });

    it('ignores an invalid stored value: logs a warning and returns the default', async () => {
      const { service, logger } = setup([{ key: 'auth.phoneRequiredAt', value: 'sometimes' }]);
      await expect(service.get('auth.phoneRequiredAt')).resolves.toBe('never');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'auth.phoneRequiredAt', err: expect.anything() }),
        expect.any(String),
      );
    });

    it('returns copies, so callers cannot change the defaults', async () => {
      const { service } = setup();
      const enabled = await service.get('products.enabled');
      enabled.push('hacked');
      await expect(service.get('products.enabled')).resolves.toEqual(['wallet']);
      expect(settingsCatalog['products.enabled'].default).toEqual(['wallet']);
    });

    it('rejects unknown keys at runtime without touching the database', async () => {
      const { service, repository } = setup();
      // @ts-expect-error -- unknown keys are a compile error too
      await expect(async () => service.get('nope.nothing')).rejects.toThrow(/Unknown setting/);
      expect(repository.find).not.toHaveBeenCalled();
    });
  });

  describe('getAll', () => {
    it('returns every catalog key with its effective value in one query', async () => {
      const { service, repository, logger } = setup([
        { key: 'auth.googleLogin', value: false },
        { key: 'products.enabled', value: 42 }, // invalid → default
        { key: 'removed.setting', value: true }, // no longer in the catalog → ignored
      ]);
      await expect(service.getAll()).resolves.toEqual([
        { key: 'auth.googleLogin', value: false, overridden: true },
        { key: 'auth.phoneRequiredAt', value: 'never', overridden: false },
        { key: 'products.enabled', value: ['wallet'], overridden: false },
      ]);
      expect(repository.findAll).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('rejects an unknown key with UNKNOWN_KEY and writes nothing', async () => {
      const { service, repository } = setup();
      const error = await graphqlErrorOf(service.update('nope.nothing', true, '7'));
      expect(error.extensions.code).toBe('UNKNOWN_KEY');
      expect(error.message).toBe('Unknown setting "nope.nothing"');
      expect(repository.applyChange).not.toHaveBeenCalled();
    });

    it('rejects a value that fails the catalog schema with INVALID_VALUE and writes nothing', async () => {
      const { service, repository } = setup();
      const { error: zodError } =
        settingsCatalog['auth.phoneRequiredAt'].schema.safeParse('sometimes');
      const error = await graphqlErrorOf(service.update('auth.phoneRequiredAt', 'sometimes', '7'));
      expect(error.extensions.code).toBe('INVALID_VALUE');
      expect(error.message).toBe(
        `Invalid value for "auth.phoneRequiredAt": ${zodError?.issues[0].message}`,
      );
      expect(repository.applyChange).not.toHaveBeenCalled();
    });

    it('stores the override with the default as fallback and returns the new setting', async () => {
      const { service, repository, logger } = setup();
      await expect(service.update('auth.phoneRequiredAt', 'signup', '7')).resolves.toEqual({
        key: 'auth.phoneRequiredAt',
        value: 'signup',
        overridden: true,
      });
      expect(repository.applyChange).toHaveBeenCalledWith({
        key: 'auth.phoneRequiredAt',
        next: { value: 'signup' },
        fallback: 'never',
        changedBy: '7',
        at: expect.any(Date),
      });
      expect(logger.info).toHaveBeenCalledWith(
        { key: 'auth.phoneRequiredAt', changedBy: '7', oldValue: 'never', newValue: 'signup' },
        'setting updated',
      );
    });

    it('retries the change when MySQL breaks a deadlock', async () => {
      const { service, repository } = setup();
      repository.applyChange.mockRejectedValueOnce(deadlock());
      await expect(service.update('auth.googleLogin', false, '7')).resolves.toMatchObject({
        value: false,
      });
      expect(repository.applyChange).toHaveBeenCalledTimes(2);
    });

    it('gives up after 3 deadlocks and rethrows', async () => {
      const { service, repository } = setup();
      repository.applyChange.mockRejectedValue(deadlock());
      await expect(service.update('auth.googleLogin', false, '7')).rejects.toThrow('Deadlock');
      expect(repository.applyChange).toHaveBeenCalledTimes(3);
    });

    it('does not retry other database errors', async () => {
      const { service, repository } = setup();
      repository.applyChange.mockRejectedValue(new Error('connection lost'));
      await expect(service.update('auth.googleLogin', false, '7')).rejects.toThrow(
        'connection lost',
      );
      expect(repository.applyChange).toHaveBeenCalledTimes(1);
    });
  });

  describe('reset', () => {
    it('rejects an unknown key with UNKNOWN_KEY and writes nothing', async () => {
      const { service, repository } = setup();
      const error = await graphqlErrorOf(service.reset('nope.nothing', '7'));
      expect(error.extensions.code).toBe('UNKNOWN_KEY');
      expect(error.message).toBe('Unknown setting "nope.nothing"');
      expect(repository.applyChange).not.toHaveBeenCalled();
    });

    it('removes the override, records old → default and returns the default', async () => {
      const { service, repository, logger } = setup();
      repository.applyChange.mockResolvedValueOnce({ oldValue: 'signup', newValue: 'never' });
      await expect(service.reset('auth.phoneRequiredAt', '7')).resolves.toEqual({
        key: 'auth.phoneRequiredAt',
        value: 'never',
        overridden: false,
      });
      expect(repository.applyChange).toHaveBeenCalledWith({
        key: 'auth.phoneRequiredAt',
        next: null,
        fallback: 'never',
        changedBy: '7',
        at: expect.any(Date),
      });
      expect(logger.info).toHaveBeenCalledWith(
        { key: 'auth.phoneRequiredAt', changedBy: '7', oldValue: 'signup', newValue: 'never' },
        'setting reset',
      );
    });

    it('is a no-op without an override: returns the default and logs no change', async () => {
      const { service, repository, logger } = setup();
      repository.applyChange.mockResolvedValueOnce(null);
      await expect(service.reset('products.enabled', '7')).resolves.toEqual({
        key: 'products.enabled',
        value: ['wallet'],
        overridden: false,
      });
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('returns a copy of the default', async () => {
      const { service } = setup();
      const result = await service.reset('products.enabled', '7');
      (result.value as string[]).push('hacked');
      expect(settingsCatalog['products.enabled'].default).toEqual(['wallet']);
    });
  });

  it('knows the current client', () => {
    expect(setup().service.client).toBe('kvitka');
  });
});
