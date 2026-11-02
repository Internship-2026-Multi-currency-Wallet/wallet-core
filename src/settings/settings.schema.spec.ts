import { z } from 'zod';
import { SettingType } from './settings.model.js';
import {
  type ClientSettings,
  type SettingKey,
  settingsCatalog,
  settingTypeOf,
} from './settings.schema.js';

describe('settingsCatalog', () => {
  const keys = Object.keys(settingsCatalog) as SettingKey[];

  it.each(keys)('default of %s passes its own schema', (key) => {
    const { schema, default: value } = settingsCatalog[key];
    expect(schema.safeParse(value).success).toBe(true);
  });

  it('marks the settings the client apps need as public', () => {
    const publicKeys = keys.filter((key) => settingsCatalog[key].public);
    expect(publicKeys.sort()).toEqual([
      'auth.googleLogin',
      'auth.phoneRequiredAt',
      'products.enabled',
    ]);
  });

  it('derives ClientSettings from the catalog', () => {
    const settings: ClientSettings = {
      'auth.googleLogin': true,
      'auth.phoneRequiredAt': 'signup',
      'products.enabled': ['wallet'],
    };
    // @ts-expect-error -- not one of the enum values
    const wrong: ClientSettings['auth.phoneRequiredAt'] = 'sometimes';
    expect(settings['auth.googleLogin']).toBe(true);
    expect(wrong).toBe('sometimes');
  });
});

describe('settingTypeOf', () => {
  it('derives the GraphQL type and allowed values from the zod schema', () => {
    expect(settingTypeOf(settingsCatalog['auth.googleLogin'].schema)).toEqual({
      type: SettingType.BOOLEAN,
    });
    expect(settingTypeOf(settingsCatalog['auth.phoneRequiredAt'].schema)).toEqual({
      type: SettingType.ENUM,
      allowedValues: ['signup', 'firstTransfer', 'never'],
    });
    expect(settingTypeOf(settingsCatalog['products.enabled'].schema)).toEqual({
      type: SettingType.STRING_LIST,
    });
  });

  it('rejects schema kinds the contract cannot describe', () => {
    expect(() => settingTypeOf(z.number())).toThrow(/Unsupported setting schema/);
  });
});
