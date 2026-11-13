import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CURRENCIES } from '../common/currency.js';
import { isDeadlock } from '../database/deadlock.js';
import { LEDGER_ERROR_MESSAGES, LedgerErrorCode, ledgerError } from './ledger-errors.js';
import { assertWellFormed, assertZeroSum } from './ledger-rules.js';
import { InsertOperationResult, LedgerRepository } from './ledger.repository.js';
import { LedgerService } from './ledger.service.js';
import {
  accountKey,
  userAccount,
  type AccountRef,
  type PostOperation,
  type PostResult,
  type UserBalance,
} from './ledger.types.js';
import { MAX_AMOUNT } from './money.js';
import { operationFingerprint } from './operation-fingerprint.js';

const MAX_ATTEMPTS = 3;

/**
 * `LedgerService` on MySQL. One posting is one transaction that locks the account rows in ascending id
 * order, so concurrent postings on the same accounts queue up instead of deadlocking.
 */
@Injectable()
export class KnexLedgerService extends LedgerService {
  constructor(private readonly repository: LedgerRepository) {
    super();
  }

  async post(operation: PostOperation): Promise<PostResult> {
    assertWellFormed(operation);
    assertZeroSum(operation);
    const fingerprint = operationFingerprint(operation);
    return this.withDeadlockRetry(() => this.postOnce(operation, fingerprint));
  }

  async getBalances(userId: string): Promise<UserBalance[]> {
    return this.withDeadlockRetry(async () => {
      await this.ensureUserAccounts(CURRENCIES.map((currency) => userAccount(userId, currency)));
      const rows = await this.repository.readUserBalances(userId);
      return CURRENCIES.map((currency) => ({
        currency,
        amount: rows.find((row) => row.currency === currency)?.balance ?? 0n,
      }));
    });
  }

  private async postOnce(operation: PostOperation, fingerprint: string): Promise<PostResult> {
    const entryAccountIds = await this.resolveAccounts(
      operation.entries.map((entry) => entry.account),
    );

    const posted = await this.repository.transaction(async (tx) => {
      const id = randomUUID();
      const createdAt = new Date();
      const changes = new Map<string, bigint>();
      operation.entries.forEach(({ amount }, index) => {
        const accountId = entryAccountIds[index];
        changes.set(accountId, (changes.get(accountId) ?? 0n) + amount);
      });

      // Locks before the operation row: parallel requests with one key then queue on the account rows, one
      // at a time. Queued on the key's unique index instead, they all wake up together when the first one
      // rolls back (e.g. INSUFFICIENT_FUNDS) and deadlock each other, more often than 3 attempts can absorb.
      const locked = await tx.lockAccounts([...changes.keys()]);
      const inserted = await tx.insertOperation({
        id,
        type: operation.type,
        idempotencyKey: operation.idempotencyKey,
        fingerprint,
        createdAt,
      });
      if (inserted === InsertOperationResult.KeyTaken) return undefined;

      const balances = new Map<string, bigint>();
      for (const account of locked) {
        const balance = account.balance + (changes.get(account.id) ?? 0n);
        // The column is a signed BIGINT: a server-side guard, the API caps amounts long before this.
        if (balance > MAX_AMOUNT || balance < -MAX_AMOUNT) {
          throw new Error('Ledger balance would leave the BIGINT range');
        }
        if (account.type === 'user' && balance < 0n) {
          throw ledgerError(
            LedgerErrorCode.InsufficientFunds,
            LEDGER_ERROR_MESSAGES.insufficientFunds,
          );
        }
        balances.set(account.id, balance);
      }

      for (const [accountId, balance] of balances) await tx.updateBalance(accountId, balance);
      await tx.insertEntries(
        operation.entries.map((entry, index) => ({
          id: randomUUID(),
          operationId: id,
          accountId: entryAccountIds[index],
          amount: entry.amount,
        })),
      );
      return { id, createdAt };
    });

    if (posted) {
      // Cloned: the caller's entry objects must never alias what is returned.
      return {
        operation: { ...operation, ...posted, entries: structuredClone(operation.entries) },
        replayed: false,
      };
    }
    return this.replay(operation, fingerprint);
  }

  /**
   * Read outside the posting transaction, in a fresh snapshot: the first writer has committed by now.
   * Nothing is written.
   */
  private async replay(operation: PostOperation, fingerprint: string): Promise<PostResult> {
    const stored = await this.repository.findOperationByKey(operation.idempotencyKey);
    if (!stored) throw new Error('Ledger idempotency key is taken but its operation is missing');
    if (stored.fingerprint !== fingerprint) {
      throw ledgerError(
        LedgerErrorCode.IdempotencyConflict,
        LEDGER_ERROR_MESSAGES.idempotencyConflict,
      );
    }
    return {
      operation: {
        id: stored.id,
        type: stored.type,
        idempotencyKey: operation.idempotencyKey,
        createdAt: stored.createdAt,
        entries: stored.entries,
      },
      replayed: true,
    };
  }

  /** Creates missing user accounts, then returns the account id of each ref, in order. Platform accounts are never created. */
  private async resolveAccounts(refs: readonly AccountRef[]): Promise<string[]> {
    await this.ensureUserAccounts(refs);
    const ids = await this.repository.findAccountIds(refs);
    return refs.map((ref) => {
      const id = ids.get(accountKey(ref));
      if (id === undefined) throw new Error(`Unknown ledger account ${accountKey(ref)}`);
      return id;
    });
  }

  private async ensureUserAccounts(refs: readonly AccountRef[]): Promise<void> {
    const users = new Map<string, Extract<AccountRef, { type: 'user' }>>();
    for (const ref of refs) {
      if (ref.type === 'user') users.set(accountKey(ref), ref);
    }
    const createdAt = new Date();
    // A stable order, so two callers creating the same rows take their locks in the same order.
    const ordered = [...users.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    await this.repository.ensureUserAccounts(
      ordered.map(([, ref]) => ({
        id: randomUUID(),
        userId: ref.userId,
        currency: ref.currency,
        createdAt,
      })),
    );
  }

  /** Ordered locking makes deadlocks rare; InnoDB can still pick a victim, and running it again is safe. */
  private async withDeadlockRetry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isDeadlock(error)) throw error;
      }
    }
  }
}
