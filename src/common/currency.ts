/** Currencies supported by the platform. Amounts are integers in minor units. */
export const CURRENCIES = ['UAH', 'USD', 'EUR', 'PLN', 'USDT'] as const;
export type Currency = (typeof CURRENCIES)[number];

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}
