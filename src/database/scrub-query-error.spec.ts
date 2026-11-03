import { scrubQueryError } from './scrub-query-error.js';

/** A failed query's error as Knex (`compileSqlOnError: false`) and mysql2 shape it. */
function queryError(sqlMessage: string) {
  return {
    message: `insert into \`users\` (\`email\`, \`password_hash\`) values (?, ?) - ${sqlMessage}`,
    sql: "insert into `users` (`email`, `password_hash`) values ('artem@test.com', '$argon2id$...')",
    sqlMessage,
  };
}

describe('scrubQueryError', () => {
  it('drops the SQL with the values inlined', () => {
    const error = queryError("Data too long for column 'phone' at row 1");
    scrubQueryError(error);
    expect(error).not.toHaveProperty('sql');
    expect(error.sqlMessage).toBe("Data too long for column 'phone' at row 1");
  });

  it.each([
    [
      "Duplicate entry 'artem@test.com' for key 'users.users_email_unique'",
      "Duplicate entry '?' for key 'users.users_email_unique'",
    ],
    [
      // A value with quotes inside is hidden whole.
      "Duplicate entry 'o'neil@test.com' for key 'users.users_email_unique'",
      "Duplicate entry '?' for key 'users.users_email_unique'",
    ],
    [
      "Incorrect integer value: 'artem@test.com' for column 'failed_login_attempts' at row 1",
      "Incorrect integer value: '?' for column 'failed_login_attempts' at row 1",
    ],
    ["Truncated incorrect DOUBLE value: 'artem@test.com'", "Truncated incorrect DOUBLE value: '?'"],
  ])('hides the value in %j', (sqlMessage, scrubbed) => {
    const error = queryError(sqlMessage);
    scrubQueryError(error);
    expect(error.sqlMessage).toBe(scrubbed);
    expect(error.message).toBe(
      `insert into \`users\` (\`email\`, \`password_hash\`) values (?, ?) - ${scrubbed}`,
    );
  });

  it('keeps messages that carry no values', () => {
    const error = queryError("Table 'wallet_core.no_such_table' doesn't exist");
    scrubQueryError(error);
    expect(error.sqlMessage).toBe("Table 'wallet_core.no_such_table' doesn't exist");
  });
});
