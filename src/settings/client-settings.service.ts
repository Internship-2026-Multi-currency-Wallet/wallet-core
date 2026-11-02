import { Injectable } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import type { ClientCode } from '../config/env.schema.js';
import { type SettingChangeRow, SettingsRepository } from './settings.repository.js';
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

  /**
   * Stores an override (staff). The value must pass the catalog schema. The change and its
   * history row (old → new) are written in one transaction.
   *
   * Errors: `UNKNOWN_KEY`, `INVALID_VALUE` (GraphQL `extensions.code`).
   */
  async update(key: string, value: unknown, changedBy: string): Promise<EffectiveSetting> {
    assertKnownKey(key);
    const { schema, default: fallback } = settingsCatalog[key];
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? 'invalid value';
      throw settingsError('INVALID_VALUE', `Invalid value for "${key}": ${reason}`);
    }
    const change = await retryOnDeadlock(() =>
      this.repository.applyChange({
        key,
        next: { value: parsed.data },
        fallback,
        changedBy,
        at: new Date(),
      }),
    );
    this.logger.info(
      { key, changedBy, oldValue: change?.oldValue, newValue: change?.newValue },
      'setting updated',
    );
    return { key, value: parsed.data, overridden: true };
  }

  /**
   * Removes the override (staff), so the default applies again. Recorded in history as
   * old → default. Without an override nothing changes and nothing is recorded.
   * No deadlock retry needed: a reset never inserts a row.
   *
   * Errors: `UNKNOWN_KEY` (GraphQL `extensions.code`).
   */
  async reset(key: string, changedBy: string): Promise<EffectiveSetting> {
    assertKnownKey(key);
    const fallback = settingsCatalog[key].default;
    const change = await this.repository.applyChange({
      key,
      next: null,
      fallback,
      changedBy,
      at: new Date(),
    });
    if (change) {
      this.logger.info(
        { key, changedBy, oldValue: change.oldValue, newValue: change.newValue },
        'setting reset',
      );
    }
    return { key, value: structuredClone(fallback), overridden: false };
  }

  /**
   * Change history (staff), newest first: optionally one key, only changes strictly older than
   * `before`, at most `limit` (1..200) rows.
   *
   * Errors: `UNKNOWN_KEY`, `INVALID_VALUE` (GraphQL `extensions.code`).
   */
  async history(query: {
    key?: string;
    before?: Date;
    limit: number;
  }): Promise<SettingChangeRow[]> {
    const { key, before, limit } = query;
    if (key !== undefined) assertKnownKey(key);
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_MAX_LIMIT) {
      throw settingsError(
        'INVALID_VALUE',
        `Invalid limit ${limit}: must be between 1 and ${HISTORY_MAX_LIMIT}`,
      );
    }
    return this.repository.history({ key, before, limit });
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

/** API input check: an unknown key is the caller's error → `UNKNOWN_KEY`. */
function assertKnownKey(key: string): asserts key is SettingKey {
  if (!isSettingKey(key)) throw settingsError('UNKNOWN_KEY', `Unknown setting "${key}"`);
}

/** Error codes of the settings API, reported as GraphQL `extensions.code`. */
function settingsError(code: 'UNKNOWN_KEY' | 'INVALID_VALUE', message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}

/** Upper bound of `settingHistory(limit)`, as documented in the GraphQL contract. */
const HISTORY_MAX_LIMIT = 200;

const DEADLOCK_ATTEMPTS = 3;

/**
 * Re-runs a transaction that MySQL rolled back to break a deadlock. It happens when two staff
 * members change the same key at once while it has no override yet: the row lock has no row
 * to lock, so both inserts collide. The retry then sees the other change's row.
 */
async function retryOnDeadlock<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const deadlock = (err as { code?: unknown }).code === 'ER_LOCK_DEADLOCK';
      if (!deadlock || attempt >= DEADLOCK_ATTEMPTS) throw err;
    }
  }
}
