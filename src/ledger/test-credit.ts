import { randomUUID } from 'node:crypto';
import { CURRENCY_DECIMALS, type Currency } from '../common/currency.js';
import type { AppEnv } from '../config/env.schema.js';
import { LEDGER_ERROR_MESSAGES, LedgerErrorCode, ledgerError } from './ledger-errors.js';
import {
  PLATFORM_FUNDING,
  platformAccount,
  userAccount,
  type PostOperation,
} from './ledger.types.js';
import { parsePositiveAmount } from './money.js';

/** `testCredit` mints fake money, so it exists only outside client UAT environments (local and staging). */
export function isTestCreditAllowed(appEnv: AppEnv): boolean {
  return !appEnv.endsWith('-uat');
}

/** Whole units of a currency one call may credit, so a single call cannot push a balance near the BIGINT limit. */
const MAX_UNITS_PER_CALL = 1_000_000n;

export function parseTestCreditAmount(currency: Currency, text: string): bigint {
  const amount = parsePositiveAmount(text);
  const cap = MAX_UNITS_PER_CALL * 10n ** BigInt(CURRENCY_DECIMALS[currency]);
  if (amount === null || amount > cap) {
    throw ledgerError(LedgerErrorCode.BadUserInput, LEDGER_ERROR_MESSAGES.invalidTestCreditAmount, {
      field: 'amount',
    });
  }
  return amount;
}

/** A fresh key per call: every call credits, a retried request is not deduplicated. */
export function testCreditOperation(
  userId: string,
  currency: Currency,
  amount: bigint,
): PostOperation {
  return {
    type: 'test_credit',
    idempotencyKey: `test_credit:${randomUUID()}`,
    entries: [
      { account: platformAccount(PLATFORM_FUNDING, currency), amount: -amount },
      { account: userAccount(userId, currency), amount },
    ],
  };
}
