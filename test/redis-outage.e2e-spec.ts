import { randomInt } from 'node:crypto';
import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { getLoggerToken, type PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/app-config.js';
import { configureApp } from '../src/configure-app.js';
import { DiagnosticsModule } from '../src/diagnostics/diagnostics.module.js';
import { EmailService } from '../src/email/email.service.js';
import { EmailEnqueueError, QueuedEmailService } from '../src/email/queued-email.service.js';
import {
  EMAIL_TRANSPORT_CLIENT,
  type EmailMessage,
} from '../src/email/transports/email-transport.js';
import type { ConversionCompletedEvent } from '../src/events/catalog.js';
import {
  decodeStreamEntry,
  eventChannel,
  EventPublisher,
  eventStream,
  redisName,
} from '../src/events/event-bus.js';
import { Metrics } from '../src/metrics/metrics.js';
import { closeRedis, watchRedisConnection } from '../src/redis/redis-connection.js';
import { createRedis } from '../src/redis/redis.module.js';
import { RedisProxy } from './redis-proxy.js';

const sharedRedisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const start = Date.now();
  const result = await fn();
  return [result, Date.now() - start];
};
const randomIp = (): string => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;

/** Runs every cleanup step even if an earlier one fails, then reports the first failure. */
async function cleanUp(...steps: (() => unknown)[]): Promise<void> {
  let failure: Error | undefined;
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      failure ??= err instanceof Error ? err : new Error(String(err));
    }
  }
  if (failure) throw failure;
}

/** Deletes only keys under the run's own prefix. */
async function deleteRunKeys(redis: Redis, run: string): Promise<void> {
  for await (const keys of redis.scanStream({ match: `${run}:*`, count: 200 })) {
    if ((keys as string[]).length > 0) await redis.del(...(keys as string[]));
  }
}

/**
 * Boots the real AppModule with non-fake email (BullMQ Queue and Worker) and a recording transport.
 * `appEnv` is replaced by a per-run value, so every channel, stream, queue and throttle key of the
 * run is unique (`<run>:...`) and can be cleaned up without touching anything else.
 */
async function bootApp(
  run: string,
  redisUrl: string,
  transport: { send: (msg: EmailMessage) => Promise<void> },
): Promise<INestApplication> {
  const config = AppConfig.fromEnv({
    ...process.env,
    REDIS_URL: redisUrl,
    EMAIL_TRANSPORT: 'smtp',
    THROTTLE_LIMIT_ANONYMOUS: '3',
    THROTTLE_TTL_SECONDS: '60',
  });
  Object.defineProperty(config, 'appEnv', { value: run });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AppConfig)
    .useValue(config)
    .overrideProvider(EMAIL_TRANSPORT_CLIENT)
    .useValue(transport)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: ['error', 'warn'],
  });
  try {
    configureApp(app);
    await app.init();
  } catch (error) {
    // Providers that did start (Redis clients, the BullMQ worker) would keep reconnecting.
    await app.close().catch(() => undefined);
    throw error;
  }
  return app;
}

/**
 * Real MySQL and real Redis; the app reaches Redis only through a local TCP proxy that the test
 * stops and starts on the same port. The shared Redis is never stopped or flushed.
 */
describe('Redis outage (e2e, real Redis behind a controllable proxy)', () => {
  const run = `e2e-outage-${process.pid}-${Date.now()}`;
  let proxy: RedisProxy;
  let app: INestApplication;
  let direct: Redis;
  let observer: Redis;
  let probes: EventPublisher;
  let inspect: Queue;
  let received: { mock: { calls: unknown[][] } };
  let consoleError: jest.Spied<typeof console.error>;
  const delivered: EmailMessage[] = [];
  const pings: string[] = [];
  let seq = 0;

  const server = () => app.getHttpServer() as App;
  const ping = (requestId: string) =>
    request(server())
      .post('/diagnostics/ping')
      .set('Authorization', 'Dev 1:wallet')
      .set('x-request-id', requestId);
  const anonymous = (ip: string) =>
    request(server())
      .post('/graphql')
      .set('X-Forwarded-For', ip)
      .send({ query: '{ health { service } }' });
  const throttled = (res: request.Response) =>
    (res.body as { errors?: { extensions: { code: string } }[] }).errors?.[0]?.extensions.code ===
    'TOO_MANY_REQUESTS';
  const deliveries = (from: string) =>
    received.mock.calls.filter(
      ([fields]) => (fields as { from?: string } | undefined)?.from === from,
    ).length;
  const publishedPings = async (): Promise<number> => {
    const metric = app.get(Metrics).registry.getSingleMetric('events_published_total');
    const values = (await metric?.get())?.values ?? [];
    return values.find((v) => v.labels.type === 'system.ping')?.value ?? 0;
  };
  const sentTo = (to: string) => delivered.filter((msg) => msg.to === to).length;

  async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 20_000) {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(200);
    }
  }

  const waitForHealth = (redis: 'UP' | 'DOWN') =>
    waitFor(
      async () => (await request(server()).get('/health')).body.redis === redis,
      `redis=${redis}`,
    );

  /** Publishes system.ping (directly to the shared Redis) until the app's handler logs one. */
  async function waitForDelivery(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const from = `${run}-probe-${++seq}`;
      await probes.publish('system.ping', { v: 1, from, ts: new Date().toISOString() });
      await sleep(250);
      if (deliveries(from) > 0) return;
    }
    throw new Error('system.ping was not delivered after Redis came back');
  }

  /** One ping must be handled exactly once (no duplicated handlers after reconnects). */
  async function expectExactlyOnce(): Promise<void> {
    const from = `${run}-once-${++seq}`;
    await probes.publish('system.ping', { v: 1, from, ts: new Date().toISOString() });
    await sleep(500);
    expect(deliveries(from)).toBe(1);
  }

  /** Recovered: health ok, ping 200 and counted, XADD written, email delivered, limits apply. */
  async function expectRecovered(): Promise<void> {
    await waitForHealth('UP');
    await waitForDelivery();
    await expectExactlyOnce();
    expect((await request(server()).get('/health').expect(200)).body).toMatchObject({
      status: 'ok',
      db: 'UP',
      redis: 'UP',
    });

    const before = await publishedPings();
    await ping(`${run}-ok-${++seq}`).expect(200, { published: true });
    expect(await publishedPings()).toBe(before + 1);

    const event: ConversionCompletedEvent = {
      v: 1,
      eventId: `${run}-${++seq}`,
      conversionId: 'c1',
      client: 'demo',
      userId: '1',
      from: { currency: 'USD', amount: '10000' },
      to: { currency: 'UAH', amount: '415000' },
      rate: '41.5',
      midRate: '41.6',
      occurredAt: new Date().toISOString(),
    };
    const id = await app.get(EventPublisher).publish('conversion.completed', event);
    const entries = await direct.xrange(eventStream(run, 'conversion.completed'), id!, id!);
    expect(decodeStreamEntry('conversion.completed', entries[0][1])).toEqual(event);

    const to = `${run}-${++seq}@example.com`;
    await app.get(EmailService).send('passwordChanged', to, {});
    await waitFor(() => sentTo(to) === 1, 'email delivery');

    // Fail-open may pause the limiter for its cooldown after an error; then it limits again.
    await waitFor(async () => {
      const ip = randomIp();
      for (let i = 0; i < 3; i++) await anonymous(ip);
      return throttled(await anonymous(ip));
    }, 'rate limiting to resume');
  }

  beforeAll(async () => {
    consoleError = jest.spyOn(console, 'error');
    proxy = await RedisProxy.reserve(sharedRedisUrl); // reserved, NOT listening: Redis is "down"
    direct = new Redis(sharedRedisUrl);
    probes = new EventPublisher(direct, run);
    inspect = new Queue('email', { prefix: run, connection: { url: sharedRedisUrl } });
    observer = new Redis(sharedRedisUrl);
    await observer.subscribe(eventChannel(run, 'system.ping'));
    observer.on('message', (_channel: string, message: string) => pings.push(message));
  });

  afterAll(() =>
    cleanUp(
      () => app?.close(),
      () => proxy?.stop(),
      () => inspect?.close(),
      () => direct && deleteRunKeys(direct, run),
      () => observer && closeRedis(observer),
      () => direct && closeRedis(direct),
      () => consoleError?.mockRestore(),
    ),
  );

  it('starts with non-fake email while Redis is unreachable', async () => {
    const [created, ms] = await timed(() =>
      bootApp(run, proxy.url, {
        send: (msg) => {
          delivered.push(msg);
          return Promise.resolve();
        },
      }),
    );
    app = created;
    expect(ms).toBeLessThan(10_000);
    expect(app.get(EmailService)).toBeInstanceOf(QueuedEmailService);
    await app.listen(0, '127.0.0.1');
    received = jest.spyOn(app.get<PinoLogger>(getLoggerToken(DiagnosticsModule.name)), 'info');
  });

  it('GET /health answers 200 degraded (db UP, redis DOWN) within a bounded time', async () => {
    const [res, ms] = await timed(() => request(server()).get('/health'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'degraded', db: 'UP', redis: 'DOWN' });
    expect(ms).toBeLessThan(3000);
  });

  it('POST /diagnostics/ping answers 503 at once and is not counted', async () => {
    const before = await publishedPings();
    const [res, ms] = await timed(() => ping(`${run}-offline-cold`));
    expect(res.status).toBe(503);
    expect(ms).toBeLessThan(3000);
    expect(await publishedPings()).toBe(before);
  });

  it('lets requests through without a limit while Redis is unreachable', async () => {
    const ip = randomIp();
    for (let i = 0; i < 6; i++) expect(throttled(await anonymous(ip))).toBe(false);
  });

  it('rejects an email enqueue within about 5 s', async () => {
    // The add may still land once Redis is back (documented), so its delivery is not asserted here.
    const [result, ms] = await timed(() =>
      app
        .get(EmailService)
        .send('passwordChanged', `${run}-timeout@example.com`, {})
        .catch((err: unknown) => err),
    );
    expect(result).toBeInstanceOf(EmailEnqueueError);
    expect(ms).toBeLessThan(6500);
  });

  it('recovers everything when Redis appears at the same endpoint (cold start)', async () => {
    await proxy.start();
    await expectRecovered();
    expect(sentTo(`${run}-timeout@example.com`)).toBeLessThanOrEqual(1);
  }, 60_000);

  it('recovers after repeated outages without duplicated handlers and resumes queued email', async () => {
    for (let outage = 1; outage <= 2; outage++) {
      await proxy.stop();
      await waitForHealth('DOWN');
      const [res, ms] = await timed(() => request(server()).get('/health'));
      expect(res.status).toBe(200);
      expect(ms).toBeLessThan(3000);
      const offline = await ping(`${run}-offline-${outage}`);
      expect(offline.status).toBe(503);

      // Work queued while the app cannot reach Redis is processed after recovery.
      const to = `${run}-queued-${outage}@example.com`;
      await inspect.add('send', { template: 'passwordChanged', to, data: {} });

      await proxy.start();
      await expectRecovered();
      await waitFor(() => sentTo(to) === 1, 'queued email after recovery');
    }
  }, 120_000);

  it('never sent the publications that were rejected while Redis was down', async () => {
    await sleep(300);
    const requestIds = pings.map(
      (message) => (JSON.parse(message) as { meta: { requestId?: string } }).meta.requestId,
    );
    expect(requestIds.some((id) => id?.startsWith(`${run}-ok-`))).toBe(true);
    expect(requestIds.filter((id) => id?.startsWith(`${run}-offline`))).toEqual([]);
  });

  it('shuts down within a bounded time while Redis is unreachable', async () => {
    await proxy.stop();
    await waitForHealth('DOWN');
    const [, ms] = await timed(() => app.close());
    expect(ms).toBeLessThan(5000);
    app = undefined as unknown as INestApplication;
  });

  it('never let ioredis print unhandled error events', () => {
    const ioredisErrors = consoleError.mock.calls.filter((args: unknown[]) =>
      String(args[0]).includes('[ioredis]'),
    );
    expect(ioredisErrors).toEqual([]);
  });
});

describe('shutdown right after a start without Redis (e2e)', () => {
  const run = `e2e-outage-early-${process.pid}-${Date.now()}`;

  it('closes within a bounded time while SUBSCRIBE and the BullMQ connections are pending', async () => {
    const proxy = await RedisProxy.reserve(sharedRedisUrl); // never started
    const app = await bootApp(run, proxy.url, { send: () => Promise.resolve() });
    const [, ms] = await timed(() => app.close());
    expect(ms).toBeLessThan(5000);
  });
});

describe('command client during an outage (e2e, real Redis behind a controllable proxy)', () => {
  const channel = redisName('e2e', `late-publish-${process.pid}-${Date.now()}`);
  let proxy: RedisProxy;
  let observer: Redis;
  const delivered: string[] = [];
  const quietLogger = () => ({ warn: jest.fn(), debug: jest.fn(), info: jest.fn() });

  beforeAll(async () => {
    proxy = await RedisProxy.reserve(sharedRedisUrl);
    observer = new Redis(sharedRedisUrl);
    await observer.subscribe(channel);
    observer.on('message', (_channel: string, message: string) => delivered.push(message));
  });

  afterAll(() =>
    cleanUp(
      () => proxy?.stop(),
      () => observer && closeRedis(observer),
    ),
  );

  it('never sends a publish that failed during the outage, and recovers for later commands', async () => {
    const client = createRedis(proxy.url); // the app's command-client options
    client.on('error', () => undefined);
    let reconnects = 0;
    client.on('reconnecting', () => reconnects++);
    try {
      // Past the first maxRetriesPerRequest flush: an offline queue would now keep the
      // command until recovery, long after commandTimeout rejected it.
      while (reconnects < 4) await sleep(20);
      const started = Date.now();
      await expect(client.publish(channel, 'during-outage')).rejects.toThrow(/isn't writeable/);
      expect(Date.now() - started).toBeLessThan(500);

      await proxy.start();
      await new Promise((resolve) => client.once('ready', resolve));
      await sleep(300);
      expect(delivered).toEqual([]);

      await expect(client.publish(channel, 'after-recovery')).resolves.toBe(1);
      await sleep(200);
      expect(delivered).toEqual(['after-recovery']);
    } finally {
      client.disconnect();
    }
  });

  it('does not report QUIT or disconnect() of a ready connection as an outage', async () => {
    await proxy.start();
    const closers = [
      async (c: Redis) => void (await c.quit()),
      (c: Redis) => Promise.resolve(c.disconnect()),
    ];
    for (const close of closers) {
      const client = createRedis(proxy.url);
      const logger = quietLogger();
      watchRedisConnection(client, logger as unknown as PinoLogger, 'command');
      try {
        if (client.status !== 'ready')
          await new Promise((resolve) => client.once('ready', resolve));
        await close(client);
        if (client.status !== 'end') await new Promise((resolve) => client.once('end', resolve));
        await sleep(100);
        expect(logger.warn).not.toHaveBeenCalled();
      } finally {
        client.disconnect(); // no-op once closed; stops reconnects if the test failed early
      }
    }
  });
});
