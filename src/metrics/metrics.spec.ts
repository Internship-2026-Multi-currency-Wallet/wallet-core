import { describe, expect, it } from '@jest/globals';
import { MAX_OPERATIONS, Metrics, UNKNOWN_OPERATION } from './metrics.js';
import { parse } from 'graphql';
import { graphqlErrorCode, operationName, wsOperationName } from './request-metrics.js';

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
  it('uses the operation label the Apollo plugin stored on the request', () => {
    expect(operationName({ metricsOperation: 'mutation convert' })).toBe('mutation convert');
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

describe('wsOperationName', () => {
  it('labels the selected operation by its root field, whatever the client calls it', () => {
    const document = parse('query A { a } mutation Junk123 { convert { id } }');
    expect(wsOperationName(document, 'Junk123')).toBe('mutation convert');
    expect(wsOperationName(parse('subscription S { s }'))).toBe('subscription s');
    expect(wsOperationName(parse('{ me { id } }'))).toBe('query me');
  });

  it('gives ambiguous and missing operations no label', () => {
    expect(wsOperationName(parse('query A { a } query B { b }'))).toBeUndefined();
    expect(wsOperationName(undefined, 'A')).toBeUndefined();
  });
});
