import type { Knex } from 'knex';

export interface BalanceMismatch {
  accountId: string;
  currency: string;
  stored: bigint;
  computed: bigint;
}

export interface CurrencyMismatch {
  currency: string;
  sum: bigint;
}

export interface OperationMismatch {
  operationId: string;
  type: string;
  currency: string;
  sum: bigint;
}

export interface VersionMismatch {
  accountId: string;
  currency: string;
  version: number;
  operations: number;
}

/** Every mismatch of every check, in a fixed order; an empty list means the check passed. */
export interface LedgerVerifyReport {
  balances: BalanceMismatch[];
  currencies: CurrencyMismatch[];
  operations: OperationMismatch[];
  versions: VersionMismatch[];
}

// BIGINT and SUM() (a DECIMAL) are read as text: mysql2 would turn them into a lossy JS number.
// An entry has no currency of its own: it is the currency of its account.
const BALANCES_SQL = `
  SELECT a.id AS account_id, a.currency,
         CAST(a.balance AS CHAR) AS stored_balance,
         CAST(COALESCE(SUM(e.amount), 0) AS CHAR) AS computed_balance
  FROM accounts a
  LEFT JOIN entries e ON e.account_id = a.id
  GROUP BY a.id, a.currency, a.balance
  HAVING a.balance <> COALESCE(SUM(e.amount), 0)
  ORDER BY a.currency, a.id`;

const CURRENCIES_SQL = `
  SELECT a.currency, CAST(SUM(e.amount) AS CHAR) AS total
  FROM entries e
  JOIN accounts a ON a.id = e.account_id
  GROUP BY a.currency
  HAVING SUM(e.amount) <> 0
  ORDER BY a.currency`;

const OPERATIONS_SQL = `
  SELECT e.operation_id, o.type, a.currency, CAST(SUM(e.amount) AS CHAR) AS total
  FROM entries e
  JOIN accounts a ON a.id = e.account_id
  JOIN operations o ON o.id = e.operation_id
  GROUP BY e.operation_id, o.type, a.currency
  HAVING SUM(e.amount) <> 0
  ORDER BY MIN(o.created_at), e.operation_id, a.currency`;

// A posting bumps the version of an account once, and leaves at least one entry on it.
const VERSIONS_SQL = `
  SELECT a.id AS account_id, a.currency, a.version,
         COUNT(DISTINCT e.operation_id) AS operations
  FROM accounts a
  LEFT JOIN entries e ON e.account_id = a.id
  GROUP BY a.id, a.currency, a.version
  HAVING a.version <> COUNT(DISTINCT e.operation_id)
  ORDER BY a.currency, a.id`;

interface BalanceRow {
  account_id: string;
  currency: string;
  stored_balance: string;
  computed_balance: string;
}
interface CurrencyRow {
  currency: string;
  total: string;
}
interface OperationRow {
  operation_id: string;
  type: string;
  currency: string;
  total: string;
}
interface VersionRow {
  account_id: string;
  currency: string;
  version: number | string;
  operations: number | string;
}

/**
 * Read-only. Each check is one statement and so sees one consistent state; the shared transaction (InnoDB's
 * default REPEATABLE READ, snapshot at the first read) makes all four describe the same moment.
 * Knex cannot also ask for the isolation level: it sends `ISOLATION LEVEL x READ ONLY` without the comma MySQL needs.
 */
export async function verifyLedger(db: Knex): Promise<LedgerVerifyReport> {
  return db.transaction(
    async (trx) => {
      const rows = async <Row>(sql: string): Promise<Row[]> => {
        const [result] = await trx.raw<[Row[]]>(sql);
        return result;
      };
      const balances = await rows<BalanceRow>(BALANCES_SQL);
      const currencies = await rows<CurrencyRow>(CURRENCIES_SQL);
      const operations = await rows<OperationRow>(OPERATIONS_SQL);
      const versions = await rows<VersionRow>(VERSIONS_SQL);
      return {
        balances: balances.map((row) => ({
          accountId: row.account_id,
          currency: row.currency,
          stored: BigInt(row.stored_balance),
          computed: BigInt(row.computed_balance),
        })),
        currencies: currencies.map((row) => ({ currency: row.currency, sum: BigInt(row.total) })),
        operations: operations.map((row) => ({
          operationId: row.operation_id,
          type: row.type,
          currency: row.currency,
          sum: BigInt(row.total),
        })),
        versions: versions.map((row) => ({
          accountId: row.account_id,
          currency: row.currency,
          version: Number(row.version),
          operations: Number(row.operations),
        })),
      };
    },
    { readOnly: true },
  );
}
