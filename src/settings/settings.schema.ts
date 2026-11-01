import { z } from 'zod';

/**
 * The typed catalog of client settings. Add a key here AND a default in
 * `config/settings.defaults.yaml`. Keys are addressed with dots: `auth.googleLogin`.
 */
export const settingsSchema = z.object({
  auth: z.object({
    phoneRequiredAt: z.enum(['signup', 'firstTransfer', 'never']),
    googleLogin: z.boolean(),
  }),
  products: z.object({
    enabled: z.array(z.string()),
  }),
});

export type SettingsTree = z.infer<typeof settingsSchema>;

/** Maps every dotted key to the type of its value, e.g. `'auth.googleLogin' -> boolean`. */
export interface ClientSettings {
  'auth.phoneRequiredAt': SettingsTree['auth']['phoneRequiredAt'];
  'auth.googleLogin': SettingsTree['auth']['googleLogin'];
  'products.enabled': SettingsTree['products']['enabled'];
}

export type SettingKey = keyof ClientSettings;
