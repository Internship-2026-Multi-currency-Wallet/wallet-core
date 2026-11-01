import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfig } from '../config/app-config.js';
import { ClientSettingsService, loadSettingsFile } from './client-settings.service.js';

describe('ClientSettingsService', () => {
  const service = new ClientSettingsService(AppConfig.fromEnv({ CLIENT: 'kvitka' }));

  it('returns typed defaults from config/settings.defaults.yaml', async () => {
    await expect(service.get('auth.phoneRequiredAt')).resolves.toBe('never');
    await expect(service.get('auth.googleLogin')).resolves.toBe(true);
    await expect(service.get('products.enabled')).resolves.toEqual(['wallet']);
  });

  it('knows the current client', () => {
    expect(service.client).toBe('kvitka');
  });

  it('returns copies, so callers cannot change the defaults', async () => {
    const enabled = await service.get('products.enabled');
    enabled.push('hacked');
    await expect(service.get('products.enabled')).resolves.toEqual(['wallet']);
  });

  it('rejects unknown keys at runtime', async () => {
    // @ts-expect-error -- unknown keys are a compile error too
    await expect(async () => service.get('nope.nothing')).rejects.toThrow(/Unknown setting/);
  });
});

describe('loadSettingsFile', () => {
  it('fails fast on an invalid file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-'));
    const file = join(dir, 'bad.yaml');
    writeFileSync(
      file,
      'auth:\n  phoneRequiredAt: sometimes\n  googleLogin: true\nproducts:\n  enabled: []\n',
    );
    expect(() => loadSettingsFile(file)).toThrow(/auth.phoneRequiredAt/);
  });
});
