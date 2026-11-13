/** Largest value of a signed MySQL BIGINT, the type of every amount and balance column of the ledger. */
export const MAX_AMOUNT = 9_223_372_036_854_775_807n;

// `BigInt()` alone also accepts " 12 ", "0x10", "0b1" and "" (= 0n), so the text is checked first.
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * A positive amount in minor units, e.g. "10050" → 10050n (= 100.50 UAH). Returns null for anything
 * else (zero, a sign, a leading zero, a dot, more than MAX_AMOUNT): the caller picks the error.
 */
export function parsePositiveAmount(text: string): bigint | null {
  if (!POSITIVE_INTEGER.test(text)) return null;
  const amount = BigInt(text);
  return amount <= MAX_AMOUNT ? amount : null;
}
