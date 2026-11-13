import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CURRENCIES } from '../common/currency.js';
import { isDeadlock } from '../database/deadlock.js';
import { LEDGER_ERROR_MESSAGES, LedgerErrorCode, ledgerError } from './ledger-errors.js';
import { assertWellFormed, assertZeroSum } from './ledger-rules.js';
import { InsertOperationResult, LedgerRepository } from './ledger.repository.js';
import { LedgerService } from './ledger.service.js';
import {
  accountKey,
  type AccountRef,
  type EntryInput,
  type OperationType,
  type PostOperation,
  type PostResult,
  type UserBalance,
} from './ledger.types.js';
import { MAX_AMOUNT } from './money.js';
import { operationFingerprint } from './operation-fingerprint.js';

const MAX_ATTEMPTS = 3;

interface ResolvedEntry {
  accountId: string;
  amount: bigint;
}

/**
 * `LedgerService` on MySQL. A posting is one transaction that locks its account rows in ascending id
 * order; `getBalances` only reads, and user accounts are created by the first posting that names them.
 */
@Injectable()
export class KnexLedgerService extends LedgerService {
  constructor(
    private readonly repository: LedgerRepository,
    @InjectPinoLogger(KnexLedgerService.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  async post(operation: PostOperation): Promise<PostResult> {
    assertWellFormed(operation);
    assertZeroSum(operation);
    const fingerprint = operationFingerprint(operation);
    const result = await this.withDeadlockRetry(operation.type, () =>
      this.postOnce(operation, fingerprint),
    );
    this.logger.info(
      { operationId: result.operation.id, type: result.operation.type, replayed: result.replayed },
      result.replayed ? 'ledger operation replayed' : 'ledger operation posted',
    );
    return result;
  }

  async getBalances(userId: string): Promise<UserBalance[]> {
    const rows = await this.repository.readUserBalances(userId);
    return CURRENCIES.map((currency) => ({
      currency,
      amount: rows.find((row) => row.currency === currency)?.balance ?? 0n,
    }));
  }

  private async postOnce(operation: PostOperation, fingerprint: string): Promise<PostResult> {
    const entries = await this.resolveEntries(operation.entries);

    const posted = await this.repository.transaction(async (tx) => {
      const id = randomUUID();
      const createdAt = new Date();
      const changes = new Map<string, bigint>();
      for (const { accountId, amount } of entries) {
        changes.set(accountId, (changes.get(accountId) ?? 0n) + amount);
      }

      // Before the operation row: parallel posts with one key queue on the account rows. Queued on the
      // key's unique index instead, they all wake up together when the first one rolls back and deadlock.
      const locked = await tx.lockAccounts([...changes.keys()]);
      if (locked.length !== changes.size) {
        throw new Error('A ledger account disappeared before it was locked');
      }
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
        entries.map((entry) => ({ id: randomUUID(), operationId: id, ...entry })),
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

  // After the posting transaction has ended: a replay writes nothing, so it holds no locks while it reads.
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

  // Platform and external accounts exist before any posting (migration, feature setup): never created here.
  private async resolveEntries(entries: readonly EntryInput[]): Promise<ResolvedEntry[]> {
    const refs = entries.map((entry) => entry.account);
    const ids = await this.repository.findAccountIds(refs);
    const missing = refs.filter((ref) => ref.type === 'user' && !ids.has(accountKey(ref)));
    if (missing.length > 0) {
      await this.ensureUserAccounts(missing);
      for (const [key, id] of await this.repository.findAccountIds(missing)) ids.set(key, id);
    }
    return entries.map(({ account, amount }) => {
      const accountId = ids.get(accountKey(account));
      if (accountId === undefined) throw new Error(`Unknown ledger account ${accountKey(account)}`);
      return { accountId, amount };
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

  /** Locking in id order makes deadlocks rare, not impossible (two posts creating one account); a rerun is safe. */
  private async withDeadlockRetry<T>(type: OperationType, work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work();
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isDeadlock(error)) throw error;
        this.logger.warn({ err: error, attempt, type }, 'ledger deadlock, trying again');
      }
    }
  }
}
