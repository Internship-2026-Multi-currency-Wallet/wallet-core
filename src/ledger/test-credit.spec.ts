import type { Currency } from '../common/currency.js';
import { APP_ENVS, type AppEnv } from '../config/env.schema.js';
import { LedgerErrorCode } from './ledger-errors.js';
import { PLATFORM_FUNDING } from './ledger.types.js';
import { isTestCreditAllowed, parseTestCreditAmount, testCreditOperation } from './test-credit.js';

// A Record makes the compiler demand a row for every new APP_ENV.
const EXPECTED: Record<AppEnv, boolean> = {
  local: true,
  staging: true,
  'kvitka-uat': false,
  'wisla-uat': false,
};

/** The extensions of the error `parseTestCreditAmount` throws; fails if the text is accepted. */
function rejection(currency: Currency, text: string): Record<string, unknown> {
  try {
    parseTestCreditAmount(currency, text);
  } catch (error) {
    return (error as { extensions: Record<string, unknown> }).extensions;
  }
  throw new Error(`"${text}" was accepted`);
}

describe('isTestCreditAllowed', () => {
  it.each(APP_ENVS)('%s', (appEnv) => {
    expect(isTestCreditAllowed(appEnv)).toBe(EXPECTED[appEnv]);
  });
});

describe('parseTestCreditAmount', () => {
  it('parses a positive integer in minor units', () => {
    expect(parseTestCreditAmount('UAH', '10050')).toBe(10050n);
  });

  // 1 000 000 units of the currency: 10^6 × 10^decimals minor units.
  it.each([
    ['UAH', 100_000_000n],
    ['USD', 100_000_000n],
    ['EUR', 100_000_000n],
    ['PLN', 100_000_000n],
    ['USDT', 1_000_000_000_000n],
  ] as const)('accepts exactly the cap for %s and rejects one more', (currency, cap) => {
    expect(parseTestCreditAmount(currency, cap.toString())).toBe(cap);
    expect(rejection(currency, (cap + 1n).toString())).toMatchObject({
      code: LedgerErrorCode.BadUserInput,
      field: 'amount',
    });
  });

  it.each(['0', '-1', '+1', '1.5', 'abc', '', ' 5', '007', '0x10', '1e3'])(
    'rejects "%s" with BAD_USER_INPUT on the amount field',
    (text) => {
      expect(rejection('UAH', text)).toMatchObject({
        code: LedgerErrorCode.BadUserInput,
        field: 'amount',
      });
    },
  );
});

describe('testCreditOperation', () => {
  it('takes the amount from the funding account and gives it to the user', () => {
    const operation = testCreditOperation('user-1', 'USDT', 5n);
    expect(operation.type).toBe('test_credit');
    expect(operation.entries).toEqual([
      { account: { type: 'platform', code: PLATFORM_FUNDING, currency: 'USDT' }, amount: -5n },
      { account: { type: 'user', userId: 'user-1', currency: 'USDT' }, amount: 5n },
    ]);
  });

  it('uses a fresh idempotency key for every call', () => {
    const first = testCreditOperation('user-1', 'UAH', 1n).idempotencyKey;
    const second = testCreditOperation('user-1', 'UAH', 1n).idempotencyKey;
    expect(first).toMatch(/^test_credit:[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });
});
