import { jest } from '@jest/globals';
import { z } from 'zod';
import type { ClientSettingsService, EffectiveSetting } from './client-settings.service.js';
import { SettingType } from './settings.model.js';
import { SettingsResolver } from './settings.resolver.js';
import { settingsCatalog } from './settings.schema.js';

function setup(settings: EffectiveSetting[]) {
  const service = { getAll: jest.fn(() => Promise.resolve(settings)) };
  const resolver = new SettingsResolver(service as unknown as ClientSettingsService);
  return { resolver, service };
}

const effective: EffectiveSetting[] = [
  { key: 'auth.googleLogin', value: false, overridden: true },
  { key: 'auth.phoneRequiredAt', value: 'never', overridden: false },
  { key: 'products.enabled', value: ['wallet', 'cards'], overridden: true },
];

describe('SettingsResolver (reads)', () => {
  describe('staffSettings', () => {
    it('returns every setting with type, allowed values, default and override state', async () => {
      const { resolver, service } = setup(effective);
      await expect(resolver.staffSettings()).resolves.toEqual([
        {
          key: 'auth.googleLogin',
          type: SettingType.BOOLEAN,
          public: true,
          value: false,
          defaultValue: true,
          overridden: true,
        },
        {
          key: 'auth.phoneRequiredAt',
          type: SettingType.ENUM,
          allowedValues: ['signup', 'firstTransfer', 'never'],
          public: true,
          value: 'never',
          defaultValue: 'never',
          overridden: false,
        },
        {
          key: 'products.enabled',
          type: SettingType.STRING_LIST,
          public: true,
          value: ['wallet', 'cards'],
          defaultValue: ['wallet'],
          overridden: true,
        },
      ]);
      expect(service.getAll).toHaveBeenCalledTimes(1);
    });

    it('returns copies of the defaults', async () => {
      const { resolver } = setup(effective);
      const [, , products] = await resolver.staffSettings();
      (products.defaultValue as string[]).push('hacked');
      expect(settingsCatalog['products.enabled'].default).toEqual(['wallet']);
    });
  });

  describe('publicSettings', () => {
    it('returns key and effective value of the public settings', async () => {
      const { resolver } = setup(effective);
      await expect(resolver.publicSettings()).resolves.toEqual([
        { key: 'auth.googleLogin', value: false },
        { key: 'auth.phoneRequiredAt', value: 'never' },
        { key: 'products.enabled', value: ['wallet', 'cards'] },
      ]);
    });

    it('never returns a setting the catalog marks as private', async () => {
      // Today every setting is public; add a private one for this test only.
      const catalog = settingsCatalog as Record<string, unknown>;
      catalog['test.private'] = { schema: z.boolean(), default: false, public: false };
      try {
        const { resolver } = setup([
          ...effective,
          { key: 'test.private' as EffectiveSetting['key'], value: true, overridden: true },
        ]);
        const keys = (await resolver.publicSettings()).map((setting) => setting.key);
        expect(keys).not.toContain('test.private');
        expect(keys).toHaveLength(3);
      } finally {
        delete catalog['test.private'];
      }
    });
  });
});
