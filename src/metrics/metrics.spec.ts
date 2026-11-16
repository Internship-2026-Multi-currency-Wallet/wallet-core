import { describe, expect, it } from '@jest/globals';
import { MAX_OPERATIONS, Metrics, requestExemplar, UNKNOWN_OPERATION } from './metrics.js';
import { parse } from 'graphql';
import {
  countGraphqlErrors,
  graphqlErrorCode,
  operationName,
  wsOperationName,
} from './request-metrics.js';

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

  it('attaches the request id to durations and errors as an OpenMetrics exemplar', async () => {
    const metrics = new Metrics({ service: 'wallet-core', env: 'local' });
    metrics.httpRequestDuration.observe({
      labels: { operation: 'query me' },
      value: 0.01,
      exemplarLabels: requestExemplar('req-1'),
    });
    metrics.graphqlErrors.inc({
      labels: { operation: 'query me', code: 'FORBIDDEN' },
      exemplarLabels: requestExemplar('req-2'),
    });
    const text = await metrics.registry.metrics();
    expect(metrics.registry.contentType).toMatch(/^application\/openmetrics-text/);
    expect(text).toMatch(/http_request_duration_seconds_bucket\{.*\} 1 # \{trace_id="req-1"\}/);
    expect(text).toMatch(/graphql_errors_total\{.*\} 1 # \{trace_id="req-2"\}/);
  });
});

describe('requestExemplar', () => {
  it('links to the request id, unless the id is missing or too long for an exemplar', () => {
    expect(requestExemplar('a'.repeat(120))).toEqual({ trace_id: 'a'.repeat(120) });
    expect(requestExemplar('a'.repeat(121))).toBeUndefined();
    expect(requestExemplar(undefined)).toBeUndefined();
  });
});

describe('countGraphqlErrors', () => {
  const errorsLine = async (metrics: Metrics) =>
    (await metrics.registry.metrics())
      .split('\n')
      .find((l) => l.startsWith('graphql_errors_total{'));

  it('writes no exemplar for an error without a request id (websocket)', async () => {
    const metrics = new Metrics({ service: 'wallet-core', env: 'local' });
    countGraphqlErrors(metrics, 'query me', [{ message: 'x' }]);
    expect(await errorsLine(metrics)).not.toContain('# {');
  });

  it('keeps the last real exemplar when a later error has no usable request id', async () => {
    const metrics = new Metrics({ service: 'wallet-core', env: 'local' });
    countGraphqlErrors(metrics, 'query me', [{ message: 'x' }], 'req-1');
    countGraphqlErrors(metrics, 'query me', [{ message: 'x' }]);
    countGraphqlErrors(metrics, 'query me', [{ message: 'x' }], 'a'.repeat(121));
    expect(await errorsLine(metrics)).toMatch(/\} 3 # \{trace_id="req-1"\}/);
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

  it('finds the root field inside inline fragments and fragment spreads', () => {
    expect(wsOperationName(parse('query Q { ... on Query { me { id } } }'))).toBe('query me');
    expect(wsOperationName(parse('query Q { ...Root } fragment Root on Query { me { id } }'))).toBe(
      'query me',
    );
  });

  it('gives ambiguous and missing operations no label', () => {
    expect(wsOperationName(parse('query A { a } query B { b }'))).toBeUndefined();
    expect(wsOperationName(undefined, 'A')).toBeUndefined();
  });
});
