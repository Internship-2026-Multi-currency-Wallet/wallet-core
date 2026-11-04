const ER_DUP_ENTRY = 1062;

/**
 * Classify the failed insert instead of checking first: the insert is atomic, so two concurrent
 * requests cannot both pass a check.
 */
export function isUniqueViolation(error: unknown, indexName: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { errno, sqlMessage } = error as { errno?: unknown; sqlMessage?: unknown };
  return (
    errno === ER_DUP_ENTRY &&
    typeof sqlMessage === 'string' &&
    // MySQL 8 names the key "<table>.<index>".
    sqlMessage.endsWith(`.${indexName}'`)
  );
}
