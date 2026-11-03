import { scrubQueryError } from './scrub-query-error.js';

const SQL = 'insert into `users` (`email`, `password_hash`) values (?, ?)';

/** A failed query's error as Knex (`compileSqlOnError: false`) and mysql2 shape it. */
function queryError(code: string, errno: number, sqlMessage: string) {
  return {
    message: `${SQL} - ${sqlMessage}`,
    code,
    errno,
    sql: "insert into `users` (`email`, `password_hash`) values ('artem@test.com', '$argon2id$...')",
    sqlMessage,
  };
}

function scrubbed(error: ReturnType<typeof queryError>) {
  scrubQueryError(error);
  return error;
}

describe('scrubQueryError', () => {
  it('drops the SQL with the values inlined', () => {
    const error = scrubbed(
      queryError('ER_DATA_TOO_LONG', 1406, "Data too long for column 'phone'"),
    );
    expect(error).not.toHaveProperty('sql');
  });

  it('keeps MySQL texts that name only tables, columns and keys', () => {
    const text = "Data too long for column 'phone' at row 1";
    const error = scrubbed(queryError('ER_DATA_TOO_LONG', 1406, text));
    expect(error.sqlMessage).toBe(text);
    expect(error.message).toBe(`${SQL} - ${text}`);
  });

  it.each([
    "Duplicate entry 'artem@test.com' for key 'users.users_email_unique'",
    // A value that looks like the end of the message is still hidden whole.
    "Duplicate entry 'x' for key 'other' for key 'users.users_email_unique'",
  ])('keeps only the key of a duplicate: %j', (text) => {
    const error = scrubbed(queryError('ER_DUP_ENTRY', 1062, text));
    expect(error.sqlMessage).toBe("Duplicate entry '?' for key 'users.users_email_unique'");
    expect(error.message).toBe(`${SQL} - Duplicate entry '?' for key 'users.users_email_unique'`);
  });

  it.each([
    [
      'ER_PARSE_ERROR',
      1064,
      "You have an error in your SQL syntax; check the manual ... near ''artem@test.com'' at line 1",
    ],
    [
      'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
      1366,
      "Incorrect integer value: 'artem@test.com' for column 'failed_login_attempts' at row 1",
    ],
  ])('replaces any other MySQL text with its code: %s', (code, errno, text) => {
    const error = scrubbed(queryError(code, errno, text));
    expect(error.sqlMessage).toBe(`${code} (errno ${errno})`);
    expect(error.message).toBe(`${SQL} - ${code} (errno ${errno})`);
  });

  it('leaves an error without MySQL text (e.g. a lost connection) as it is', () => {
    const error = {
      message: `${SQL} - Connection lost: The server closed the connection.`,
      code: 'PROTOCOL_CONNECTION_LOST',
    };
    scrubQueryError(error);
    expect(error.message).toBe(`${SQL} - Connection lost: The server closed the connection.`);
  });
});
