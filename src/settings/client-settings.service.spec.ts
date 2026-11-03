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
        isValid: expect.any(Function),
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
        isValid: expect.any(Function),
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

    it.each(['update', 'reset'] as const)(
      '%s lets the repository check a stored value against the catalog schema',
      async (method) => {
        const { service, repository } = setup();
        await (method === 'update'
          ? service.update('auth.phoneRequiredAt', 'signup', '7')
          : service.reset('auth.phoneRequiredAt', '7'));
        const { isValid } = repository.applyChange.mock.calls[0][0];
        expect(isValid('signup')).toBe(true);
        expect(isValid('sometimes')).toBe(false);
      },
    );

    it('returns a copy of the default', async () => {
      const { service } = setup();
      const result = await service.reset('products.enabled', '7');
      (result.value as string[]).push('hacked');
      expect(settingsCatalog['products.enabled'].default).toEqual(['wallet']);
    });
  });

  describe('history', () => {
    const row = {
      id: '11',
      key: 'auth.googleLogin',
      oldValue: true,
      newValue: false,
      changedBy: '7',
      changedAt: new Date('2026-11-02T10:00:00.000Z'),
    };

    function withHistory(rows = [row]) {
      const ctx = setup();
      const history = jest.fn(() => Promise.resolve(rows));
      Object.assign(ctx.repository, { history });
      return { ...ctx, history };
    }

    it('returns the repository rows, passing key, before and limit through', async () => {
      const { service, history } = withHistory();
      const before = new Date('2026-11-02T12:00:00.000Z');
      await expect(
        service.history({ key: 'auth.googleLogin', before, limit: 50 }),
      ).resolves.toEqual([row]);
      expect(history).toHaveBeenCalledWith({ key: 'auth.googleLogin', before, limit: 50 });
    });

    it('works without key and before (all keys, newest first)', async () => {
      const { service, history } = withHistory();
      await service.history({ limit: 200 });
      expect(history).toHaveBeenCalledWith({ key: undefined, before: undefined, limit: 200 });
    });

    it('rejects an unknown key filter with UNKNOWN_KEY', async () => {
      const { service, history } = withHistory();
      const error = await graphqlErrorOf(service.history({ key: 'nope.nothing', limit: 50 }));
      expect(error.extensions.code).toBe('UNKNOWN_KEY');
      expect(error.message).toBe('Unknown setting "nope.nothing"');
      expect(history).not.toHaveBeenCalled();
    });

    it('passes the (before, beforeId) cursor through', async () => {
      const { service, history } = withHistory();
      const before = new Date('2026-11-02T12:00:00.000Z');
      await service.history({ before, beforeId: '11', limit: 50 });
      expect(history).toHaveBeenCalledWith({ key: undefined, before, beforeId: '11', limit: 50 });
    });

    it('rejects beforeId without before with INVALID_VALUE', async () => {
      const { service, history } = withHistory();
      const error = await graphqlErrorOf(service.history({ beforeId: '11', limit: 50 }));
      expect(error.extensions.code).toBe('INVALID_VALUE');
      expect(error.message).toBe('beforeId requires before');
      expect(history).not.toHaveBeenCalled();
    });

    it.each(['abc', '0', '-1', '1.5', ''])(
      'rejects beforeId %p that is not a row id with INVALID_VALUE',
      async (beforeId) => {
        const { service, history } = withHistory();
        const before = new Date('2026-11-02T12:00:00.000Z');
        const error = await graphqlErrorOf(service.history({ before, beforeId, limit: 50 }));
        expect(error.extensions.code).toBe('INVALID_VALUE');
        expect(error.message).toBe(`Invalid beforeId "${beforeId}": must be a row id`);
        expect(history).not.toHaveBeenCalled();
      },
    );

    it.each([0, -1, 201])('rejects limit %d with INVALID_VALUE', async (limit) => {
      const { service, history } = withHistory();
      const error = await graphqlErrorOf(service.history({ limit }));
      expect(error.extensions.code).toBe('INVALID_VALUE');
      expect(error.message).toBe(`Invalid limit ${limit}: must be between 1 and 200`);
      expect(history).not.toHaveBeenCalled();
    });
  });

  it('knows the current client', () => {
    expect(setup().service.client).toBe('kvitka');
  });
});
