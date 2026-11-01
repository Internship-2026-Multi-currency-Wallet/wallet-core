import type { Currency } from '../common/currency.js';

export interface Rate {
  base: Currency;
  quote: Currency;
  /** Price of 1 `base` in `quote`, decimal string (8 decimal places). */
  mid: string;
  /** Where the rate comes from, e.g. `fixed` or `consensus`. */
  source: string;
  asOf: Date;
}

/**
 * Rates seam: how wallet-core gets exchange rates.
 *
 * Bound to `FixedRatesClient` by default, so conversions can be built before rates-service
 * is live. The real client (GraphQL call to rates-service and/or the `rate.tick` stream)
 * implements the same interface and is swapped in `RatesModule` only.
 *
 *   constructor(@Inject(RATES_CLIENT) private readonly rates: RatesClient) {}
 */
export interface RatesClient {
  getRate(base: Currency, quote: Currency): Promise<Rate>;
}

export const RATES_CLIENT = Symbol('RATES_CLIENT');
