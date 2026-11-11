import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/app-config.js';
import { EmailService } from '../src/email/email.service.js';
import { EmailWorker } from '../src/email/email.worker.js';
import { FakeEmailService } from '../src/email/fake-email.service.js';
import { EmailEnqueueError, QueuedEmailService } from '../src/email/queued-email.service.js';
import {
  EMAIL_TRANSPORT_CLIENT,
  EmailTransportError,
  type EmailMessage,
} from '../src/email/transports/email-transport.js';
import { createApp } from './create-app.js';

const config = AppConfig.fromEnv({ ...process.env, EMAIL_TRANSPORT: 'smtp', APP_ENV: 'staging' });
const prefix = config.appEnv;
const to = 'jane@example.com';
const link = 'https://app.example/accept?token=SECRET123';

const waitFor = async (check: () => boolean | Promise<boolean>, ms: number): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe('email delivery (e2e)', () => {
  let app: INestApplication;
  let inspect: Queue;
  let redis: Redis;
  let behavior: (msg: EmailMessage, call: number) => Promise<void>;
  const calls: EmailMessage[] = [];

  const clean = () => inspect.obliterate({ force: true });

  beforeAll(async () => {
    inspect = new Queue('email', { prefix, connection: { url: config.redisUrl } });
    redis = new Redis(config.redisUrl);
    await clean();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppConfig)
      .useValue(config)
      .overrideProvider(EMAIL_TRANSPORT_CLIENT)
      .useValue({
        send: (msg: EmailMessage) => {
          calls.push(msg);
          return behavior(msg, calls.length);
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await clean();
    await inspect.close();
    redis.disconnect();
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it('delivers a queued email through the transport with the idempotency key', async () => {
    behavior = () => Promise.resolve();
    await app.get(EmailService).send('staffInvitation', to, { link });
    await waitFor(() => calls.length === 1, 5000);
    expect(calls[0]).toMatchObject({
      to,
      from: { name: 'Demo Wallet', address: config.email.from },
    });
    expect(calls[0].idempotencyKey).toMatch(new RegExp(`^${prefix}/[0-9a-f-]{36}$`));
    expect(calls[0].text).toContain(link);
  });

  it('stores queue keys under <APP_ENV>:email:', async () => {
    behavior = () => Promise.resolve();
    await app.get(EmailService).send('passwordChanged', to, {});
    await waitFor(() => calls.length === 1, 5000);
    const keys = await redis.keys(`${prefix}:email:*`);
    expect(keys.length).toBeGreaterThan(0);
    expect(await redis.keys('bull:email:*')).toEqual([]);
  });

  it('calls the transport once and fails the job on a permanent error', async () => {
    behavior = () => Promise.reject(new EmailTransportError('resend', false, 422));
    await app.get(EmailService).send('passwordChanged', to, {});
    await waitFor(async () => (await inspect.getFailedCount()) === 1, 5000);
    await new Promise((r) => setTimeout(r, 500));
    expect(calls).toHaveLength(1);
    await clean();
  });

  it('delivers exactly once after a retryable failure on attempt 1', async () => {
    behavior = (_msg, call) =>
      call === 1 ? Promise.reject(new EmailTransportError('smtp', true)) : Promise.resolve();
    await app.get(EmailService).send('passwordChanged', to, {});
    await waitFor(() => calls.length === 2, 12000);
    await new Promise((r) => setTimeout(r, 500));
    expect(calls).toHaveLength(2);
    expect(calls[1].idempotencyKey).toBe(calls[0].idempotencyKey);
  }, 20000);
});

describe('email enqueue with Redis unreachable (e2e)', () => {
  it('rejects within about 5 s and reports a safe reason through the logger', async () => {
    const logger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn() };
    const service = new QueuedEmailService(
      AppConfig.fromEnv({
        ...process.env,
        EMAIL_TRANSPORT: 'smtp',
        REDIS_URL: 'redis://localhost:1',
      }),
      logger as never,
    );
    const started = Date.now();
    await expect(service.send('passwordChanged', to, {})).rejects.toBeInstanceOf(EmailEnqueueError);
    expect(Date.now() - started).toBeLessThan(6000);
    await waitFor(() => logger.warn.mock.calls.length > 0, 3000);
    expect(logger.warn).toHaveBeenCalledWith(
      { connection: 'command', reason: 'ECONNREFUSED' },
      expect.any(String),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('localhost');
    await service.onApplicationShutdown();
  }, 10000);
});

describe('email with EMAIL_TRANSPORT=fake (e2e)', () => {
  it('binds the fake, builds no BullMQ worker and never needs the transport', async () => {
    const app = await createApp({ EMAIL_TRANSPORT: 'fake' });
    try {
      expect(app.get(EmailService)).toBeInstanceOf(FakeEmailService);
      expect(app.get(EmailService)).not.toBeInstanceOf(QueuedEmailService);
      expect(app.get<{ worker?: unknown }>(EmailWorker).worker).toBeUndefined();
      expect(app.get(EMAIL_TRANSPORT_CLIENT)).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
