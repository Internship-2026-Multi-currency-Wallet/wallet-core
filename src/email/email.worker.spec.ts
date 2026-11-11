import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { UnrecoverableError } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { EmailWorker } from './email.worker.js';
import { renderEmail } from './templates/index.js';
import { brand } from '../brand/brand.js';
import { EmailTransportError, type EmailMessage } from './transports/email-transport.js';

const link = 'https://app.example/accept?token=SECRET123';
const to = 'jane@example.com';

const setup = (sendImpl: (msg: EmailMessage) => Promise<void> = () => Promise.resolve()) => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const send = jest.fn(sendImpl);
  const config = AppConfig.fromEnv({ ...process.env, EMAIL_TRANSPORT: 'fake' });
  // fake config: the constructor builds no BullMQ Worker, so only process() is exercised.
  const transport = { send };
  const worker = new EmailWorker(config, transport, logger as unknown as PinoLogger);
  const job = (attemptsMade = 0, attempts = 8) => ({
    id: 'job-1',
    data: { template: 'staffInvitation' as const, to, data: { link } },
    attemptsMade,
    opts: { attempts },
  });
  return { worker, transport, send, logger, job, config };
};

describe('EmailWorker.process', () => {
  it('renders the template and sends it with sender and idempotency key', async () => {
    const { worker, transport, send, logger, job, config } = setup();
    await worker.process(job(), transport);
    const rendered = renderEmail('staffInvitation', { link }, brand);
    expect(send).toHaveBeenCalledWith({
      from: { name: 'Demo Wallet', address: config.email.from },
      to,
      ...rendered,
      idempotencyKey: `${config.appEnv}/job-1`,
    });
    expect(logger.info).toHaveBeenCalledWith(
      { jobId: 'job-1', template: 'staffInvitation', attempt: 1 },
      'email sent',
    );
  });

  it('rethrows a retryable error and warns without recipient or link', async () => {
    const err = new EmailTransportError('smtp', true);
    const { worker, transport, logger, job } = setup(() => Promise.reject(err));
    await expect(worker.process(job(1), transport)).rejects.toBe(err);
    expect(logger.warn).toHaveBeenCalledWith(
      { err, jobId: 'job-1', template: 'staffInvitation', attempt: 2 },
      'email send failed',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(to);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SECRET123');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an error once the attempts are used up', async () => {
    const { worker, transport, logger, job } = setup(() =>
      Promise.reject(new EmailTransportError('smtp', true)),
    );
    await expect(worker.process(job(7, 8), transport)).rejects.toBeInstanceOf(EmailTransportError);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('turns a non-retryable error into UnrecoverableError', async () => {
    const { worker, transport, logger, job } = setup(() =>
      Promise.reject(new EmailTransportError('resend', false, 422)),
    );
    await expect(worker.process(job(), transport)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('treats an unknown error as retryable', async () => {
    const err = new Error('render bug');
    const { worker, transport, job } = setup(() => Promise.reject(err));
    await expect(worker.process(job(), transport)).rejects.toBe(err);
  });
});

describe('EmailWorker unknown template', () => {
  it('fails the job at once without sending and logs neither recipient nor data', async () => {
    const { worker, transport, send, logger, job } = setup();
    const bad = { ...job(), data: { template: 'nope', to, data: { link } } };
    await expect(worker.process(bad as never, transport)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(send).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      { jobId: 'job-1', template: 'nope' },
      'email job has an unknown template',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(to);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('SECRET123');
  });
});

describe('EmailWorker constructor', () => {
  it('throws when a real transport is configured but none is injected', () => {
    const config = AppConfig.fromEnv({ ...process.env, EMAIL_TRANSPORT: 'smtp' });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    expect(() => new EmailWorker(config, undefined, logger as unknown as PinoLogger)).toThrow(
      /transport/i,
    );
  });
});

describe('EmailWorker with Redis unavailable', () => {
  type BullWorker = {
    emit: (event: string, ...args: unknown[]) => boolean;
    getBackend: () => { emit: (event: string) => boolean };
    pause: (doNotWaitActive?: boolean) => Promise<void>;
    close: (force?: boolean) => Promise<void>;
  };

  // A real BullMQ Worker pointed at a closed port; it never reaches Redis.
  const setupReal = () => {
    const config = AppConfig.fromEnv({
      ...process.env,
      EMAIL_TRANSPORT: 'smtp',
      REDIS_URL: 'redis://127.0.0.1:1',
    });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const worker = new EmailWorker(
      config,
      { send: () => Promise.resolve() },
      logger as unknown as PinoLogger,
    );
    const bull = (worker as unknown as { worker: BullWorker }).worker;
    return { worker, bull, logger };
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('warns once per outage with a safe reason, reports recovery, and is quiet once closed', async () => {
    const { bull, logger } = setupReal();
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:6379'), {
      code: 'ECONNREFUSED',
    });
    try {
      bull.emit('error', refused);
      bull.emit('error', refused);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith({ reason: 'ECONNREFUSED' }, expect.any(String));
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('10.1.2.3');

      bull.getBackend().emit('ready');
      expect(logger.info).toHaveBeenCalledTimes(1);
      bull.emit('error', refused);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    } finally {
      await bull.close(true);
    }
    bull.emit('error', new Error('Connection is closed.'));
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  // A real worker whose connections are already dropped; pause() and close() are observed.
  const setupClosed = async () => {
    const setup = setupReal();
    await setup.bull.close(true);
    const pause = jest.spyOn(setup.bull, 'pause').mockResolvedValue(undefined);
    const close = jest.spyOn(setup.bull, 'close').mockResolvedValue(undefined);
    return { ...setup, pause, close };
  };

  it('stops fetching without waiting and closes with force at once when no job is active', async () => {
    const { worker, pause, close } = await setupClosed();
    await worker.onApplicationShutdown();
    // pause() without `true` would reconnect the blocking client after close().
    expect(pause).toHaveBeenCalledWith(true);
    expect(close).toHaveBeenCalledWith(true);
  });

  it('waits for jobs from acquisition (BullMQ "active") until recorded as completed or failed', async () => {
    const { worker, bull, close } = await setupClosed();
    jest.useFakeTimers();
    // Acquired, but the processor has not started yet: shutdown must still wait for them.
    bull.emit('active', { id: '1' }, 'waiting');
    bull.emit('active', { id: '2' }, 'waiting');
    const shutdown = worker.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(500);
    bull.emit('completed', { id: '1' });
    await jest.advanceTimersByTimeAsync(0);
    expect(close).not.toHaveBeenCalled();
    bull.emit('failed', { id: '2' }, new Error('smtp down'));
    await shutdown;
    expect(close).toHaveBeenCalledWith(true);
  });

  it('closes with force after the grace period when a send is still running', async () => {
    const { worker, bull, close } = await setupClosed();
    jest.useFakeTimers();
    bull.emit('active', { id: '1' }, 'waiting');
    let done = false;
    const shutdown = worker.onApplicationShutdown().then(() => (done = true));
    await jest.advanceTimersByTimeAsync(2999);
    expect(done).toBe(false);
    expect(close).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await shutdown;
    expect(close).toHaveBeenCalledWith(true);
  });

  it('real BullMQ: shuts down at once when Redis was never reachable', async () => {
    const { worker } = setupReal();
    worker.onApplicationBootstrap();
    const started = Date.now();
    await worker.onApplicationShutdown();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
