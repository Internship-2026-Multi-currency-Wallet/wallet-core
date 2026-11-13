import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CURRENCIES } from '../common/currency.js';
import { LEDGER_ERROR_MESSAGES, LedgerErrorCode, ledgerError } from './ledger-errors.js';
import { assertWellFormed, assertZeroSum } from './ledger-rules.js';
import { LedgerService } from './ledger.service.js';
import {
  PLATFORM_FUNDING,
  accountKey,
  platformAccount,
  userAccount,
  type PostOperation,
  type PostResult,
  type PostedOperation,
  type UserBalance,
} from './ledger.types.js';
import { operationFingerprint } from './operation-fingerprint.js';

interface StoredOperation {
  operation: PostedOperation;
  fingerprint: string;
}

/**
 * In-memory `LedgerService` that obeys the same rules as the real one (zero-sum per currency, no
 * negative user account, idempotent replay), so features can be built and tested before the database
 * implementation exists. The platform funding account may go negative: it is where money enters.
 */
@Injectable()
export class FakeLedgerService extends LedgerService {
  private readonly balances = new Map<string, bigint>();
  private readonly versions = new Map<string, number>();
  private readonly operations = new Map<string, StoredOperation>();

  constructor() {
    super();
    for (const currency of CURRENCIES) {
      this.balances.set(accountKey(platformAccount(PLATFORM_FUNDING, currency)), 0n);
    }
  }

  // `async` so a broken rule rejects the promise, as the real service will; no `await` inside, so the
  // checks and the writes run in one go, which is what makes the fake atomic.
  // eslint-disable-next-line @typescript-eslint/require-await
  async post(operation: PostOperation): Promise<PostResult> {
    assertWellFormed(operation);
    this.assertKnownAccounts(operation);
    assertZeroSum(operation);

    const fingerprint = operationFingerprint(operation);
    const known = this.operations.get(operation.idempotencyKey);
    if (known) {
      if (known.fingerprint !== fingerprint) {
        throw ledgerError(
          LedgerErrorCode.IdempotencyConflict,
          LEDGER_ERROR_MESSAGES.idempotencyConflict,
        );
      }
      return { operation: structuredClone(known.operation), replayed: true };
    }

    const updated = new Map<string, bigint>();
    for (const { account, amount } of operation.entries) {
      const key = accountKey(account);
      updated.set(key, (updated.get(key) ?? this.balances.get(key) ?? 0n) + amount);
    }
    for (const { account } of operation.entries) {
      if (account.type === 'user' && (updated.get(accountKey(account)) ?? 0n) < 0n) {
        throw ledgerError(
          LedgerErrorCode.InsufficientFunds,
          LEDGER_ERROR_MESSAGES.insufficientFunds,
        );
      }
    }

    // `updated` holds each account once, so an account named in several entries still gets +1.
    for (const [key, balance] of updated) {
      this.balances.set(key, balance);
      this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    }
    // Cloned on the way in and out: the caller's objects must never alias what a replay returns.
    const posted: PostedOperation = structuredClone({
      ...operation,
      id: randomUUID(),
      createdAt: new Date(),
    });
    this.operations.set(operation.idempotencyKey, { operation: posted, fingerprint });
    return { operation: structuredClone(posted), replayed: false };
  }

  getBalances(userId: string): Promise<UserBalance[]> {
    return Promise.resolve(
      CURRENCIES.map((currency) => {
        const key = accountKey(userAccount(userId, currency));
        const amount = this.balances.get(key) ?? 0n;
        this.balances.set(key, amount);
        return { currency, amount, version: this.versions.get(key) ?? 0 };
      }),
    );
  }

  /** Only the platform and external accounts need to exist up front; user accounts appear on first use. */
  private assertKnownAccounts(operation: PostOperation): void {
    for (const { account } of operation.entries) {
      if (account.type !== 'user' && !this.balances.has(accountKey(account))) {
        throw new Error(`Unknown ledger account ${accountKey(account)}`);
      }
    }
  }
}
