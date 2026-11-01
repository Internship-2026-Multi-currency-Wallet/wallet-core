import type { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { EventMeta, SystemPingEvent } from '../src/events/catalog.js';
import { EventSubscriber } from '../src/events/event-bus.js';
import { createApp } from './create-app.js';

describe('request id and diagnostics (e2e)', () => {
  const prefix = 'e2e-logging';
  let app: INestApplication;
  let subscriber: EventSubscriber;

  beforeAll(async () => {
    app = await createApp({ DEV_AUTH: 'true', APP_ENV: 'local' });
    subscriber = new EventSubscriber(
      new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379'),
      'local',
    );
  });

  afterAll(async () => {
    await subscriber.close();
    await app.close();
  });

  it('echoes an incoming x-request-id and generates one otherwise', async () => {
    const server = app.getHttpServer() as App;
    const own = await request(server).get('/health').set('x-request-id', `${prefix}-1`);
    expect(own.headers['x-request-id']).toBe(`${prefix}-1`);
    const generated = await request(server).get('/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('POST /diagnostics/ping needs authentication', async () => {
    await request(app.getHttpServer() as App)
      .post('/diagnostics/ping')
      .expect(401);
  });

  it('POST /diagnostics/ping publishes system.ping with the requestId in the event meta', async () => {
    const received = new Promise<[SystemPingEvent, EventMeta]>((resolve) => {
      void subscriber.subscribe('system.ping', (ping, meta) => {
        if (meta.requestId === `${prefix}-2`) resolve([ping, meta]);
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await request(app.getHttpServer() as App)
      .post('/diagnostics/ping')
      .set('Authorization', 'Dev 1:wallet')
      .set('x-request-id', `${prefix}-2`)
      .expect(200, { published: true });
    const [ping, meta] = await received;
    expect(ping.v).toBe(1);
    expect(meta).toMatchObject({ requestId: `${prefix}-2`, publisher: ping.from });
  });
});
