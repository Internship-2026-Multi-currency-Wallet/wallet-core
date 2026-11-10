import {
  collectDefaultMetrics,
  Counter,
  type CounterConfiguration,
  Gauge,
  type GaugeConfiguration,
  Histogram,
  type HistogramConfiguration,
  Registry,
} from 'prom-client';

export const UNKNOWN_OPERATION = '(unknown)';
export const MAX_OPERATIONS = 100;
const MAX_OPERATION_LENGTH = 100;

export const DURATION_BUCKETS = [0.005, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type Config<T> = Omit<T, 'registers'>;

export class Metrics {
  readonly registry = new Registry();
  readonly httpRequests: Counter<'operation' | 'status'>;
  readonly httpRequestDuration: Histogram<'operation'>;
  readonly graphqlErrors: Counter<'operation' | 'code'>;
  readonly graphqlWsConnections: Gauge;
  private readonly operations = new Set<string>();

  constructor(defaultLabels: { service: string; env: string }) {
    this.registry.setDefaultLabels(defaultLabels);
    collectDefaultMetrics({ register: this.registry });
    this.httpRequests = this.counter({
      name: 'http_requests_total',
      help: 'HTTP requests by GraphQL operation (or route) and status code',
      labelNames: ['operation', 'status'],
    });
    this.httpRequestDuration = this.histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration by GraphQL operation (or route)',
      labelNames: ['operation'],
      buckets: DURATION_BUCKETS,
    });
    this.graphqlErrors = this.counter({
      name: 'graphql_errors_total',
      help: 'GraphQL requests that failed, by operation and error code (each code once per request)',
      labelNames: ['operation', 'code'],
    });
    this.graphqlWsConnections = this.gauge({
      name: 'graphql_ws_connections',
      help: 'Open GraphQL websocket connections',
    });
  }

  counter<T extends string>(config: Config<CounterConfiguration<T>>): Counter<T> {
    return new Counter({ ...config, registers: [this.registry] });
  }

  histogram<T extends string>(config: Config<HistogramConfiguration<T>>): Histogram<T> {
    return new Histogram({ ...config, registers: [this.registry] });
  }

  gauge<T extends string>(config: Config<GaugeConfiguration<T>>): Gauge<T> {
    return new Gauge({ ...config, registers: [this.registry] });
  }

  operation(name: string | undefined): string {
    if (!name || name.length > MAX_OPERATION_LENGTH) return UNKNOWN_OPERATION;
    if (this.operations.has(name)) return name;
    if (this.operations.size >= MAX_OPERATIONS) return UNKNOWN_OPERATION;
    this.operations.add(name);
    return name;
  }
}
