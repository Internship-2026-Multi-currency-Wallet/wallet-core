import { GraphQLError } from 'graphql';

export const AuthErrorCode = {
  BadUserInput: 'BAD_USER_INPUT',
  EmailAlreadyRegistered: 'EMAIL_ALREADY_REGISTERED',
  InvalidCredentials: 'INVALID_CREDENTIALS',
  AccountLocked: 'ACCOUNT_LOCKED',
  InvalidRefreshToken: 'INVALID_REFRESH_TOKEN',
  GoogleLoginDisabled: 'GOOGLE_LOGIN_DISABLED',
  InvalidGoogleState: 'INVALID_GOOGLE_STATE',
  InvalidGoogleCode: 'INVALID_GOOGLE_CODE',
  GoogleEmailNotVerified: 'GOOGLE_EMAIL_NOT_VERIFIED',
  GoogleAccountLinkedToAnotherUser: 'GOOGLE_ACCOUNT_LINKED_TO_ANOTHER_USER',
  GoogleAccountAlreadyLinked: 'GOOGLE_ACCOUNT_ALREADY_LINKED',
  GoogleAccountNotLinked: 'GOOGLE_ACCOUNT_NOT_LINKED',
} as const;

export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode];

/** These messages reach the client: never put secrets or personal data in them. */
export const AUTH_ERROR_MESSAGES = {
  emailAlreadyRegistered: 'Email is already registered',
  invalidCredentials: 'Invalid email or password',
  accountLocked: (lockedUntil: Date) => `Account is locked until ${lockedUntil.toISOString()}`,
  invalidRefreshToken: 'Session expired, please log in again',
  googleLoginDisabled: 'Sign in with Google is disabled',
  invalidGoogleState: 'Google sign-in expired or was started elsewhere, please start again',
  invalidGoogleCode: 'Google sign-in failed, please try again',
  googleEmailNotVerified: 'The email of this Google account is not verified',
  googleAccountLinkedToAnotherUser: 'This Google account is already linked to another user',
  googleAccountAlreadyLinked: 'Another Google account is already linked; unlink it first',
  googleAccountNotLinked: 'No account is linked to this Google account',
  invalidRedirectUri: 'Unknown Google redirect URI',
  codeRequired: 'Google authorization code is required',
  stateRequired: 'Google sign-in state is required',
} as const;

/** `code` is set last, so extra `extensions` cannot override the contract code. */
export function authError(
  code: AuthErrorCode,
  message: string,
  extensions: Record<string, unknown> = {},
): GraphQLError {
  return new GraphQLError(message, { extensions: { ...extensions, code } });
}
