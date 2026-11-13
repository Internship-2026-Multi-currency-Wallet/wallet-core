import { createHash } from 'node:crypto';
import { accountKey, type PostOperation } from './ledger.types.js';

/**
 * Hash of what an operation does, used to tell a retry from a different request that reuses a key.
 * Entry order does not matter; the idempotency key itself is not part of it.
 */
export function operationFingerprint(operation: PostOperation): string {
  const entries = operation.entries
    .map((entry): [string, string] => [accountKey(entry.account), entry.amount.toString()])
    .sort(([keyA, amountA], [keyB, amountB]) =>
      keyA === keyB ? compare(amountA, amountB) : compare(keyA, keyB),
    );
  return createHash('sha256')
    .update(JSON.stringify({ type: operation.type, entries }))
    .digest('hex');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
