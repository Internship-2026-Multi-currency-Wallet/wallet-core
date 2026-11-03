import { isUniqueViolation } from './unique-violation.js';

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
  });

  it('ignores a duplicate on another index', () => {
    expect(isUniqueViolation(duplicate('users.PRIMARY'), 'users_email_unique')).toBe(false);
    expect(isUniqueViolation(duplicate('users.users_email_unique_old'), 'users_email_unique')).toBe(
      false,
    );
    expect(isUniqueViolation(duplicate('users.old_users_email_unique'), 'users_email_unique')).toBe(
      false,
    );
  });

  it('ignores other errors', () => {
    expect(isUniqueViolation(new Error('connection lost'), 'users_email_unique')).toBe(false);
    expect(isUniqueViolation({ errno: 1146 }, 'users_email_unique')).toBe(false);
    expect(isUniqueViolation(undefined, 'users_email_unique')).toBe(false);
    expect(isUniqueViolation('ER_DUP_ENTRY', 'users_email_unique')).toBe(false);
  });
});
