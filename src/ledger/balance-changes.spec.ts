import { jest } from '@jest/globals';
import type { BalanceChangedEvent } from '../events/catalog.js';
import { balanceChanges, type BalanceChangedSource } from './balance-changes.js';

const ME = 'user-me';

function event(userId: string, uah: string): BalanceChangedEvent {
  return {
    v: 1,
    operationId: `op-${uah}`,
    userId,
    balances: [{ currency: 'UAH', amount: uah }],
    occurredAt: '2026-11-13T10:00:00.000Z',
  };
}

/** A subscriber that keeps its handlers, so a test publishes by calling them. */
class FakeSource implements BalanceChangedSource {
  readonly handlers = new Set<(event: BalanceChangedEvent) => void>();
  readonly unsubscribe = jest.fn(() => Promise.resolve());

  subscribe(
    _name: 'balance.changed',
    handler: (event: BalanceChangedEvent) => void,
  ): ReturnType<BalanceChangedSource['subscribe']> {
    this.handlers.add(handler);
    return Promise.resolve(async () => {
      this.handlers.delete(handler);
      await this.unsubscribe();
    });
  }

  publish(published: BalanceChangedEvent): void {
    for (const handler of this.handlers) handler(published);
  }
}

describe('balanceChanges', () => {
  it('yields only the events of the user, in order', async () => {
    const source = new FakeSource();
    const iterator = await balanceChanges(source, ME);

    source.publish(event(ME, '100'));
    source.publish(event('someone-else', '999'));
    source.publish(event(ME, '250'));

    await expect(iterator.next()).resolves.toEqual({
      value: [{ currency: 'UAH', amount: '100' }],
      done: false,
    });
    await expect(iterator.next()).resolves.toEqual({
      value: [{ currency: 'UAH', amount: '250' }],
      done: false,
    });
  });

  it('waits for the next event instead of finishing', async () => {
    const source = new FakeSource();
    const iterator = await balanceChanges(source, ME);
    const settled = jest.fn();

    const pending = iterator.next().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    source.publish(event('someone-else', '1'));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    source.publish(event(ME, '5'));
    await pending;
    expect(settled).toHaveBeenCalledWith({
      value: [{ currency: 'UAH', amount: '5' }],
      done: false,
    });
  });

  it('is subscribed as soon as it resolves', async () => {
    const source = new FakeSource();
    await balanceChanges(source, ME);
    expect(source.handlers.size).toBe(1);
  });

  it('return() unsubscribes and ends a next() that is waiting', async () => {
    const source = new FakeSource();
    const iterator = await balanceChanges(source, ME);

    const pending = iterator.next();
    await iterator.return?.();

    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(source.unsubscribe).toHaveBeenCalledTimes(1);
    expect(source.handlers.size).toBe(0);
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('unsubscribes once, however many times return() is called', async () => {
    const source = new FakeSource();
    const iterator = await balanceChanges(source, ME);

    await Promise.all([iterator.return?.(), iterator.return?.()]);
    await iterator.return?.();

    expect(source.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes when the consumer throws', async () => {
    const source = new FakeSource();
    const iterator = await balanceChanges(source, ME);
    source.publish(event(ME, '1'));

    const consume = async (): Promise<void> => {
      for await (const balances of iterator) {
        throw new Error(`consumer failed on ${balances.length} balance`);
      }
    };

    await expect(consume()).rejects.toThrow('consumer failed');
    expect(source.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes when the consumer stops with break', async () => {
    const source = new FakeSource();
    const iterator = await balanceChanges(source, ME);
    source.publish(event(ME, '1'));

    for await (const balances of iterator) {
      expect(balances).toHaveLength(1);
      break;
    }

    expect(source.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('ignores events that arrive after return()', async () => {
    const source = new FakeSource();
    const iterator = await balanceChanges(source, ME);
    await iterator.return?.();

    source.publish(event(ME, '1'));

    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });
});
