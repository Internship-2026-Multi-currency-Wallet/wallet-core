import { GraphQLError } from 'graphql';
import { AUTH_ERROR_MESSAGES, AuthErrorCode, authError, isUniqueViolation } from './auth-errors.js';

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

describe('isUniqueViolation', () => {
  // Shape of the error Knex rethrows from mysql2 (captured from MySQL 8.4).
  const duplicate = (key: string) =>
    Object.assign(
      new Error(`insert into \`users\` ... - Duplicate entry 'a@b.c' for key '${key}'`),
      {
        code: 'ER_DUP_ENTRY',
        errno: 1062,
        sqlMessage: `Duplicate entry 'a@b.c' for key '${key}'`,
      },
    );

  it('recognises a duplicate on the given index', () => {
    expect(isUniqueViolation(duplicate('users.users_email_unique'), 'users_email_unique')).toBe(
      true,
    );
    expect(isUniqueViolation(duplicate('users_email_unique'), 'users_email_unique')).toBe(true);
  });

  it('ignores a duplicate on another index', () => {
    expect(isUniqueViolation(duplicate('users.PRIMARY'), 'users_email_unique')).toBe(false);
    expect(isUniqueViolation(duplicate('users.users_email_unique_old'), 'users_email_unique')).toBe(
      false,
    );
  });

  it('ignores other errors', () => {
    expect(isUniqueViolation(new Error('connection lost'), 'users_email_unique')).toBe(false);
    expect(isUniqueViolation({ code: 'ER_NO_SUCH_TABLE' }, 'users_email_unique')).toBe(false);
    expect(isUniqueViolation(undefined, 'users_email_unique')).toBe(false);
    expect(isUniqueViolation('ER_DUP_ENTRY', 'users_email_unique')).toBe(false);
  });
});
