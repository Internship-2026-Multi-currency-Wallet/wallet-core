import { describe, expect, it } from '@jest/globals';
import { MAX_OPERATIONS, Metrics, UNKNOWN_OPERATION } from './metrics.js';
import { graphqlErrorCode, operationName } from './request-metrics.js';

describe('Metrics.operation', () => {
  it('keeps names until the cap, then sends new ones to the unknown bucket', () => {
    const metrics = new Metrics({ service: 'wallet-core', env: 'local' });
    for (let i = 0; i < MAX_OPERATIONS; i++)
      expect(metrics.operation(`query Q${i}`)).toBe(`query Q${i}`);
    expect(metrics.operation('query OneTooMany')).toBe(UNKNOWN_OPERATION);
    expect(metrics.operation('query Q0')).toBe('query Q0');
  });

  it('sends missing and overlong names to the unknown bucket', () => {
    const metrics = new Metrics({ service: 'wallet-core', env: 'local' });
    expect(metrics.operation(undefined)).toBe(UNKNOWN_OPERATION);
    expect(metrics.operation(`query ${'A'.repeat(200)}`)).toBe(UNKNOWN_OPERATION);
  });

  it('labels every metric with service and env', async () => {
    const metrics = new Metrics({ service: 'wallet-core', env: 'staging' });
    metrics.httpRequests.inc({ operation: 'query Me', status: 200 });
    const text = await metrics.registry.metrics();
    expect(text).toContain(
      'http_requests_total{operation="query Me",status="200",service="wallet-core",env="staging"} 1',
    );
    expect(text).toMatch(/process_cpu_seconds_total\{service="wallet-core",env="staging"\}/);
  });
});

describe('operationName', () => {
  it('names GraphQL operations like the access log', () => {
    expect(operationName({ graphqlOperation: { type: 'mutation', name: 'Convert' } })).toBe(
      'mutation Convert',
    );
  });

  it('puts anonymous GraphQL operations into the unknown bucket', () => {
    expect(operationName({ graphqlOperation: { type: 'query', name: null } })).toBeUndefined();
  });

  it('names REST requests by method and route pattern, not by the raw path', () => {
    expect(operationName({ method: 'POST', route: { path: '/diagnostics/ping' } })).toBe(
      'POST /diagnostics/ping',
    );
    expect(operationName({ method: 'GET' })).toBeUndefined();
  });

  it('puts unresolved GraphQL and unrouted requests into the unknown bucket', () => {
    expect(operationName({ method: 'POST', route: { path: '{/*splat}' } })).toBeUndefined();
    expect(operationName({ method: 'POST', route: { path: '/graphql' } })).toBeUndefined();
  });
});

describe('graphqlErrorCode', () => {
  it('uses the code the client sees, else INTERNAL_SERVER_ERROR', () => {
    expect(graphqlErrorCode({ message: 'x', extensions: { code: 'FORBIDDEN' } })).toBe('FORBIDDEN');
    expect(graphqlErrorCode({ message: 'x' })).toBe('INTERNAL_SERVER_ERROR');
  });
});
