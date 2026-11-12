import type { PostOperation, PostResult, UserBalance } from './ledger.types.js';

export abstract class LedgerService {
  /**
   * Writes all entries of one operation atomically. Business rejections carry a `LedgerErrorCode`:
   * `INSUFFICIENT_FUNDS` (a user account would go negative) and `IDEMPOTENCY_CONFLICT`. An operation
   * that does not sum to zero in each currency is a programming error and throws a plain `Error`.
   * A replay with the same idempotency key returns the original operation (`replayed: true`) and
   * writes nothing; the same key with different content is `IDEMPOTENCY_CONFLICT`.
   * Idempotency keys are global across all features, so callers prefix them with the operation type
   * (e.g. `top_up:<PayGate payment id>`).
   */
  abstract post(operation: PostOperation): Promise<PostResult>;

  /** The user's balances in all five currencies, in `CURRENCIES` order (zeros included). */
  abstract getBalances(userId: string): Promise<UserBalance[]>;
}
