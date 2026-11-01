import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { parse } from 'yaml';
import { AppConfig } from '../config/app-config.js';
import type { ClientCode } from '../config/env.schema.js';
import {
  type ClientSettings,
  type SettingKey,
  type SettingsTree,
  settingsSchema,
} from './settings.schema.js';

export const DEFAULT_SETTINGS_PATH = join(process.cwd(), 'config', 'settings.defaults.yaml');

export function loadSettingsFile(path: string = DEFAULT_SETTINGS_PATH): SettingsTree {
  const raw: unknown = parse(readFileSync(path, 'utf8'));
  const result = settingsSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid settings file ${path}:\n${details}`);
  }
  return result.data;
}

/**
 * Settings seam: typed client settings for the client this deployment serves (`CLIENT`).
 *
 *   const googleLogin = await settings.get('auth.googleLogin'); // boolean
 *
 * Defaults live in the code (`config/settings.defaults.yaml`), so a fresh environment works
 * with an empty database. Today this stub returns only those defaults. A later task adds
 * overrides stored in this service's database (only changed values; one environment = one
 * client = one database) and looks them up before falling back to the default. Callers stay
 * unchanged — `get` is async for that reason.
 */
@Injectable()
export class ClientSettingsService {
  private readonly defaults: SettingsTree;

  constructor(private readonly config: AppConfig) {
    this.defaults = loadSettingsFile();
  }

  /** The client the settings are for. */
  get client(): ClientCode {
    return this.config.client;
  }

  get<K extends SettingKey>(key: K): Promise<ClientSettings[K]> {
    const value = key
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        this.defaults,
      );
    if (value === undefined) throw new Error(`Unknown setting "${key}"`);
    return Promise.resolve(structuredClone(value) as ClientSettings[K]);
  }
}
