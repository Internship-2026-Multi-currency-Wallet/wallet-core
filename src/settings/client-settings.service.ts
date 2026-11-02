import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import type { ClientCode } from '../config/env.schema.js';
import { SettingsRepository } from './settings.repository.js';
import { type ClientSettings, type SettingKey, settingsCatalog } from './settings.schema.js';

/** A catalog key with its effective value: the client's override, else the default. */
export interface EffectiveSetting {
  key: SettingKey;
  value: unknown;
  overridden: boolean;
}

/**
 * Settings seam: typed client settings for the client this deployment serves (`CLIENT`).
 *
 *   const googleLogin = await settings.get('auth.googleLogin'); // boolean
 *
 * Defaults live in the code (`settingsCatalog`); this service's database keeps only the
 * client's overrides (one environment = one client = one database). Every read goes to the
 * database, so a change applies without a redeploy. A stored value that no longer passes the
 * catalog schema is ignored (warning logged) and the default applies, so a bad row cannot
 * break the app.
 */
@Injectable()
export class ClientSettingsService {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: SettingsRepository,
    // Not `@InjectPinoLogger`: its provider exists only if this file loads before LoggingModule
    // (nestjs-pino snapshots the contexts in `forRootAsync`), which app.module's import order
    // does not guarantee. PinoLogger is transient, so setting the context here is safe.
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(ClientSettingsService.name);
  }

  /** The client the settings are for. */
  get client(): ClientCode {
    return this.config.client;
  }

  async get<K extends SettingKey>(key: K): Promise<ClientSettings[K]> {
    if (!isSettingKey(key)) throw new Error(`Unknown setting "${String(key)}"`);
    const override = await this.repository.find(key);
    return this.effective(key, override).value as ClientSettings[K];
  }

  /** All catalog keys with their effective values, read with one query. */
  async getAll(): Promise<EffectiveSetting[]> {
    const overrides = new Map((await this.repository.findAll()).map((row) => [row.key, row]));
    return (Object.keys(settingsCatalog) as SettingKey[]).map((key) =>
      this.effective(key, overrides.get(key)),
    );
  }

  private effective(key: SettingKey, override?: { value: unknown }): EffectiveSetting {
    const { schema, default: fallback } = settingsCatalog[key];
    if (override) {
      const parsed = schema.safeParse(override.value);
      if (parsed.success) return { key, value: parsed.data, overridden: true };
      this.logger.warn(
        { key, err: parsed.error },
        'invalid stored setting ignored, default applies',
      );
    }
    return { key, value: structuredClone(fallback), overridden: false };
  }
}

function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingsCatalog, key);
}
