import type { Currency } from '../common/currency.js';
import type { Rate, RatesClient } from './rates-client.js';

const SCALE = 8;
const ONE = 10n ** BigInt(SCALE);

/** Units of each currency per 1 USD. Fixed, round numbers — not market data. */
export const FIXED_RATES_PER_USD: Record<Currency, string> = {
  USD: '1',
  USDT: '1',
  UAH: '41.5',
  EUR: '0.92',
  PLN: '3.95',
};

function toScaled(decimal: string): bigint {
  const [whole, fraction = ''] = decimal.split('.');
  return BigInt(whole) * ONE + BigInt(fraction.padEnd(SCALE, '0').slice(0, SCALE));
}

function fromScaled(value: bigint): string {
  const whole = value / ONE;
  const fraction = (value % ONE).toString().padStart(SCALE, '0');
  return `${whole}.${fraction}`;
}

/**
 * Fake `RatesClient` with fixed rates for UAH, USD, EUR, PLN and USDT.
 * Cross rates go through USD and are truncated to 8 decimal places (exact integer math).
 */
export class FixedRatesClient implements RatesClient {
  constructor(private readonly now: () => Date = () => new Date()) {}

  getRate(base: Currency, quote: Currency): Promise<Rate> {
    const basePerUsd = toScaled(FIXED_RATES_PER_USD[base]);
    const quotePerUsd = toScaled(FIXED_RATES_PER_USD[quote]);
    const mid = fromScaled((quotePerUsd * ONE) / basePerUsd);
    return Promise.resolve({ base, quote, mid, source: 'fixed', asOf: this.now() });
  }
}
