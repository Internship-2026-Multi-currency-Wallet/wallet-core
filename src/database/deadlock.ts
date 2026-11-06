const ER_LOCK_DEADLOCK = 1213;

/** InnoDB rolled the transaction back to break a deadlock; running it again is safe. */
export function isDeadlock(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { errno, code } = error as { errno?: unknown; code?: unknown };
  return errno === ER_LOCK_DEADLOCK || code === 'ER_LOCK_DEADLOCK';
}
