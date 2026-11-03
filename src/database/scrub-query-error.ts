/** Fields of a failed query's error (mysql2) that can carry the values that went into it. */
interface QueryError {
  message: string;
  sql?: string;
  sqlMessage?: string;
}

/**
 * MySQL messages that quote a value of the query. Only the value is replaced: the column and key
 * names stay, so the error can still be told apart (e.g. a duplicate by its index).
 */
const QUOTED_VALUES = [
  // ER_DUP_ENTRY: Duplicate entry 'artem@test.com' for key 'users.users_email_unique'
  /(?<=Duplicate entry )'.*'(?= for key ')/s,
  // Incorrect integer value: 'abc' for column 'x' at row 1 / Truncated incorrect DOUBLE value: 'abc'
  /(?<=value: )'.*?'(?= for column '|$)/s,
];

function hideValues(text: string): string {
  return QUOTED_VALUES.reduce((result, pattern) => result.replace(pattern, "'?'"), text);
}

/**
 * Removes the query's values from its error before anyone catches or logs it (Knex `query-error`).
 * mysql2 adds `sql` with the values inlined; MySQL quotes some values in its own message.
 */
export function scrubQueryError(error: QueryError): void {
  delete error.sql;
  error.message = hideValues(error.message);
  if (error.sqlMessage !== undefined) error.sqlMessage = hideValues(error.sqlMessage);
}
