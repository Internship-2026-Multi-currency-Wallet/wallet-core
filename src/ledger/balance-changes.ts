import type { PinoLogger } from 'nestjs-pino';
import type { BalanceChangedEvent } from '../events/catalog.js';
import type { Unsubscribe } from '../events/event-bus.js';
import { redisErrorReason } from '../redis/redis-connection.js';

type ChangedBalances = BalanceChangedEvent['balances'];

/** What `balanceChanges` needs from `EventSubscriber`; a fake in unit tests. */
export interface BalanceChangedSource {
  subscribe(
    name: 'balance.changed',
    handler: (event: BalanceChangedEvent) => void,
  ): Promise<Unsubscribe>;
}

const FINISHED: IteratorResult<ChangedBalances> = { value: undefined, done: true };

/**
 * The balances changed by each operation of one user, in order, as an async iterator.
 * It resolves once the Redis SUBSCRIBE is done, so every event published after that is kept.
 * The queue needs no bound: the graphql-ws keep-alive ends a client that stops reading (which calls
 * `return()`), and one user gets few events.
 *
 * Hand-written instead of `async function*`: graphql-ws calls `return()` when the client goes away, and on
 * a generator that is waiting for an event `return()` would only run after the next event arrives.
 */
export async function balanceChanges(
  source: BalanceChangedSource,
  userId: string,
  logger: Pick<PinoLogger, 'debug'>,
): Promise<AsyncIterableIterator<ChangedBalances>> {
  const queue: ChangedBalances[] = [];
  const waiting: ((result: IteratorResult<ChangedBalances>) => void)[] = [];
  let stopping: Promise<void> | undefined;

  const unsubscribe = await source.subscribe('balance.changed', (event) => {
    if (stopping || event.userId !== userId) return;
    const resolve = waiting.shift();
    if (resolve) resolve({ value: event.balances, done: false });
    else queue.push(event.balances);
  });

  const stop = async (): Promise<void> => {
    queue.length = 0;
    for (const resolve of waiting.splice(0)) resolve(FINISHED);
    // graphql-ws calls return() without a catch: a failed UNSUBSCRIBE (Redis down) must not crash the process.
    await unsubscribe().catch((error: unknown) =>
      logger.debug(
        { reason: redisErrorReason(error), userId },
        'balance.changed unsubscribe failed',
      ),
    );
  };

  const iterator: AsyncIterableIterator<ChangedBalances> = {
    next() {
      const balances = queue.shift();
      if (balances) return Promise.resolve({ value: balances, done: false });
      if (stopping) return Promise.resolve(FINISHED);
      return new Promise((resolve) => waiting.push(resolve));
    },
    async return() {
      stopping ??= stop();
      await stopping;
      return FINISHED;
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}
