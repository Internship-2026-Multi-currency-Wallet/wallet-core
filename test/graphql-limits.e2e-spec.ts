import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { getIntrospectionQuery } from 'graphql';
import { type Client, createClient } from 'graphql-ws';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import WebSocket from 'ws';
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

  // `{ a0: __typename ... }` with n aliased fields has 3n + 2 tokens.
  const aliases = (n: number): string =>
    Array.from({ length: n }, (_, i) => `a${i}: __typename`).join(' ');

  beforeAll(async () => {
    app = await createApp({ GRAPHQL_MAX_TOKENS: '30', GRAPHQL_MAX_DEPTH: '3' });
    await app.listen(0);
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

  it('lets a document of exactly the token limit and the depth limit through', async () => {
    const atTokens = await post(`{ ${aliases(9)} __typename }`).expect(200);
    const overTokens = await post(`{ ${aliases(9)} __typename __typename }`).expect(400);
    const atDepth = await post('{ __schema { types { name } } }').expect(200);

    expect((atTokens.body as GqlBody).errors).toBeUndefined();
    expect((overTokens.body as GqlBody).errors?.[0]?.extensions.code).toBe('GRAPHQL_PARSE_FAILED');
    expect((atDepth.body as GqlBody).errors).toBeUndefined();
  });

  it('refuses a body over 100 kb with 413 before GraphQL', async () => {
    await post(`{ __typename } #${'x'.repeat(110_000)}`).expect(413);
  });

  describe('over the websocket', () => {
    let client: Client;

    beforeEach(() => {
      const { port } = (app.getHttpServer() as { address(): AddressInfo }).address();
      client = createClient({
        url: `ws://localhost:${port}/graphql`,
        webSocketImpl: WebSocket,
        retryAttempts: 0,
      });
    });

    afterEach(async () => {
      await client.dispose();
    });

    const run = (query: string): Promise<unknown> =>
      new Promise((resolve) => {
        let result: unknown;
        client.subscribe(
          { query },
          { next: (value) => (result = value), error: resolve, complete: () => resolve(result) },
        );
      });

    const codeOf = (errors: unknown): unknown =>
      (errors as { extensions?: { code?: unknown } }[])[0]?.extensions?.code;

    it('refuses a document over the token limit with GRAPHQL_PARSE_FAILED', async () => {
      const errors = await run(`{ ${aliases(9)} __typename __typename }`);

      expect(codeOf(errors)).toBe('GRAPHQL_PARSE_FAILED');
      // The operation fails, not the connection.
      expect((await run('{ __typename }')) as GqlBody).toEqual({ data: { __typename: 'Query' } });
    });

    it('refuses a document deeper than the limit with GRAPHQL_VALIDATION_FAILED', async () => {
      const errors = await run('{ __schema { types { fields { name } } } }');

      expect(codeOf(errors)).toBe('GRAPHQL_VALIDATION_FAILED');
      expect((errors as { message: string }[])[0]?.message).toBe(
        'Query depth 4 exceeds the limit of 3',
      );
    });

    it('closes the connection on a message over 100 kb', async () => {
      const closed = (await run(`{ __typename } #${'x'.repeat(110_000)}`)) as { code?: number };

      expect(closed.code).toBe(1009);
    });
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
