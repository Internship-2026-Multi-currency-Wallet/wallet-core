import { CURRENCIES, CURRENCY_DECIMALS } from './currency.js';

describe('CURRENCY_DECIMALS', () => {
  it('has an entry for every currency and nothing else', () => {
    expect(Object.keys(CURRENCY_DECIMALS)).toEqual([...CURRENCIES]);
  });

  it('uses 2 decimals for fiat and 6 for USDT', () => {
    expect(CURRENCY_DECIMALS).toEqual({ UAH: 2, USD: 2, EUR: 2, PLN: 2, USDT: 6 });
  });
});
