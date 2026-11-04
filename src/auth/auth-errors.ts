import { GraphQLError } from 'graphql';

export const AuthErrorCode = {
  BadUserInput: 'BAD_USER_INPUT',
  EmailAlreadyRegistered: 'EMAIL_ALREADY_REGISTERED',
  InvalidCredentials: 'INVALID_CREDENTIALS',
  AccountLocked: 'ACCOUNT_LOCKED',
  InvalidRefreshToken: 'INVALID_REFRESH_TOKEN',
} as const;

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

/** These messages reach the client: never put secrets or personal data in them. */
export const AUTH_ERROR_MESSAGES = {
  emailAlreadyRegistered: 'Email is already registered',
  invalidCredentials: 'Invalid email or password',
  accountLocked: (lockedUntil: Date) => `Account is locked until ${lockedUntil.toISOString()}`,
  invalidRefreshToken: 'Session expired, please log in again',
} as const;

/** `code` is set last, so extra `extensions` cannot override the contract code. */
export function authError(
  code: AuthErrorCode,
  message: string,
  extensions: Record<string, unknown> = {},
): GraphQLError {
  return new GraphQLError(message, { extensions: { ...extensions, code } });
}
