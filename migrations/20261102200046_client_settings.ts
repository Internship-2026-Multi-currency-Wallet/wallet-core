import type { Knex } from 'knex';

/**
 * Client settings store. Defaults live in the code (`settingsCatalog`); this database keeps
 * only the client's overrides plus an append-only change history. One environment = one
 * client = one database, so there is no client column. Timestamps are written by the app.
 */
export async function up(knex: Knex): Promise<void> {
  // One row per overridden key. No row → the catalog default applies; delete = reset.
  await knex.schema.createTable('client_settings', (table) => {
    table.engine('InnoDB');
    table.charset('utf8mb4');
    table.string('key', 100).primary();
    table.json('value').notNullable();
    table.string('updated_by', 64).notNullable();
    table.datetime('updated_at', { precision: 3 }).notNullable();
  });

  // Every update and reset: effective value before → after (a reset is old → default).
  await knex.schema.createTable('client_setting_changes', (table) => {
    table.engine('InnoDB');
    table.charset('utf8mb4');
    table.bigIncrements('id');
    table.string('key', 100).notNullable();
    table.json('old_value').notNullable();
    table.json('new_value').notNullable();
    table.string('changed_by', 64).notNullable();
    table.datetime('changed_at', { precision: 3 }).notNullable();
    table.index(['key', 'changed_at'], 'client_setting_changes_key_changed_at_idx');
    table.index(['changed_at'], 'client_setting_changes_changed_at_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('client_setting_changes');
  await knex.schema.dropTable('client_settings');
}
