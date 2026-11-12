import { NotFoundException, NotImplementedException } from '@nestjs/common';
import { Args, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';
import type { Currency } from '../common/currency.js';
import { AppConfig } from '../config/app-config.js';
import { Balance, CurrencyEnum } from './balance.model.js';
import { isTestCreditAllowed } from './test-credit.js';

/**
 * GraphQL API of the ledger. Contract only for now: every operation answers "not implemented"
 * until the real ledger lands. The owner is always the caller (from the token), never an argument.
 */
@Resolver(() => Balance)
export class LedgerResolver {
  constructor(private readonly config: AppConfig) {}

  @Query(() => [Balance], {
    description:
      'The balances of the caller: always five rows, in the order UAH, USD, EUR, PLN, USDT, zeros included. Errors: UNAUTHENTICATED.',
  })
  balances(): Balance[] {
    throw new NotImplementedException('balances is not implemented yet');
  }

  @Subscription(() => [Balance], {
    description:
      "Live balance changes of the caller, one message per operation. A message lists every balance that operation changed, each with its full new amount (not a delta). Only the caller's own changes are delivered. Errors: UNAUTHENTICATED.",
  })
  balanceChanged(): AsyncIterableIterator<{ balanceChanged: Balance[] }> {
    throw new NotImplementedException('balanceChanged is not implemented yet');
  }

  @Mutation(() => Balance, {
    description:
      'Moves money from the platform funding account to the caller. Exists only on local and staging. `amount` is a positive integer string in minor units. Returns the new TOTAL balance of that currency. Errors: BAD_USER_INPUT (extensions.field), UNAUTHENTICATED, NOT_FOUND (kvitka-uat, wisla-uat).',
  })
  testCredit(
    @Args('currency', { type: () => CurrencyEnum, description: 'The currency to credit.' })
    _currency: Currency,
    @Args('amount', { description: 'Positive integer in minor units, as a string.' })
    _amount: string,
  ): Balance {
    if (!isTestCreditAllowed(this.config.appEnv)) throw new NotFoundException();
    throw new NotImplementedException('testCredit is not implemented yet');
  }
}
