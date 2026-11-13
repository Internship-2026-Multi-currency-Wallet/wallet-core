/**
 * Event catalog — the contract for events exchanged between services over Redis.
 *
 * This file is IDENTICAL in wallet-core, rates-service and treasury-service.
 * Change it in all three repositories (contract PR, reviewed by the consumers).
 * Evolve payloads by adding optional fields; a breaking change needs a new `v`.
 *
 * Conventions:
 * - Money amounts are integers in minor units, encoded as strings ("10050" = 100.50).
 * - Rates are decimal strings ("41.2500"). Never floats.
 * - Timestamps are ISO 8601 strings in UTC.
 */
import type { Currency } from '../common/currency.js';

/** A rate update from one source, or the aggregated consensus (`source: 'consensus'`). */
export interface RateTickEvent {
  v: 1;
  /** Source id, e.g. `nbu`, `kraken`, or `consensus`. */
  source: string;
  base: Currency;
  quote: Currency;
  /** Price of 1 `base` in `quote`. `bid`/`ask` are null when the source has only a mid rate. */
  bid: string | null;
  ask: string | null;
  mid: string;
  /** When the source quoted the rate. */
  ts: string;
}

/** A user's conversion was executed and booked in the ledger. Must not be lost → Redis Stream. */
export interface ConversionCompletedEvent {
  v: 1;
  /** Unique event id. Consumers use it for idempotency. */
  eventId: string;
  conversionId: string;
  /** Client code, e.g. `kvitka`. */
  client: string;
  userId: string;
  /** What the user gave. */
  from: { currency: Currency; amount: string };
  /** What the user received. */
  to: { currency: Currency; amount: string };
  /** Applied client rate: units of `to` per 1 unit of `from`. */
  rate: string;
  /** Market mid rate at execution (before the client spread). */
  midRate: string;
  occurredAt: string;
}

/**
 * One event per user per operation; pub/sub is enough because a missed message is fixed by
 * reloading the balances.
 */
export interface BalanceChangedEvent {
  v: 1;
  /** The ledger operation, for tracing and deduplication. */
  operationId: string;
  userId: string;
  /**
   * Full new amounts, each applied only if its `version` (= GraphQL `Balance.version`) is larger
   * than the one shown, because delivery order is not commit order.
   */
  balances: { currency: Currency; amount: string; version: number }[];
  /** Taken before the posting waited for its locks, so it is not an order: use `version`. */
  occurredAt: string;
}

/** Diagnostics: a backend says "hello" to the others (used to trace a requestId across services). */
export interface SystemPingEvent {
  v: 1;
  /** Service that published the ping, e.g. `wallet-core`. */
  from: string;
  ts: string;
}

/** Event name → payload type. */
export interface EventPayloads {
  'rate.tick': RateTickEvent;
  'conversion.completed': ConversionCompletedEvent;
  'balance.changed': BalanceChangedEvent;
  'system.ping': SystemPingEvent;
}

/**
 * Metadata sent next to every payload (not part of it). Filled in by the publisher helpers:
 * `requestId` of the request that caused the event, so the consumer logs the same id.
 */
export interface EventMeta {
  requestId?: string;
  /** Service that published the event. */
  publisher?: string;
  publishedAt?: string;
}

export type EventName = keyof EventPayloads;

type EventDefinition =
  | { transport: 'pubsub'; channel: string }
  | { transport: 'stream'; stream: string; maxLen: number };

/**
 * Where each event travels.
 * - `pubsub`: Redis pub/sub channel. Fire-and-forget; a subscriber that is down misses messages.
 * - `stream`: Redis Stream. Persistent; consumers read with consumer groups and ack.
 */
export const EVENTS = {
  'rate.tick': { transport: 'pubsub', channel: 'rate.tick' },
  'conversion.completed': {
    transport: 'stream',
    stream: 'conversion.completed',
    maxLen: 100_000,
  },
  'balance.changed': { transport: 'pubsub', channel: 'balance.changed' },
  'system.ping': { transport: 'pubsub', channel: 'system.ping' },
} as const satisfies Record<EventName, EventDefinition>;

export type PubSubEventName = {
  [K in EventName]: (typeof EVENTS)[K]['transport'] extends 'pubsub' ? K : never;
}[EventName];

export type StreamEventName = {
  [K in EventName]: (typeof EVENTS)[K]['transport'] extends 'stream' ? K : never;
}[EventName];

/** Field name under which a stream entry stores the JSON payload. */
export const STREAM_PAYLOAD_FIELD = 'payload';
/** Field name under which a stream entry stores the JSON `EventMeta`. */
export const STREAM_META_FIELD = 'meta';

/** A pub/sub message: `{ "meta": {...}, "payload": {...} }`. */
export interface PubSubEnvelope<P = unknown> {
  meta: EventMeta;
  payload: P;
}
