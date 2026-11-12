import type { PostOperation, PostResult, UserBalance } from './ledger.types.js';

export abstract class LedgerService {
  /**
   * Writes all entries of one operation atomically. Rejects (`LedgerErrorCode`) an operation that does
   * not sum to zero in each currency or would make a user account negative. A replay with the same
   * idempotency key returns the original operation (`replayed: true`) and writes nothing; the same key
   * with different content is `IDEMPOTENCY_CONFLICT`.
   */
  abstract post(operation: PostOperation): Promise<PostResult>;

  /** The user's balances in all five currencies, in `CURRENCIES` order (zeros included). */
  abstract getBalances(userId: string): Promise<UserBalance[]>;
}
