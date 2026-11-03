import { GraphQLError } from 'graphql';

/** Error codes of the auth API (see the contract), reported as GraphQL `extensions.code`. */
export const AuthErrorCode = {
  BadUserInput: 'BAD_USER_INPUT',
  InvalidCredentials: 'INVALID_CREDENTIALS',
  AccountLocked: 'ACCOUNT_LOCKED',
  InvalidRefreshToken: 'INVALID_REFRESH_TOKEN',
} as const;

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

/**
 * Messages of the auth errors, kept in one place. A function takes the values its text needs.
 * Messages are for developers and reach the client: never put secrets or personal data in them.
 * `BAD_USER_INPUT` messages name the broken rule and live in the validation schema.
 */
export const AUTH_ERROR_MESSAGES = {
  invalidCredentials: 'Invalid email or password',
  accountLocked: (lockedUntil: Date) => `Account is locked until ${lockedUntil.toISOString()}`,
  invalidRefreshToken: 'Session expired, please log in again',
} as const;

/**
 * An auth API error. `extensions` carries extra fields of the contract, e.g. `field` for
 * `BAD_USER_INPUT` or `lockedUntil` for `ACCOUNT_LOCKED`; `code` always wins.
 */
export function authError(
  code: AuthErrorCode,
  message: string,
  extensions: Record<string, unknown> = {},
): GraphQLError {
  return new GraphQLError(message, { extensions: { ...extensions, code } });
}

/**
 * Whether a caught Knex/mysql2 error is a duplicate key on the given unique index, e.g.
 * `users_email_unique`. Catching after the insert (instead of checking first) is deliberate:
 * the insert is atomic, so two concurrent requests cannot both pass a check.
 */
export function isUniqueViolation(error: unknown, indexName: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, sqlMessage } = error as { code?: unknown; sqlMessage?: unknown };
  return (
    code === 'ER_DUP_ENTRY' &&
    typeof sqlMessage === 'string' &&
    // MySQL 8 names the key "<table>.<index>".
    new RegExp(`for key '(?:[^'.]+\\.)?${indexName}'$`).test(sqlMessage)
  );
}
