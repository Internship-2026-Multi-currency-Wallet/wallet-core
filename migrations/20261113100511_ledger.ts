import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';

/**
 * Double-entry ledger (E2-1). Amounts and balances are signed BIGINT in minor units.
 * Ledger rows are never deleted, so no foreign key cascades here.
 */
export async function up(knex: Knex): Promise<void> {
  // One row per (owner, currency). `balance` is the stored sum of the account's entries, updated in the
  // same transaction as the entries; `npm run ledger:verify` checks it against them.
  // No foreign key to users: the owner id comes from the token, and dev-auth ids are not in `users`.
  await knex.schema.createTable('accounts', (table) => {
    table.engine('InnoDB');
    table.charset('utf8mb4');
    table.uuid('id').primary();
    // 'user' | 'platform' | 'external': a plain string, so a new type needs no migration.
    table.string('type', 16).notNullable();
    table.uuid('user_id').nullable();
    table.string('code', 32).nullable();
    table.string('currency', 8).notNullable();
    table.bigInteger('balance').notNullable().defaultTo(0);
    table.datetime('created_at', { precision: 3 }).notNullable();
    // NULLs never clash in a unique index, so platform rows do not collide on user_id and user rows not on code.
    table.unique(['user_id', 'currency'], { indexName: 'accounts_user_currency_unique' });
    table.unique(['type', 'code', 'currency'], { indexName: 'accounts_type_code_currency_unique' });
    // Safety nets: the service checks these first; a hit here means a bug in the service.
    table.check(
      "(type = 'user') = (user_id IS NOT NULL) AND (type = 'user') = (code IS NULL)",
      {},
      'accounts_owner_matches_type',
    );
    table.check("type <> 'user' OR balance >= 0", {}, 'accounts_user_balance_not_negative');
  });

  await knex.schema.createTable('operations', (table) => {
    table.engine('InnoDB');
    table.charset('utf8mb4');
    table.uuid('id').primary();
    table.string('type', 32).notNullable();
    table
      .string('idempotency_key', 191)
      .notNullable()
      .unique({ indexName: 'operations_idempotency_key_unique' });
    // SHA-256 hex of the operation content (operation-fingerprint.ts): same key + other content = conflict.
    table.string('fingerprint', 64).notNullable();
    table.datetime('created_at', { precision: 3 }).notNullable();
  });

  await knex.schema.createTable('entries', (table) => {
    table.engine('InnoDB');
    table.charset('utf8mb4');
    table.uuid('id').primary();
    table.uuid('operation_id').notNullable().references('id').inTable('operations');
    table.uuid('account_id').notNullable().references('id').inTable('accounts');
    table.bigInteger('amount').notNullable();
    table.check('amount <> 0', {}, 'entries_amount_not_zero');
  });

  // The source of test credits and top-ups. Currencies are written out: a migration must not change
  // when the app's currency list changes later.
  const createdAt = new Date();
  await knex('accounts').insert(
    ['UAH', 'USD', 'EUR', 'PLN', 'USDT'].map((currency) => ({
      id: randomUUID(),
      type: 'platform',
      code: 'funding',
      currency,
      created_at: createdAt,
    })),
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('entries');
  await knex.schema.dropTable('operations');
  await knex.schema.dropTable('accounts');
}
