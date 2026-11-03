import { GraphQLError } from 'graphql';
import { AUTH_ERROR_MESSAGES, AuthErrorCode, authError } from './auth-errors.js';

describe('authError', () => {
  it('puts the message and the code into the GraphQL error', () => {
    const error = authError(
      AuthErrorCode.InvalidCredentials,
      AUTH_ERROR_MESSAGES.invalidCredentials,
    );
    expect(error).toBeInstanceOf(GraphQLError);
    expect(error.message).toBe('Invalid email or password');
    // The literal is the contract value the clients read.
    expect(error.extensions).toEqual({ code: 'INVALID_CREDENTIALS' });
  });

  it('adds extra fields, but they cannot replace the code', () => {
    const error = authError(AuthErrorCode.BadUserInput, 'Invalid email', {
      field: 'email',
      code: 'OTHER',
    });
    expect(error.extensions).toEqual({ code: 'BAD_USER_INPUT', field: 'email' });
  });
});

describe('AUTH_ERROR_MESSAGES', () => {
  it('builds a message from the values it needs', () => {
    const lockedUntil = new Date('2026-11-03T16:45:00.000Z');
    expect(AUTH_ERROR_MESSAGES.accountLocked(lockedUntil)).toBe(
      'Account is locked until 2026-11-03T16:45:00.000Z',
    );
  });
});
