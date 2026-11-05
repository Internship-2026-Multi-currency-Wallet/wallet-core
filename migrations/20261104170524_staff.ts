import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Role and status are plain strings so a new value needs no migration.
  await knex.schema.createTable('staff', (table) => {
    table.engine('InnoDB');
    table.charset('utf8mb4');
    table.uuid('id').primary();
    table.string('email', 255).notNullable().unique({ indexName: 'staff_email_unique' });
    table.string('role', 16).notNullable();
    table.string('status', 16).notNullable();
    table.string('password_hash', 255).nullable();
    table.integer('failed_login_attempts').unsigned().notNullable().defaultTo(0);
    table.datetime('locked_until', { precision: 3 }).nullable();
    table.datetime('created_at', { precision: 3 }).notNullable();
    table.datetime('updated_at', { precision: 3 }).notNullable();
    table.index(['role', 'status'], 'staff_role_status_index');
  });

  await knex.schema.createTable('staff_sessions', (table) => {
    table.engine('InnoDB');
    table.charset('utf8mb4');
    table.uuid('id').primary();
    table.uuid('staff_id').notNullable().references('id').inTable('staff').onDelete('CASCADE');
    table
      .string('refresh_token_hash', 64)
      .notNullable()
      .unique({ indexName: 'staff_sessions_refresh_token_hash_unique' });
    table.datetime('expires_at', { precision: 3 }).notNullable();
    table.datetime('revoked_at', { precision: 3 }).nullable();
    table.datetime('created_at', { precision: 3 }).notNullable();
  });

  await knex.schema.createTable('staff_invitations', (table) => {
    table.engine('InnoDB');
    table.charset('utf8mb4');
    table.uuid('id').primary();
    table.uuid('staff_id').notNullable().references('id').inTable('staff').onDelete('CASCADE');
    table
      .string('token_hash', 64)
      .notNullable()
      .unique({ indexName: 'staff_invitations_token_hash_unique' });
    table.datetime('expires_at', { precision: 3 }).notNullable();
    table.datetime('used_at', { precision: 3 }).nullable();
    table.datetime('created_at', { precision: 3 }).notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('staff_invitations');
  await knex.schema.dropTable('staff_sessions');
  await knex.schema.dropTable('staff');
}
