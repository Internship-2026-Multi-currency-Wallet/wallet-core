/** Currencies supported by the platform. Amounts are integers in minor units. */
export const CURRENCIES = ['UAH', 'USD', 'EUR', 'PLN', 'USDT'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Fractional digits of the minor unit: 100 minor units = 1.00 UAH, 1 000 000 = 1.000000 USDT. */
export const CURRENCY_DECIMALS: Record<Currency, number> = {
  UAH: 2,
  USD: 2,
  EUR: 2,
  PLN: 2,
  USDT: 6,
};

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}
