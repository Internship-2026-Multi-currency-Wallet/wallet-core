import { describe, expect, it, jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { FakeEmailService, MAX_RECORDED_EMAILS } from './fake-email.service.js';

const make = () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), setContext: jest.fn() };
  const service = new FakeEmailService(logger as unknown as PinoLogger);
  return { service, logger };
};

const link = 'https://app.example/accept?token=SECRET123';
const to = 'jane@example.com';

describe('FakeEmailService', () => {
  it('records each email in call order and resolves to undefined', async () => {
    const { service } = make();
    await expect(service.send('staffInvitation', to, { link })).resolves.toBeUndefined();
    await service.send('passwordChanged', 'b@example.com', {});
    expect(service.sent).toEqual([
      { template: 'staffInvitation', to, data: { link } },
      { template: 'passwordChanged', to: 'b@example.com', data: {} },
    ]);
  });

  it('logs only the template, never the link, token or recipient', async () => {
    const { service, logger } = make();
    await service.send('staffInvitation', to, { link });
    expect(logger.info).toHaveBeenCalledWith(
      { template: 'staffInvitation' },
      'email recorded, not sent',
    );
    const logged = JSON.stringify(Object.values(logger).flatMap((fn) => fn.mock.calls));
    expect(logged).not.toContain('SECRET123');
    expect(logged).not.toContain(to);
  });

  it('keeps only the newest MAX_RECORDED_EMAILS entries in call order', async () => {
    const { service } = make();
    const total = MAX_RECORDED_EMAILS + 5;
    for (let i = 1; i <= total; i++) await service.send('passwordChanged', `u${i}@example.com`, {});
    expect(service.sent).toHaveLength(MAX_RECORDED_EMAILS);
    expect(service.sent[0]?.to).toBe('u6@example.com');
    expect(service.sent.at(-1)?.to).toBe(`u${total}@example.com`);
  });

  it('rejects wrong shapes at compile time', async () => {
    const { service } = make();
    // @ts-expect-error wrong data shape
    await service.send('staffInvitation', to, {});
    // @ts-expect-error unknown template
    await service.send('nope', to, {});
    // @ts-expect-error passwordChanged takes no data
    await service.send('passwordChanged', to, { link: 'x' });
  });
});
