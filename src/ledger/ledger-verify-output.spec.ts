import { formatLedgerVerifyReport } from './ledger-verify-output.js';
import type {
  BalanceMismatch,
  LedgerVerifyReport,
  OperationMismatch,
  VersionMismatch,
} from './ledger-verifier.js';

const healthy: LedgerVerifyReport = { balances: [], currencies: [], operations: [], versions: [] };

const balance = (index: number): BalanceMismatch => ({
  accountId: `account-${index}`,
  currency: 'UAH',
  stored: 100n,
  computed: 101n,
});
const operationMismatch = (index: number): OperationMismatch => ({
  operationId: `operation-${index}`,
  type: 'test_credit',
  currency: 'USD',
  sum: 1n,
});
const versionMismatch = (index: number): VersionMismatch => ({
  accountId: `account-${index}`,
  currency: 'EUR',
  version: 3n,
  operations: 2,
});

const lines = (text: string): string[] => text.trimEnd().split('\n');
const failedBlocks = (text: string): string[] =>
  lines(text).filter((line) => line.startsWith('✗ '));

describe('formatLedgerVerifyReport', () => {
  it('prints four passed checks and a consistent verdict for a healthy ledger', () => {
    const { text, consistent } = formatLedgerVerifyReport(healthy);
    expect(consistent).toBe(true);
    const out = lines(text);
    expect(out).toHaveLength(5);
    expect(out.slice(0, 4).every((line) => line.startsWith('✓ '))).toBe(true);
    expect(out[4]).toBe('Ledger is consistent.');
  });

  it('fails on a stored balance that differs from the entries, naming the account and both amounts', () => {
    const { text, consistent } = formatLedgerVerifyReport({ ...healthy, balances: [balance(1)] });
    expect(consistent).toBe(false);
    expect(text).toContain('  account account-1 UAH: stored 100, entries 101\n');
    expect(failedBlocks(text)).toHaveLength(1);
    expect(lines(text).at(-1)).toBe('Ledger has mismatches.');
  });

  it('fails on a currency that does not sum to zero', () => {
    const { text, consistent } = formatLedgerVerifyReport({
      ...healthy,
      currencies: [{ currency: 'PLN', sum: -5n }],
    });
    expect(consistent).toBe(false);
    expect(text).toContain('✗ Every currency sums to zero over all entries: 1 mismatch\n');
    expect(text).toContain('  PLN: sum -5\n');
    expect(failedBlocks(text)).toHaveLength(1);
  });

  it('fails on an operation that does not sum to zero, naming operation, type and currency', () => {
    const { text, consistent } = formatLedgerVerifyReport({
      ...healthy,
      operations: [operationMismatch(1)],
    });
    expect(consistent).toBe(false);
    expect(text).toContain('  operation operation-1 (test_credit) USD: sum 1\n');
    expect(failedBlocks(text)).toHaveLength(1);
  });

  it('fails on a version that differs from the number of operations', () => {
    const { text, consistent } = formatLedgerVerifyReport({
      ...healthy,
      versions: [versionMismatch(1)],
    });
    expect(consistent).toBe(false);
    expect(text).toContain('  account account-1 EUR: version 3, operations 2\n');
    expect(failedBlocks(text)).toHaveLength(1);
  });

  it('prints a corrupted version above 2^53 exactly', () => {
    const { text } = formatLedgerVerifyReport({
      ...healthy,
      versions: [{ ...versionMismatch(1), version: 9_007_199_254_740_993n }],
    });
    expect(text).toContain('version 9007199254740993, operations 2');
  });

  it('prints a block for each failing check and passes the others', () => {
    const { text, consistent } = formatLedgerVerifyReport({
      ...healthy,
      balances: [balance(1)],
      versions: [versionMismatch(2)],
    });
    expect(consistent).toBe(false);
    const out = lines(text);
    expect(failedBlocks(text)).toEqual([
      '✗ Stored balance equals the sum of entries, per account: 1 mismatch',
      '✗ Version equals the number of operations, per account: 1 mismatch',
    ]);
    expect(out.filter((line) => line.startsWith('✓ '))).toHaveLength(2);
    expect(text).toContain('  account account-1 UAH: stored 100, entries 101\n');
    expect(text).toContain('  account account-2 EUR: version 3, operations 2\n');
    expect(out.at(-1)).toBe('Ledger has mismatches.');
  });

  it('prints at most 20 rows of a check and counts the rest', () => {
    const balances = Array.from({ length: 25 }, (_, index) => balance(index));
    const { text } = formatLedgerVerifyReport({ ...healthy, balances });
    expect(text).toContain(': 25 mismatches\n');
    expect(lines(text).filter((line) => line.startsWith('  account account-'))).toHaveLength(20);
    expect(text).toContain('  account account-19 ');
    expect(text).not.toContain('account-20 ');
    expect(text).toContain('  … and 5 more\n');
  });

  it('prints no "and more" line for exactly 20 rows', () => {
    const balances = Array.from({ length: 20 }, (_, index) => balance(index));
    expect(formatLedgerVerifyReport({ ...healthy, balances }).text).not.toContain('more');
  });
});
