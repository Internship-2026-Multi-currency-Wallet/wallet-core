/** Fields of a failed query's error (mysql2) that can carry the values that went into it. */
interface QueryError {
  message: string;
  code?: string;
  errno?: number;
  sql?: string;
  sqlMessage?: string;
}

const ER_DUP_ENTRY = 1062;

/**
 * MySQL errors whose text names only tables, columns and keys, never a value of the query, so it
 * is kept for debugging. Any other MySQL text may quote a value (e.g. a syntax error quotes the
 * query near the error) and is replaced by its code.
 */
const SAFE_TEXT_ERRNOS = new Set([
  1048, // ER_BAD_NULL_ERROR: Column 'x' cannot be null
  1054, // ER_BAD_FIELD_ERROR: Unknown column 'x' in 'field list'
  1146, // ER_NO_SUCH_TABLE: Table 'db.x' doesn't exist
  1205, // ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded; try restarting transaction
  1213, // ER_LOCK_DEADLOCK: Deadlock found when trying to get lock; try restarting transaction
  1406, // ER_DATA_TOO_LONG: Data too long for column 'x' at row 1
  1451, // ER_ROW_IS_REFERENCED_2: Cannot delete or update a parent row: a foreign key constraint fails (...)
  1452, // ER_NO_REFERENCED_ROW_2: Cannot add or update a child row: a foreign key constraint fails (...)
]);

/** MySQL's text without values: kept when safe, the key alone for a duplicate, else the code. */
function safeSqlMessage(error: QueryError, sqlMessage: string): string {
  if (error.errno === ER_DUP_ENTRY) {
    // The value comes first and may contain anything; the key name is always last.
    const key = /for key '([^']*)'$/.exec(sqlMessage)?.[1] ?? '?';
    return `Duplicate entry '?' for key '${key}'`;
  }
  if (error.errno !== undefined && SAFE_TEXT_ERRNOS.has(error.errno)) return sqlMessage;
  return `${error.code ?? 'ER_UNKNOWN'} (errno ${error.errno ?? '?'})`;
}

/**
 * Removes the query's values from its error before anyone catches or logs it (Knex `query-error`).
 * mysql2 adds `sql` with the values inlined; MySQL may quote values in its own text, which ends the
 * message after the SQL (`<sql with ?> - <MySQL text>`).
 */
export function scrubQueryError(error: QueryError): void {
  delete error.sql;
  const { sqlMessage } = error;
  // Errors MySQL did not answer (e.g. a lost connection) carry no MySQL text and no values.
  if (sqlMessage === undefined) return;
  const safe = safeSqlMessage(error, sqlMessage);
  error.sqlMessage = safe;
  error.message = error.message.endsWith(sqlMessage)
    ? error.message.slice(0, error.message.length - sqlMessage.length) + safe
    : safe;
}
