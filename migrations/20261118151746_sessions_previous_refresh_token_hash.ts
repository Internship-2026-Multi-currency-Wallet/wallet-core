import type { Knex } from 'knex';

/**
 * The refresh token hash a session had before its last rotation. A logout sent with the cookie
 * from before a parallel refresh carries that token, and must still end the session.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sessions', (table) => {
    table.string('previous_refresh_token_hash', 64).nullable();
    table.index(['previous_refresh_token_hash'], 'sessions_previous_refresh_token_hash_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('sessions', (table) => {
    table.dropIndex(['previous_refresh_token_hash'], 'sessions_previous_refresh_token_hash_idx');
    table.dropColumn('previous_refresh_token_hash');
  });
}
