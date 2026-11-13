import type { LedgerVerifyReport } from './ledger-verifier.js';

/** A broken migration could list thousands of rows; the rest is counted, not printed. */
const MAX_ROWS = 20;

function block<Row>(name: string, rows: Row[], describe: (row: Row) => string): string[] {
  if (rows.length === 0) return [`✓ ${name}`];
  const shown = rows.slice(0, MAX_ROWS).map((row) => `  ${describe(row)}`);
  const more = rows.length - shown.length;
  return [
    `✗ ${name}: ${rows.length} ${rows.length === 1 ? 'mismatch' : 'mismatches'}`,
    ...shown,
    ...(more > 0 ? [`  … and ${more} more`] : []),
  ];
}

/** Ids, currencies and amounts only: no user ids (accounts are named by their own id). */
export function formatLedgerVerifyReport(report: LedgerVerifyReport): {
  text: string;
  consistent: boolean;
} {
  const consistent =
    report.balances.length === 0 &&
    report.currencies.length === 0 &&
    report.operations.length === 0 &&
    report.versions.length === 0;
  const lines = [
    ...block(
      'Stored balance equals the sum of entries, per account',
      report.balances,
      (row) =>
        `account ${row.accountId} ${row.currency}: stored ${row.stored}, entries ${row.computed}`,
    ),
    ...block(
      'Every currency sums to zero over all entries',
      report.currencies,
      (row) => `${row.currency}: sum ${row.sum}`,
    ),
    ...block(
      'Every operation sums to zero per currency',
      report.operations,
      (row) => `operation ${row.operationId} (${row.type}) ${row.currency}: sum ${row.sum}`,
    ),
    ...block(
      'Version equals the number of operations, per account',
      report.versions,
      (row) =>
        `account ${row.accountId} ${row.currency}: version ${row.version}, operations ${row.operations}`,
    ),
    consistent ? 'Ledger is consistent.' : 'Ledger has mismatches.',
  ];
  return { text: `${lines.join('\n')}\n`, consistent };
}
