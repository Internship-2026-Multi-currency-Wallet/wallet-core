import { z } from 'zod';
import { SettingType } from './settings.model.js';

interface SettingDefinition {
  /** Type and validation of the value (checked on write and on read). */
  schema: z.ZodType;
  /** Platform default; applies while the client has no override. */
  default: unknown;
  /** Whether client apps receive it (`publicSettings`). Decided here, never in the database. */
  public: boolean;
}

/**
 * The catalog of client settings: one line per setting. Keys are addressed with dots: `auth.googleLogin`.
 * `ClientSettings` and `SettingKey` are derived from it.
 */
export const settingsCatalog = {
  'auth.googleLogin': { schema: z.boolean(), default: true, public: true },
  'auth.phoneRequiredAt': {
    schema: z.enum(['signup', 'firstTransfer', 'never']),
    default: 'never',
    public: true,
  },
  'products.enabled': { schema: z.array(z.string()), default: ['wallet'], public: true },
} satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof settingsCatalog;

/** Maps every key to the type of its value, e.g. `'auth.googleLogin' -> boolean`. */
export type ClientSettings = {
  [K in SettingKey]: z.infer<(typeof settingsCatalog)[K]['schema']>;
};

/** GraphQL `type` (and `allowedValues` for enums) of a setting, derived from its zod schema. */
export function settingTypeOf(schema: z.ZodType): { type: SettingType; allowedValues?: string[] } {
  if (schema instanceof z.ZodBoolean) return { type: SettingType.BOOLEAN };
  if (schema instanceof z.ZodEnum) {
    return { type: SettingType.ENUM, allowedValues: schema.options.map(String) };
  }
  if (schema instanceof z.ZodArray && schema.element instanceof z.ZodString) {
    return { type: SettingType.STRING_LIST };
  }
  throw new Error(`Unsupported setting schema: ${schema.def.type}`);
}
