import { NotFoundException } from '@nestjs/common';
import { Args, Mutation, Query, Resolver, Subscription } from '@nestjs/graphql';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { Currency } from '../common/currency.js';
import { AppConfig } from '../config/app-config.js';
import type { BalanceChangedEvent } from '../events/catalog.js';
import { EventSubscriber } from '../events/event-bus.js';
import { RequirePermission } from '../permissions/require-permission.decorator.js';
import { balanceChanges } from './balance-changes.js';
import { Balance, CurrencyEnum, toBalance } from './balance.model.js';
import { LedgerService } from './ledger.service.js';
import { isTestCreditAllowed, parseTestCreditAmount, testCreditOperation } from './test-credit.js';

/** The owner is always the caller (from the token), never an argument. */
@RequirePermission('wallet')
@Resolver(() => Balance)
export class LedgerResolver {
  constructor(
    private readonly config: AppConfig,
    private readonly ledger: LedgerService,
    private readonly subscriber: EventSubscriber,
    @InjectPinoLogger(LedgerResolver.name) private readonly logger: PinoLogger,
  ) {}

  @Query(() => [Balance], {
    description:
      'The balances of the caller: always five rows, in the order UAH, USD, EUR, PLN, USDT, zeros included. Errors: UNAUTHENTICATED, FORBIDDEN (staff tokens have no `wallet` permission).',
  })
  async balances(@CurrentUser() user: AuthUser): Promise<Balance[]> {
    const balances = await this.ledger.getBalances(user.id);
    return balances.map(({ currency, amount, version }) => toBalance(currency, amount, version));
  }

  @Subscription(() => [Balance], {
    description:
      "Live balance changes of the caller, one message per operation. A message lists every balance that operation changed, each with its full new amount (not a delta). Only the caller's own changes are delivered. Errors: UNAUTHENTICATED, FORBIDDEN (staff tokens have no `wallet` permission).",
    resolve: (changed: BalanceChangedEvent['balances']): Balance[] =>
      changed.map(({ currency, amount, version }) => toBalance(currency, BigInt(amount), version)),
  })
  balanceChanged(
    @CurrentUser() user: AuthUser,
  ): Promise<AsyncIterableIterator<BalanceChangedEvent['balances']>> {
    return balanceChanges(this.subscriber, user.id, this.logger);
  }

  @Mutation(() => Balance, {
    description:
      'Moves money from the platform funding account to the caller. Exists only on local and staging. `amount` is a positive integer string in minor units, at most 1,000,000 units of the currency per call. Returns the new TOTAL balance of that currency. Errors: BAD_USER_INPUT (extensions.field), UNAUTHENTICATED, FORBIDDEN (staff tokens have no `wallet` permission), NOT_FOUND (on kvitka-uat and wisla-uat, for authenticated callers: an anonymous caller gets UNAUTHENTICATED first).',
  })
  async testCredit(
    @CurrentUser() user: AuthUser,
    @Args('currency', { type: () => CurrencyEnum, description: 'The currency to credit.' })
    currency: Currency,
    @Args('amount', {
      description:
        'Positive integer in minor units, as a string; at most 1,000,000 units of the currency (e.g. "100000000" for UAH, "1000000000000" for USDT).',
    })
    amountText: string,
  ): Promise<Balance> {
    if (!isTestCreditAllowed(this.config.appEnv)) throw new NotFoundException();
    const amount = parseTestCreditAmount(currency, amountText);
    await this.ledger.post(testCreditOperation(user.id, currency, amount));
    // Read after post(): the total may already include another change that committed in between.
    const balances = await this.ledger.getBalances(user.id);
    const total = balances.find((balance) => balance.currency === currency);
    if (!total) throw new Error(`getBalances returned no ${currency} balance`);
    return toBalance(currency, total.amount, total.version);
  }
}
