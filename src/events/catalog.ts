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

/** Event name → payload type. */
export interface EventPayloads {
  'rate.tick': RateTickEvent;
  'conversion.completed': ConversionCompletedEvent;
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
} as const satisfies Record<EventName, EventDefinition>;

export type PubSubEventName = {
  [K in EventName]: (typeof EVENTS)[K]['transport'] extends 'pubsub' ? K : never;
}[EventName];

export type StreamEventName = {
  [K in EventName]: (typeof EVENTS)[K]['transport'] extends 'stream' ? K : never;
}[EventName];

/** Field name under which a stream entry stores the JSON payload. */
export const STREAM_PAYLOAD_FIELD = 'payload';
