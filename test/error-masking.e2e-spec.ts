import type { AddressInfo } from 'node:net';
import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { createClient, type FormattedExecutionResult } from 'graphql-ws';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import WebSocket from 'ws';
import { ClientSettingsService } from '../src/settings/client-settings.service.js';
import { createApp } from './create-app.js';

/** What graphql-ws delivers for one operation. */
type WsResult = FormattedExecutionResult<Record<string, unknown>, unknown>;

/**
 * An unexpected resolver error reaches the client masked, over HTTP and over the websocket.
 * `publicSettings` is made to fail with a database-like error that carries personal data.
 */
describe('error masking (e2e)', () => {
  const QUERY = '{ publicSettings { key } }';
  const LEAK = "select ... - Duplicate entry 'artem@test.com' for key 'users.users_email_unique'";
  const MASKED = {
    message: 'Internal server error',
    path: ['publicSettings'],
    extensions: { code: 'INTERNAL_SERVER_ERROR' },
  };
  let app: INestApplication;
  let wsUrl: string;

  beforeAll(async () => {
    app = await createApp();
    await app.listen(0);
    const { port } = (app.getHttpServer() as { address(): AddressInfo }).address();
    wsUrl = `ws://localhost:${port}/graphql`;
  });

  beforeEach(() => {
    jest.spyOn(app.get(ClientSettingsService), 'getAll').mockRejectedValue(new Error(LEAK));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
  });

  it('over HTTP', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/graphql')
      .send({ query: QUERY });

    expect(res.body).toMatchObject({ data: null, errors: [MASKED] });
    expect(JSON.stringify(res.body)).not.toContain('artem@test.com');
  });

  it('over the websocket', async () => {
    const client = createClient({ url: wsUrl, webSocketImpl: WebSocket, retryAttempts: 0 });
    const result = await new Promise<WsResult>((resolve, reject) => {
      let received: WsResult = {};
      client.subscribe(
        { query: QUERY },
        {
          next: (value) => (received = value),
          error: reject,
          complete: () => resolve(received),
        },
      );
    }).finally(() => client.dispose());

    expect(result).toMatchObject({ data: null, errors: [MASKED] });
    expect(JSON.stringify(result)).not.toContain('artem@test.com');
  });
});
