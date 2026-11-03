import { Inject, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { KNEX } from '../database/database.module.js';

const OVERRIDES = 'client_settings';
const CHANGES = 'client_setting_changes';

export interface SettingOverride {
  key: string;
  value: unknown;
}

export interface SettingChangeRow {
  /** BIGINT row id as a string; the tie-breaker of the history cursor. */
  id: string;
  key: string;
  oldValue: unknown;
  newValue: unknown;
  changedBy: string;
  changedAt: Date;
}

export interface ApplyChangeInput {
  key: string;
  /** New override, or `null` to reset (delete the override). */
  next: { value: unknown } | null;
  /** Catalog default: the effective value whenever there is no override. */
  fallback: unknown;
  changedBy: string;
  at: Date;
}

/**
 * Storage of client settings: the overrides (only changed keys) and the change history.
 * Values are stored as JSON; validation against the catalog is the service's job.
 */
@Injectable()
export class SettingsRepository {
  constructor(@Inject(KNEX) private readonly db: Knex) {}

  async findAll(): Promise<SettingOverride[]> {
    return this.db<SettingOverride>(OVERRIDES).select('key', 'value').orderBy('key');
  }

  async find(key: string): Promise<SettingOverride | undefined> {
    return this.db<SettingOverride>(OVERRIDES).select('key', 'value').where({ key }).first();
  }

  /**
   * Updates or resets one key and appends the history row in a single transaction. The current
   * override is locked first, so concurrent changes of a key are serialized and each history row
   * records the value it actually replaced. Returns `null` for a reset without an override
   * (nothing changes, nothing is recorded).
   */
  async applyChange(
    input: ApplyChangeInput,
  ): Promise<{ oldValue: unknown; newValue: unknown } | null> {
    const { key, next, fallback, changedBy, at } = input;
    return this.db.transaction(async (trx) => {
      const current = (await trx(OVERRIDES).select('value').where({ key }).forUpdate().first()) as
        { value: unknown } | undefined;
      if (!next && !current) return null;

      const oldValue = current ? current.value : fallback;
      const newValue = next ? next.value : fallback;
      if (next) {
        await trx(OVERRIDES)
          .insert({ key, value: JSON.stringify(newValue), updated_by: changedBy, updated_at: at })
          .onConflict('key')
          .merge();
      } else {
        await trx(OVERRIDES).where({ key }).delete();
      }
      await trx(CHANGES).insert({
        key,
        old_value: JSON.stringify(oldValue),
        new_value: JSON.stringify(newValue),
        changed_by: changedBy,
        changed_at: at,
      });
      return { oldValue, newValue };
    });
  }

  /**
   * Changes, newest first (`changed_at`, then `id`); optionally one key. Paging: `before` alone
   * returns changes strictly older than that time; `before` + `beforeId` (the last row of the
   * previous page) continue after that row, so rows with the same timestamp are not skipped.
   */
  async history(query: {
    key?: string;
    before?: Date;
    beforeId?: string;
    limit: number;
  }): Promise<SettingChangeRow[]> {
    const { before, beforeId } = query;
    const rows = (await this.db(CHANGES)
      .select('id', 'key', 'old_value', 'new_value', 'changed_by', 'changed_at')
      .modify((q) => {
        if (query.key !== undefined) void q.where({ key: query.key });
        if (before !== undefined && beforeId !== undefined) {
          // Keyset: (changed_at, id) < (before, beforeId), matching the ORDER BY below.
          void q.where((w) => {
            void w.where('changed_at', '<', before).orWhere((tie) => {
              void tie.where('changed_at', '=', before).andWhere('id', '<', beforeId);
            });
          });
        } else if (before !== undefined) {
          void q.where('changed_at', '<', before);
        }
      })
      .orderBy([
        { column: 'changed_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(query.limit)) as {
      id: number | string;
      key: string;
      old_value: unknown;
      new_value: unknown;
      changed_by: string;
      changed_at: Date;
    }[];
    return rows.map((row) => ({
      id: String(row.id),
      key: row.key,
      oldValue: row.old_value,
      newValue: row.new_value,
      changedBy: row.changed_by,
      changedAt: row.changed_at,
    }));
  }
}
