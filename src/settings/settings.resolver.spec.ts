import { jest } from '@jest/globals';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth-user.js';
import { UserKind } from '../auth/user-kind.js';
import type { ClientSettingsService, EffectiveSetting } from './client-settings.service.js';
import { SettingType } from './settings.model.js';
import { SettingsResolver } from './settings.resolver.js';
import { settingsCatalog } from './settings.schema.js';

function setup(settings: EffectiveSetting[] = []) {
  const service = {
    getAll: jest.fn(() => Promise.resolve(settings)),
    update: jest.fn((key: string, value: unknown, _changedBy: string) =>
      Promise.resolve({ key, value, overridden: true } as EffectiveSetting),
    ),
    reset: jest.fn((key: string, _changedBy: string) =>
      Promise.resolve({
        key,
        value: settingsCatalog[key as EffectiveSetting['key']].default,
        overridden: false,
      } as EffectiveSetting),
    ),
    history: jest.fn((_query: { key?: string; before?: Date; limit: number }) =>
      Promise.resolve([] as unknown[]),
    ),
  };
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

describe('SettingsResolver (writes and history)', () => {
  const staff: AuthUser = {
    id: '42',
    kind: UserKind.STAFF,
    permissions: ['bo:settings:modify'],
    strategy: 'dev',
  };

  describe('updateSetting', () => {
    it('updates as the current staff user and returns the staff view of the setting', async () => {
      const { resolver, service } = setup();
      await expect(resolver.updateSetting(staff, 'auth.googleLogin', false)).resolves.toEqual({
        key: 'auth.googleLogin',
        type: SettingType.BOOLEAN,
        public: true,
        value: false,
        defaultValue: true,
        overridden: true,
      });
      expect(service.update).toHaveBeenCalledWith('auth.googleLogin', false, '42');
    });

    it('passes service errors (UNKNOWN_KEY, INVALID_VALUE) through unchanged', async () => {
      const { resolver, service } = setup();
      const error = new GraphQLError('Invalid value', { extensions: { code: 'INVALID_VALUE' } });
      service.update.mockRejectedValueOnce(error);
      await expect(resolver.updateSetting(staff, 'auth.googleLogin', 'yes')).rejects.toBe(error);
    });
  });

  describe('resetSetting', () => {
    it('resets as the current staff user and returns the default', async () => {
      const { resolver, service } = setup();
      await expect(resolver.resetSetting(staff, 'auth.phoneRequiredAt')).resolves.toEqual({
        key: 'auth.phoneRequiredAt',
        type: SettingType.ENUM,
        allowedValues: ['signup', 'firstTransfer', 'never'],
        public: true,
        value: 'never',
        defaultValue: 'never',
        overridden: false,
      });
      expect(service.reset).toHaveBeenCalledWith('auth.phoneRequiredAt', '42');
    });
  });

  describe('settingHistory', () => {
    const row = {
      id: '11',
      key: 'auth.googleLogin',
      oldValue: true,
      newValue: false,
      changedBy: '42',
      changedAt: new Date('2026-11-02T10:00:00.000Z'),
    };

    it('returns the service rows as SettingChange, passing the arguments through', async () => {
      const { resolver, service } = setup();
      service.history.mockResolvedValueOnce([row]);
      const before = new Date('2026-11-02T12:00:00.000Z');
      await expect(resolver.settingHistory('auth.googleLogin', 20, before)).resolves.toEqual([row]);
      expect(service.history).toHaveBeenCalledWith({ key: 'auth.googleLogin', limit: 20, before });
    });

    it('treats explicit null arguments like omitted ones', async () => {
      const { resolver, service } = setup();
      await resolver.settingHistory(null, 50, null, null);
      expect(service.history).toHaveBeenCalledWith({
        key: undefined,
        limit: 50,
        before: undefined,
        beforeId: undefined,
      });
    });

    it('passes the (before, beforeId) cursor through', async () => {
      const { resolver, service } = setup();
      const before = new Date('2026-11-02T12:00:00.000Z');
      await resolver.settingHistory(null, 10, before, '11');
      expect(service.history).toHaveBeenCalledWith({
        key: undefined,
        limit: 10,
        before,
        beforeId: '11',
      });
    });
  });
});
