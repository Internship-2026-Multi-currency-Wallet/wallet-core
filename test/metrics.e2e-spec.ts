import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { MetricsServer } from '../src/metrics/metrics-server.js';
import { createApp } from './create-app.js';

function valueOf(text: string, name: string, labels: Record<string, string>): number {
  const wanted = Object.entries(labels).map(([key, value]) => `${key}="${value}"`);
  const line = text
    .split('\n')
    .find((l) => l.startsWith(`${name}{`) && wanted.every((pair) => l.includes(pair)));
  return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
}

function total(text: string, name: string): number {
  return text
    .split('\n')
    .filter((l) => l.startsWith(`${name}{`))
    .reduce((sum, l) => sum + Number(l.slice(l.lastIndexOf(' ') + 1)), 0);
}

describe('metrics (e2e)', () => {
  let app: INestApplication;
  let server: App;
  let metricsUrl: string;

  const scrape = async (): Promise<string> => (await fetch(metricsUrl)).text();
  const me = (auth?: string) => {
    const req = request(server).post('/graphql').send({ query: 'query Me { me { id } }' });
    return auth ? req.set('Authorization', auth) : req;
  };

  beforeAll(async () => {
    app = await createApp({ DEV_AUTH: 'true', APP_ENV: 'local' });
    server = app.getHttpServer() as App;
    metricsUrl = `http://127.0.0.1:${app.get(MetricsServer).port}/metrics`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the Prometheus text format with service and env labels on the metrics port', async () => {
    const res = await fetch(metricsUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
    const text = await res.text();
    expect(text).toMatch(/nodejs_eventloop_lag_seconds\{service="wallet-core",env="local"\}/);
    expect(text).toContain('# TYPE http_request_duration_seconds histogram');
  });

  it('does not serve /metrics on the main port', async () => {
    await request(server).get('/metrics').expect(404);
  });

  it('counts and times a GraphQL query under its operation name', async () => {
    const labels = { operation: 'query Me', status: '200' };
    const before = await scrape();
    await me('Dev 1:wallet').expect(200);
    const after = await scrape();
    expect(valueOf(after, 'http_requests_total', labels)).toBe(
      valueOf(before, 'http_requests_total', labels) + 1,
    );
    expect(
      valueOf(after, 'http_request_duration_seconds_count', { operation: 'query Me' }),
    ).toBeGreaterThan(
      valueOf(before, 'http_request_duration_seconds_count', { operation: 'query Me' }),
    );
  });

  it('counts a failing operation in graphql_errors_total by its code', async () => {
    const labels = { operation: 'query Me', code: 'UNAUTHENTICATED' };
    const before = valueOf(await scrape(), 'graphql_errors_total', labels);
    const res = await me();
    expect((res.body as { errors?: unknown[] }).errors).toHaveLength(1);
    expect(valueOf(await scrape(), 'graphql_errors_total', labels)).toBe(before + 1);
  });

  it('puts anonymous operations into the unknown bucket', async () => {
    const labels = { operation: '(unknown)', status: '200' };
    const before = valueOf(await scrape(), 'http_requests_total', labels);
    await request(server)
      .post('/graphql')
      .send({ query: '{ me { id } }' })
      .set('Authorization', 'Dev 1:wallet')
      .expect(200);
    expect(valueOf(await scrape(), 'http_requests_total', labels)).toBe(before + 1);
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
