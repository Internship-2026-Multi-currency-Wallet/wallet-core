import type { Currency } from '../common/currency.js';

/** Features add their own types here ('transfer', 'conversion', 'top_up', ...). */
export type OperationType = 'test_credit';

/** Code of the platform account that is the source of money in test credits and top-ups. */
export const PLATFORM_FUNDING = 'funding';

export type AccountRef =
  | { type: 'user'; userId: string; currency: Currency }
  | { type: 'platform' | 'external'; code: string; currency: Currency };

/** `amount` is signed and in minor units. */
export interface EntryInput {
  account: AccountRef;
  amount: bigint;
}

export interface PostOperation {
  type: OperationType;
  idempotencyKey: string;
  entries: readonly EntryInput[];
}

export interface PostedOperation extends PostOperation {
  id: string;
  createdAt: Date;
}

/**
 * `replayed: true` means nothing new was written: callers must not repeat side effects
 * (a second "money arrived" email, a second event).
 * `post()` returns no balances: a replay must return the ORIGINAL result, and balances may have
 * moved since. Clients learn about changes from `balanceChanged`, not by polling `getBalances`.
 */
export interface PostResult {
  operation: PostedOperation;
  replayed: boolean;
}

export interface UserBalance {
  currency: Currency;
  amount: bigint;
}

export function userAccount(userId: string, currency: Currency): AccountRef {
  return { type: 'user', userId, currency };
}

export function platformAccount(code: string, currency: Currency): AccountRef {
  return { type: 'platform', code, currency };
}

/** Stable text key, e.g. `user:<id>:UAH`, `platform:funding:UAH`. */
export function accountKey(account: AccountRef): string {
  const owner = account.type === 'user' ? account.userId : account.code;
  return `${account.type}:${owner}:${account.currency}`;
}
