import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import type { ClientCode } from '../config/env.schema.js';
import { type ClientSettings, type SettingKey, settingsCatalog } from './settings.schema.js';

/**
 * Settings seam: typed client settings for the client this deployment serves (`CLIENT`).
 *
 *   const googleLogin = await settings.get('auth.googleLogin'); // boolean
 *
 * Defaults live in the code (`settingsCatalog`), so a fresh environment works with an empty
 * database. Today this returns only those defaults. A later task adds overrides stored in this
 * service's database (only changed values; one environment = one client = one database) and
 * looks them up before falling back to the default. Callers stay unchanged — `get` is async
 * for that reason.
 */
@Injectable()
export class ClientSettingsService {
  constructor(private readonly config: AppConfig) {}

  /** The client the settings are for. */
  get client(): ClientCode {
    return this.config.client;
  }

  get<K extends SettingKey>(key: K): Promise<ClientSettings[K]> {
    if (!Object.hasOwn(settingsCatalog, key)) throw new Error(`Unknown setting "${key}"`);
    return Promise.resolve(structuredClone(settingsCatalog[key].default) as ClientSettings[K]);
  }
}
