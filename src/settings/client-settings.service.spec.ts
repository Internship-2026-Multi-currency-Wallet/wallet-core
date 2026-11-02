import { AppConfig } from '../config/app-config.js';
import { ClientSettingsService } from './client-settings.service.js';
import { type SettingKey, settingsCatalog } from './settings.schema.js';

describe('ClientSettingsService', () => {
  const service = new ClientSettingsService(AppConfig.fromEnv({ CLIENT: 'kvitka' }));

  it('returns typed defaults', async () => {
    await expect(service.get('auth.phoneRequiredAt')).resolves.toBe('never');
    await expect(service.get('auth.googleLogin')).resolves.toBe(true);
    await expect(service.get('products.enabled')).resolves.toEqual(['wallet']);
  });

  it.each(Object.keys(settingsCatalog) as SettingKey[])(
    'returns the catalog default for %s',
    async (key) => {
      await expect(service.get(key)).resolves.toEqual(settingsCatalog[key].default);
    },
  );

  it('knows the current client', () => {
    expect(service.client).toBe('kvitka');
  });

  it('returns copies, so callers cannot change the defaults', async () => {
    const enabled = await service.get('products.enabled');
    enabled.push('hacked');
    await expect(service.get('products.enabled')).resolves.toEqual(['wallet']);
    expect(settingsCatalog['products.enabled'].default).toEqual(['wallet']);
  });

  it('rejects unknown keys at runtime', async () => {
    // @ts-expect-error -- unknown keys are a compile error too
    await expect(async () => service.get('nope.nothing')).rejects.toThrow(/Unknown setting/);
  });
});
