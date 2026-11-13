import { Field, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { CURRENCIES, CURRENCY_DECIMALS, type Currency } from '../common/currency.js';

// registerEnumType wants an object; the keys are the GraphQL values, so they follow CURRENCIES.
export const CurrencyEnum = Object.fromEntries(
  CURRENCIES.map((currency) => [currency, currency]),
) as Record<Currency, Currency>;

registerEnumType(CurrencyEnum, {
  name: 'Currency',
  description: 'A currency of the wallet. Amounts are integers in its minor units.',
});

@ObjectType({ description: 'The balance of one currency.' })
export class Balance {
  @Field(() => CurrencyEnum, { description: 'Currency of this balance.' })
  currency: Currency;

  @Field({
    description:
      'Integer in minor units as a decimal string, e.g. "10050" = 100.50 UAH. A string because USDT amounts do not fit a safe JavaScript number.',
  })
  amount: string;

  @Field(() => Int, {
    description:
      'Number of fractional digits of the currency (2 for fiat, 6 for USDT): the amount divided by 10^decimals is the human value.',
  })
  decimals: number;

  @Field(() => Int, {
    description:
      'Grows by 1 with every change of this balance. Show the value with the larger version: a reply or an event with a version lower than or equal to the one shown is older.',
  })
  version: number;
}

export function toBalance(currency: Currency, amount: bigint): Balance {
  return { currency, amount: amount.toString(), decimals: CURRENCY_DECIMALS[currency] };
}
