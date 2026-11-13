import { assertWellFormed, assertZeroSum } from './ledger-rules.js';
import {
  PLATFORM_FUNDING,
  platformAccount,
  userAccount,
  type EntryInput,
  type PostOperation,
} from './ledger.types.js';

function operation(entries: EntryInput[]): PostOperation {
  return { type: 'test_credit', idempotencyKey: 'k1', entries };
}

const funding = (currency: 'UAH' | 'USD') => platformAccount(PLATFORM_FUNDING, currency);

describe('assertWellFormed', () => {
  it('accepts an operation with non-zero entries', () => {
    const entries = [
      { account: funding('UAH'), amount: -5n },
      { account: userAccount('u1', 'UAH'), amount: 5n },
    ];
    expect(() => assertWellFormed(operation(entries))).not.toThrow();
  });

  it('rejects an operation without entries', () => {
    expect(() => assertWellFormed(operation([]))).toThrow('no entries');
  });

  it('rejects a zero amount', () => {
    const entries = [
      { account: funding('UAH'), amount: 0n },
      { account: userAccount('u1', 'UAH'), amount: 5n },
    ];
    expect(() => assertWellFormed(operation(entries))).toThrow('must not be zero');
  });
});

describe('assertZeroSum', () => {
  it('accepts an operation that balances in each currency', () => {
    const entries = [
      { account: userAccount('u1', 'UAH'), amount: -4125n },
      { account: funding('UAH'), amount: 4125n },
      { account: funding('USD'), amount: -100n },
      { account: userAccount('u1', 'USD'), amount: 100n },
    ];
    expect(() => assertZeroSum(operation(entries))).not.toThrow();
  });

  it('rejects a currency that does not sum to zero and names only the currency', () => {
    const entries = [
      { account: funding('UAH'), amount: -100n },
      { account: userAccount('u1', 'UAH'), amount: 90n },
    ];
    expect(() => assertZeroSum(operation(entries))).toThrow(
      'Ledger operation does not sum to zero in UAH',
    );
  });

  it('rejects an operation that balances in total but not per currency', () => {
    const entries = [
      { account: funding('UAH'), amount: -100n },
      { account: userAccount('u1', 'USD'), amount: 100n },
    ];
    expect(() => assertZeroSum(operation(entries))).toThrow('does not sum to zero');
  });
});
