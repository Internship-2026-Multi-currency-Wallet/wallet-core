import type { Knex } from 'knex';

/**
 * Initial, intentionally empty migration: it creates the `knex_migrations` bookkeeping
 * tables. Feature modules add their own timestamped migrations next to this file.
 * Never edit a migration that is already merged — add a new one.
 */
export async function up(_knex: Knex): Promise<void> {}

export async function down(_knex: Knex): Promise<void> {}
