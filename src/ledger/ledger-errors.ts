import { GraphQLError } from 'graphql';

export const LedgerErrorCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  IdempotencyConflict: 'IDEMPOTENCY_CONFLICT',
} as const;

export type LedgerErrorCode = (typeof LedgerErrorCode)[keyof typeof LedgerErrorCode];

/** These messages reach the client: no ids or amounts of other users. */
export const LEDGER_ERROR_MESSAGES = {
  insufficientFunds: 'Insufficient funds',
  idempotencyConflict: 'Idempotency key was already used for a different operation',
} as const;

/** `code` is set last, so extra `extensions` cannot override the contract code. */
export function ledgerError(
  code: LedgerErrorCode,
  message: string,
  extensions: Record<string, unknown> = {},
): GraphQLError {
  return new GraphQLError(message, { extensions: { ...extensions, code } });
}
