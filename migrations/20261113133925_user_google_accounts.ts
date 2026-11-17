import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_google_accounts', (table) => {
    table.engine('InnoDB');
    table.charset('utf8mb4');
    table.uuid('user_id').primary().references('id').inTable('users').onDelete('CASCADE');
    // An external id: must match exactly, never case- or accent-insensitively.
    table
      .string('google_sub', 255)
      .collate('utf8mb4_bin')
      .notNullable()
      .unique({ indexName: 'user_google_accounts_google_sub_unique' });
    table.string('email', 255).notNullable();
    table.datetime('linked_at', { precision: 3 }).notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('user_google_accounts');
}
