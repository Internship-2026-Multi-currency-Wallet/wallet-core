import { describe, expect, it, jest } from '@jest/globals';
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
