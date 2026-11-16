import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { createClient } from 'graphql-ws';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import WebSocket from 'ws';
import { MetricsServer } from '../src/metrics/metrics-server.js';
import { createApp } from './create-app.js';

/** The sample value of a line, ignoring an exemplar (`... 1 # {trace_id="..."} 0.01 1700000000`). */
function sampleValue(line: string): number {
  const sample = line.split(' # ')[0];
  return Number(sample.slice(sample.lastIndexOf(' ') + 1));
}

function valueOf(text: string, name: string, labels: Record<string, string>): number {
  const wanted = Object.entries(labels).map(([key, value]) => `${key}="${value}"`);
  const line = text
    .split('\n')
    .find((l) => l.startsWith(`${name}{`) && wanted.every((pair) => l.includes(pair)));
  return line ? sampleValue(line) : 0;
}

function total(text: string, name: string): number {
  return text
    .split('\n')
    .filter((l) => l.startsWith(`${name}{`))
    .reduce((sum, l) => sum + sampleValue(l), 0);
}

describe('metrics (e2e)', () => {
  let app: INestApplication;
  let server: App;
  let metricsUrl: string;
  let wsUrl: string;

  const scrape = async (): Promise<string> => (await fetch(metricsUrl)).text();
  const me = (auth?: string) => {
    const req = request(server).post('/graphql').send({ query: 'query Me { me { id } }' });
    return auth ? req.set('Authorization', auth) : req;
  };

  beforeAll(async () => {
    app = await createApp({ DEV_AUTH: 'true', APP_ENV: 'local' });
    await app.listen(0);
    server = app.getHttpServer() as App;
    const { port } = (server as unknown as { address(): AddressInfo }).address();
    wsUrl = `ws://localhost:${port}/graphql`;
    metricsUrl = `http://127.0.0.1:${app.get(MetricsServer).port}/metrics`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the OpenMetrics format with service and env labels on the metrics port', async () => {
    const res = await fetch(metricsUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(
      /^application\/openmetrics-text; version=1\.0\.0/,
    );
    const text = await res.text();
    expect(text).toMatch(/nodejs_eventloop_lag_seconds\{service="wallet-core",env="local"\}/);
    expect(text).toContain('# TYPE http_request_duration_seconds histogram');
    expect(text.trimEnd()).toMatch(/# EOF$/);
  });

  it('links the duration and the errors of a request to its requestId (exemplars)', async () => {
    await me().set('x-request-id', 'exemplar-e2e-1');
    const text = await scrape();
    expect(text).toMatch(
      /http_request_duration_seconds_bucket\{[^}]*operation="query me"[^}]*\} \d+ # \{trace_id="exemplar-e2e-1"\}/,
    );
    expect(text).toMatch(
      /graphql_errors_total\{[^}]*code="UNAUTHENTICATED"[^}]*\} \d+ # \{trace_id="exemplar-e2e-1"\}/,
    );
  });

  it('keeps serving a request id too long for an exemplar, without the exemplar', async () => {
    const longId = 'x'.repeat(128);
    const res = await me('Dev 1:wallet').set('x-request-id', longId).expect(200);
    expect(res.headers['x-request-id']).toBe(longId);
    await me('Dev 1:wallet').expect(200);
    expect(await scrape()).not.toContain(longId);
  });

  it('does not serve /metrics on the main port', async () => {
    await request(server).get('/metrics').expect(404);
  });

  it('counts and times a GraphQL query under its operation name', async () => {
    const labels = { operation: 'query me', status: '200' };
    const before = await scrape();
    await me('Dev 1:wallet').expect(200);
    const after = await scrape();
    expect(valueOf(after, 'http_requests_total', labels)).toBe(
      valueOf(before, 'http_requests_total', labels) + 1,
    );
    expect(
      valueOf(after, 'http_request_duration_seconds_count', { operation: 'query me' }),
    ).toBeGreaterThan(
      valueOf(before, 'http_request_duration_seconds_count', { operation: 'query me' }),
    );
  });

  it('counts a failing operation in graphql_errors_total by its code', async () => {
    const labels = { operation: 'query me', code: 'UNAUTHENTICATED' };
    const before = valueOf(await scrape(), 'graphql_errors_total', labels);
    const res = await me();
    expect((res.body as { errors?: unknown[] }).errors).toHaveLength(1);
    expect(valueOf(await scrape(), 'graphql_errors_total', labels)).toBe(before + 1);
  });

  it('labels operations by root field, so client-chosen names cannot add labels', async () => {
    const labels = { operation: 'query me', status: '200' };
    const before = await scrape();
    for (const query of ['{ me { id } }', 'query Junk1 { me { id } }', 'query Junk2 { me { id } }'])
      await request(server).post('/graphql').send({ query }).set('Authorization', 'Dev 1:wallet');
    const after = await scrape();
    expect(valueOf(after, 'http_requests_total', labels)).toBe(
      valueOf(before, 'http_requests_total', labels) + 3,
    );
    expect(after).not.toContain('Junk');
  });

  it('puts unparsable GraphQL and unrouted requests into the unknown bucket', async () => {
    const errors = { operation: '(unknown)', code: 'GRAPHQL_PARSE_FAILED' };
    const before = await scrape();
    await request(server).post('/graphql').send({ query: 'query Broken {' }).expect(400);
    await request(server).get('/no-such-route').expect(404);
    const after = await scrape();
    expect(valueOf(after, 'graphql_errors_total', errors)).toBe(
      valueOf(before, 'graphql_errors_total', errors) + 1,
    );
    expect(valueOf(after, 'http_requests_total', { operation: '(unknown)', status: '404' })).toBe(
      valueOf(before, 'http_requests_total', { operation: '(unknown)', status: '404' }) + 1,
    );
    expect(after).not.toContain('splat');
  });

  it('does not count /health and /metrics', async () => {
    const before = total(await scrape(), 'http_requests_total');
    await request(server).get('/health');
    await request(server).get('/metrics');
    await scrape();
    const after = await scrape();
    expect(total(after, 'http_requests_total')).toBe(before);
    expect(after).not.toContain('/health');
  });

  it('counts and times requests rejected by the body parser', async () => {
    const before = await scrape();
    await request(server)
      .post('/graphql')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
    await request(server)
      .post('/graphql')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ query: `{ ${'a'.repeat(300_000)} }` }))
      .expect(413);
    const after = await scrape();
    for (const status of ['400', '413']) {
      const labels = { operation: '(unknown)', status };
      expect(valueOf(after, 'http_requests_total', labels)).toBe(
        valueOf(before, 'http_requests_total', labels) + 1,
      );
    }
    expect(
      valueOf(after, 'http_request_duration_seconds_count', { operation: '(unknown)' }),
    ).toBeGreaterThanOrEqual(
      valueOf(before, 'http_request_duration_seconds_count', { operation: '(unknown)' }) + 2,
    );
  });

  it('does not count /health in other spellings', async () => {
    const before = total(await scrape(), 'http_requests_total');
    await request(server).get('/health/');
    await request(server).get('/HEALTH');
    await request(server).get('/Health?probe=1');
    expect(total(await scrape(), 'http_requests_total')).toBe(before);
  });

  it('counts GraphQL errors of an operation sent over the websocket', async () => {
    const labels = { operation: 'query me', code: 'UNAUTHENTICATED' };
    const before = valueOf(await scrape(), 'graphql_errors_total', labels);
    const client = createClient({ url: wsUrl, webSocketImpl: WebSocket, retryAttempts: 0 });
    await new Promise<void>((resolve, reject) => {
      client.subscribe(
        { query: 'query Me { me { id } }', operationName: 'Me' },
        { next: () => undefined, error: reject, complete: resolve },
      );
    }).finally(() => void client.dispose());
    expect(valueOf(await scrape(), 'graphql_errors_total', labels)).toBe(before + 1);
  });

  it('counts GraphQL errors rejected before execution over the websocket', async () => {
    const labels = { operation: '(unknown)', code: 'GRAPHQL_VALIDATION_FAILED' };
    const before = valueOf(await scrape(), 'graphql_errors_total', labels);
    const client = createClient({ url: wsUrl, webSocketImpl: WebSocket, retryAttempts: 0 });
    await new Promise<void>((resolve) => {
      client.subscribe(
        { query: 'query Broken { noSuchField }', operationName: 'Broken' },
        { next: () => undefined, error: () => resolve(), complete: resolve },
      );
    }).finally(() => void client.dispose());
    expect(valueOf(await scrape(), 'graphql_errors_total', labels)).toBe(before + 1);
  });

  it('counts published events (the example of a feature metric)', async () => {
    const labels = { type: 'system.ping' };
    const before = valueOf(await scrape(), 'events_published_total', labels);
    await request(server)
      .post('/diagnostics/ping')
      .set('Authorization', 'Dev 1:wallet')
      .expect(200);
    const after = await scrape();
    expect(valueOf(after, 'events_published_total', labels)).toBe(before + 1);
    expect(
      valueOf(after, 'http_requests_total', { operation: 'POST /diagnostics/ping', status: '200' }),
    ).toBeGreaterThan(0);
  });
});
