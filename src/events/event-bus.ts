/**
 * Thin typed helpers on top of ioredis for the events in `catalog.ts`.
 * Identical in all backend services.
 *
 * Every Redis name is prefixed with the environment (`APP_ENV`), e.g. `kvitka-uat:rate.tick`,
 * so several environments can share one Redis. Always go through these helpers (or
 * `redisName`) instead of using the raw names from the catalog.
 *
 * Every event travels with `EventMeta` (`requestId`, `publisher`, `publishedAt`): pub/sub messages
 * as `{ meta, payload }`, stream entries as the fields `payload` and `meta`. The `EventContext`
 * supplies the meta of the current request when publishing and runs handlers inside the
 * incoming meta, so a consumer logs the same `requestId` as the producer.
 */
import type { Redis } from 'ioredis';
import {
  EVENTS,
  type EventMeta,
  type EventName,
  type EventPayloads,
  type PubSubEnvelope,
  type PubSubEventName,
  STREAM_META_FIELD,
  STREAM_PAYLOAD_FIELD,
  type StreamEventName,
} from './catalog.js';

export type Unsubscribe = () => Promise<void>;

/** Bridges the helpers to the logging context (see `events.module.ts`). */
export interface EventContext {
  /** Meta of the current context (e.g. `{ requestId, publisher }`) for an outgoing event. */
  current(): EventMeta;
  /** Runs a handler inside the context of an incoming event. */
  run<T>(meta: EventMeta, fn: () => T): T;
}

/** No context: empty meta, handlers run as they are. */
export const NO_EVENT_CONTEXT: EventContext = {
  current: () => ({}),
  run: (_meta, fn) => fn(),
};

/** `<prefix>:<name>`, e.g. `staging:conversion.completed`. The prefix is the environment (`APP_ENV`). */
export function redisName(prefix: string, name: string): string {
  if (!prefix || prefix.includes(':')) throw new Error(`Invalid Redis prefix "${prefix}"`);
  return `${prefix}:${name}`;
}

/** Prefixed pub/sub channel of an event. */
export function eventChannel(prefix: string, name: PubSubEventName): string {
  return redisName(prefix, EVENTS[name].channel);
}

/** Prefixed stream key of an event (for XREADGROUP / XACK in consumers). */
export function eventStream(prefix: string, name: StreamEventName): string {
  return redisName(prefix, EVENTS[name].stream);
}

/** Publishes events: pub/sub events with PUBLISH, stream events with XADD. */
export class EventPublisher {
  constructor(
    private readonly redis: Redis,
    /** Environment prefix (`APP_ENV`). */
    private readonly prefix: string,
    private readonly context: EventContext = NO_EVENT_CONTEXT,
  ) {}

  /** Returns the stream entry id for stream events, `null` for pub/sub events. */
  async publish<N extends EventName>(name: N, payload: EventPayloads[N]): Promise<string | null> {
    const definition = EVENTS[name];
    const meta: EventMeta = { ...this.context.current(), publishedAt: new Date().toISOString() };
    if (definition.transport === 'pubsub') {
      const envelope: PubSubEnvelope<EventPayloads[N]> = { meta, payload };
      await this.redis.publish(
        redisName(this.prefix, definition.channel),
        JSON.stringify(envelope),
      );
      return null;
    }
    return this.redis.xadd(
      redisName(this.prefix, definition.stream),
      'MAXLEN',
      '~',
      String(definition.maxLen),
      '*',
      STREAM_PAYLOAD_FIELD,
      JSON.stringify(payload),
      STREAM_META_FIELD,
      JSON.stringify(meta),
    );
  }
}

type Handler = (payload: unknown, meta: EventMeta) => void | Promise<void>;

/** Splits a pub/sub message into meta and payload (a bare payload has empty meta). */
export function decodePubSubMessage(message: string): PubSubEnvelope {
  const parsed = JSON.parse(message) as unknown;
  if (parsed !== null && typeof parsed === 'object' && 'payload' in parsed && 'meta' in parsed) {
    const { meta, payload } = parsed as PubSubEnvelope;
    return { meta: meta ?? {}, payload };
  }
  return { meta: {}, payload: parsed };
}

/**
 * Subscribes to pub/sub events. Uses its own Redis connection (a connection in subscriber
 * mode cannot run other commands). Call `close()` on shutdown.
 *
 * Stream events are read with consumer groups (XREADGROUP + XACK) on `eventStream(prefix, name)`;
 * use `decodeStreamEntry` / `decodeStreamMeta` to turn a raw entry into a typed payload and its
 * meta, and `EventContext.run(meta, ...)` to handle it in the producer's context.
 */
export class EventSubscriber {
  private readonly handlers = new Map<string, Set<Handler>>();
  private listening = false;

  constructor(
    private readonly connection: Redis,
    /** Environment prefix (`APP_ENV`). */
    private readonly prefix: string,
    private readonly onError: (error: unknown, channel: string) => void = () => undefined,
    private readonly context: EventContext = NO_EVENT_CONTEXT,
  ) {}

  async subscribe<N extends PubSubEventName>(
    name: N,
    handler: (payload: EventPayloads[N], meta: EventMeta) => void | Promise<void>,
  ): Promise<Unsubscribe> {
    const channel = eventChannel(this.prefix, name);
    this.listen();
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.connection.subscribe(channel);
    }
    const wrapped = handler as Handler;
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
      let envelope: PubSubEnvelope;
      try {
        envelope = decodePubSubMessage(message);
      } catch (error) {
        this.onError(error, channel);
        return;
      }
      for (const handler of handlers) {
        void this.context.run(envelope.meta, () =>
          Promise.resolve()
            .then(() => handler(envelope.payload, envelope.meta))
            .catch((error: unknown) => this.onError(error, channel)),
        );
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

/** The `EventMeta` of a stream entry (empty for entries written without it). */
export function decodeStreamMeta(fields: string[]): EventMeta {
  const index = fields.indexOf(STREAM_META_FIELD);
  if (index === -1 || index + 1 >= fields.length) return {};
  return JSON.parse(fields[index + 1]) as EventMeta;
}
