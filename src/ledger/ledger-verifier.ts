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
  version: bigint;
  operations: number;
}

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
  SELECT a.id AS account_id, a.currency, CAST(a.version AS CHAR) AS version,
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
  version: string;
  operations: number | string;
}

/**
 * Relies on InnoDB's default REPEATABLE READ for one snapshot across the four checks, because knex writes invalid
 * MySQL (`ISOLATION LEVEL x READ ONLY`, no comma) when an isolation level is combined with read-only.
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
          version: BigInt(row.version),
          operations: Number(row.operations),
        })),
      };
    },
    { readOnly: true },
  );
}
