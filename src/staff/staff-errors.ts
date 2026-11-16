import { GraphQLError } from 'graphql';
import { AUTH_ERROR_MESSAGES } from '../auth/auth-errors.js';

export const StaffErrorCode = {
  BadUserInput: 'BAD_USER_INPUT',
  StaffAlreadyExists: 'STAFF_ALREADY_EXISTS',
  StaffNotFound: 'STAFF_NOT_FOUND',
  NotInvited: 'NOT_INVITED',
  CannotDeactivateSelf: 'CANNOT_DEACTIVATE_SELF',
  LastAdmin: 'LAST_ADMIN',
  InvalidInvitation: 'INVALID_INVITATION',
  InvalidCredentials: 'INVALID_CREDENTIALS',
  AccountLocked: 'ACCOUNT_LOCKED',
  InvalidRefreshToken: 'INVALID_REFRESH_TOKEN',
  InvalidCurrentPassword: 'INVALID_CURRENT_PASSWORD',
} as const;

export type StaffErrorCode = (typeof StaffErrorCode)[keyof typeof StaffErrorCode];

/** These messages reach the client: never put emails, tokens or ids in them. */
export const STAFF_ERROR_MESSAGES = {
  staffAlreadyExists: 'Staff member with this email already exists',
  staffNotFound: 'Staff member not found',
  notInvited: 'Staff member is not in the invited status',
  cannotDeactivateSelf: 'You cannot deactivate your own account',
  lastAdmin: 'The last active admin cannot be deactivated or demoted',
  invalidInvitation: 'Invitation link is invalid or has expired',
  invalidCredentials: AUTH_ERROR_MESSAGES.invalidCredentials,
  accountLocked: AUTH_ERROR_MESSAGES.accountLocked,
  invalidRefreshToken: AUTH_ERROR_MESSAGES.invalidRefreshToken,
  invalidCurrentPassword: 'Current password is incorrect',
} as const;

/** `code` is set last, so extra `extensions` cannot override the contract code. */
export function staffError(
  code: StaffErrorCode,
  message: string,
  extensions: Record<string, unknown> = {},
): GraphQLError {
  return new GraphQLError(message, { extensions: { ...extensions, code } });
}
