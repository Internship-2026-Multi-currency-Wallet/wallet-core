import { describe, expect, it, jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { EmailEnqueueError, QueuedEmailService } from './queued-email.service.js';

type AddCall = [string, unknown, Record<string, unknown>];

const setup = (add: () => Promise<unknown>) => {
  const logger = { warn: jest.fn() } as unknown as PinoLogger;
  const config = AppConfig.fromEnv({
    ...process.env,
    REDIS_URL: 'redis://localhost:1',
    EMAIL_TRANSPORT: 'smtp',
  });
  const service = new QueuedEmailService(config, logger);
  const addMock = jest.fn(add);
  (service as unknown as { queue: { add: unknown } }).queue.add = addMock;
  return { service, addMock };
};

describe('QueuedEmailService', () => {
  it('adds one job per send with payload, retry and removal options and a fresh id', async () => {
    const { service, addMock } = setup(() => Promise.resolve({}));
    const data = { link: 'https://x.test/a' };
    await service.send('staffInvitation', 'a@example.com', data);
    await service.send('staffInvitation', 'a@example.com', data);
    expect(addMock).toHaveBeenCalledTimes(2);
    const [first, second] = addMock.mock.calls as unknown as AddCall[];
    expect(first[1]).toEqual({ template: 'staffInvitation', to: 'a@example.com', data });
    expect(first[2]).toMatchObject({
      attempts: 8,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
    });
    expect(first[2].jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second[2].jobId).not.toBe(first[2].jobId);
    await service.onApplicationShutdown();
  });

  it('rejects with EmailEnqueueError when add does not settle within 5 s', async () => {
    jest.useFakeTimers();
    const { service } = setup(() => new Promise(() => undefined));
    const assertion = expect(
      service.send('passwordChanged', 'a@example.com', {}),
    ).rejects.toBeInstanceOf(EmailEnqueueError);
    await jest.advanceTimersByTimeAsync(5000);
    await assertion;
    jest.useRealTimers();
    await service.onApplicationShutdown();
  });

  it('rejects with EmailEnqueueError when add fails', async () => {
    const { service } = setup(() => Promise.reject(new Error('boom')));
    await expect(service.send('passwordChanged', 'a@example.com', {})).rejects.toBeInstanceOf(
      EmailEnqueueError,
    );
    await service.onApplicationShutdown();
  });
});
