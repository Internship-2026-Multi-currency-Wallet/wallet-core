import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { ClientSettingsService } from './client-settings.service.js';
import type { SettingOverride, SettingsRepository } from './settings.repository.js';
import { type SettingKey, settingsCatalog } from './settings.schema.js';

/** In-memory stand-in for the overrides table. */
function fakeRepository(rows: SettingOverride[] = []) {
  return {
    find: jest.fn((key: string) => Promise.resolve(rows.find((row) => row.key === key))),
    findAll: jest.fn(() => Promise.resolve(rows)),
  };
}

function setup(rows: SettingOverride[] = []) {
  const repository = fakeRepository(rows);
  const logger = { warn: jest.fn(), setContext: jest.fn() };
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

  it('knows the current client', () => {
    expect(setup().service.client).toBe('kvitka');
  });
});
