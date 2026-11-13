import type { PostOperation } from './ledger.types.js';

/**
 * The checks that need no state, shared by the fake and the database service so the two cannot drift.
 * Caller mistakes are programming errors, not client errors: a plain `Error`, no ledger code.
 */
export function assertWellFormed(operation: PostOperation): void {
  if (operation.entries.length === 0) {
    throw new Error('Ledger operation has no entries');
  }
  for (const { amount } of operation.entries) {
    if (amount === 0n) throw new Error('Ledger entry amount must not be zero');
  }
}

export function assertZeroSum(operation: PostOperation): void {
  const sums = new Map<string, bigint>();
  for (const { account, amount } of operation.entries) {
    sums.set(account.currency, (sums.get(account.currency) ?? 0n) + amount);
  }
  // The message names only the currency, never ids or amounts.
  for (const [currency, sum] of sums) {
    if (sum !== 0n) throw new Error(`Ledger operation does not sum to zero in ${currency}`);
  }
}
