/**
 * Thin typed helpers on top of ioredis for the events in `catalog.ts`.
 * Identical in all backend services.
 */
import type { Redis } from 'ioredis';
import {
  EVENTS,
  type EventName,
  type EventPayloads,
  type PubSubEventName,
  STREAM_PAYLOAD_FIELD,
  type StreamEventName,
} from './catalog.js';

export type Unsubscribe = () => Promise<void>;

/** Publishes events: pub/sub events with PUBLISH, stream events with XADD. */
export class EventPublisher {
  constructor(private readonly redis: Redis) {}

  /** Returns the stream entry id for stream events, `null` for pub/sub events. */
  async publish<N extends EventName>(name: N, payload: EventPayloads[N]): Promise<string | null> {
    const definition = EVENTS[name];
    const data = JSON.stringify(payload);
    if (definition.transport === 'pubsub') {
      await this.redis.publish(definition.channel, data);
      return null;
    }
    return this.redis.xadd(
      definition.stream,
      'MAXLEN',
      '~',
      String(definition.maxLen),
      '*',
      STREAM_PAYLOAD_FIELD,
      data,
    );
  }
}

/**
 * Subscribes to pub/sub events. Uses its own Redis connection (a connection in subscriber
 * mode cannot run other commands). Call `close()` on shutdown.
 *
 * Stream events are read with consumer groups (XREADGROUP + XACK); use `decodeStreamEntry`
 * to turn a raw entry into a typed payload.
 */
export class EventSubscriber {
  private readonly handlers = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();
  private listening = false;

  constructor(
    private readonly connection: Redis,
    private readonly onError: (error: unknown, channel: string) => void = () => undefined,
  ) {}

  async subscribe<N extends PubSubEventName>(
    name: N,
    handler: (payload: EventPayloads[N]) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    const { channel } = EVENTS[name];
    this.listen();
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.connection.subscribe(channel);
    }
    const wrapped = handler as (payload: unknown) => void | Promise<void>;
    set.add(wrapped);
    return async () => {
      set.delete(wrapped);
      if (set.size === 0) {
        this.handlers.delete(channel);
        await this.connection.unsubscribe(channel);
      }
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
    if (this.connection.status === 'ready') await this.connection.quit();
    else this.connection.disconnect();
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.connection.on('message', (channel: string, message: string) => {
      const handlers = this.handlers.get(channel);
      if (!handlers) return;
      let payload: unknown;
      try {
        payload = JSON.parse(message);
      } catch (error) {
        this.onError(error, channel);
        return;
      }
      for (const handler of handlers) {
        Promise.resolve()
          .then(() => handler(payload))
          .catch((error: unknown) => this.onError(error, channel));
      }
    });
  }
}

/** Decodes the field list of a stream entry (`[field, value, ...]`) into a typed payload. */
export function decodeStreamEntry<N extends StreamEventName>(
  _name: N,
  fields: string[],
): EventPayloads[N] {
  const index = fields.indexOf(STREAM_PAYLOAD_FIELD);
  if (index === -1 || index + 1 >= fields.length) {
    throw new Error(`Stream entry has no "${STREAM_PAYLOAD_FIELD}" field`);
  }
  return JSON.parse(fields[index + 1]) as EventPayloads[N];
}
