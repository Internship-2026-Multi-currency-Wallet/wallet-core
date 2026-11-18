import type { INestApplication } from '@nestjs/common';
import { getIntrospectionQuery } from 'graphql';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createApp } from './create-app.js';

interface GqlBody {
  data?: unknown;
  errors?: { message: string; extensions: Record<string, unknown> }[];
}

describe('GraphQL document limits (e2e)', () => {
  let app: INestApplication;

  const post = (query: string) =>
    request(app.getHttpServer() as App)
      .post('/graphql')
      .send({ query });

  beforeAll(async () => {
    app = await createApp({ GRAPHQL_MAX_TOKENS: '30', GRAPHQL_MAX_DEPTH: '3' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers a document over the token limit with 400 GRAPHQL_PARSE_FAILED', async () => {
    const fields = Array.from({ length: 30 }, (_, i) => `f${i}: __typename`).join(' ');

    const res = await post(`{ ${fields} }`).expect(400);

    const [error] = (res.body as GqlBody).errors ?? [];
    expect(error?.extensions.code).toBe('GRAPHQL_PARSE_FAILED');
    expect(error?.message).toBe(
      'Syntax Error: Document contains more that 30 tokens. Parsing aborted.',
    );
  });

  it('answers a document deeper than the limit with 400 GRAPHQL_VALIDATION_FAILED', async () => {
    const res = await post('{ __schema { types { fields { name } } } }').expect(400);

    const [error] = (res.body as GqlBody).errors ?? [];
    expect(error?.extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    expect(error?.message).toBe('Query depth 4 exceeds the limit of 3');
  });

  it('lets a document at the limits through', async () => {
    const res = await post('{ publicSettings { key } }').expect(200);

    expect((res.body as GqlBody).errors).toBeUndefined();
  });
});

describe('GraphQL document limits with the defaults (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets the standard introspection query through', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/graphql')
      .send({ query: getIntrospectionQuery() })
      .expect(200);

    expect((res.body as GqlBody).errors).toBeUndefined();
  });
});
