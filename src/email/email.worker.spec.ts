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
  const worker = new EmailWorker(config, { send }, logger as unknown as PinoLogger);
  const job = (attemptsMade = 0, attempts = 8) => ({
    id: 'job-1',
    data: { template: 'staffInvitation' as const, to, data: { link } },
    attemptsMade,
    opts: { attempts },
  });
  return { worker, send, logger, job, config };
};

describe('EmailWorker.process', () => {
  it('renders the template and sends it with sender and idempotency key', async () => {
    const { worker, send, logger, job, config } = setup();
    await worker.process(job());
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
    const { worker, logger, job } = setup(() => Promise.reject(err));
    await expect(worker.process(job(1))).rejects.toBe(err);
    expect(logger.warn).toHaveBeenCalledWith(
      { err, jobId: 'job-1', template: 'staffInvitation', attempt: 2 },
      'email send failed',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(to);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SECRET123');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an error once the attempts are used up', async () => {
    const { worker, logger, job } = setup(() =>
      Promise.reject(new EmailTransportError('smtp', true)),
    );
    await expect(worker.process(job(7, 8))).rejects.toBeInstanceOf(EmailTransportError);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('turns a non-retryable error into UnrecoverableError', async () => {
    const { worker, logger, job } = setup(() =>
      Promise.reject(new EmailTransportError('resend', false, 422)),
    );
    await expect(worker.process(job())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('treats an unknown error as retryable', async () => {
    const err = new Error('render bug');
    const { worker, job } = setup(() => Promise.reject(err));
    await expect(worker.process(job())).rejects.toBe(err);
  });
});
