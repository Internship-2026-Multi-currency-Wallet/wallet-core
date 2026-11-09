import { describe, expect, it, jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import type { AppConfig } from '../config/app-config.js';
import { FakeEmailService } from './fake-email.service.js';

const make = (appEnv = 'local') => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), setContext: jest.fn() };
  const service = new FakeEmailService(
    { appEnv } as unknown as AppConfig,
    logger as unknown as PinoLogger,
  );
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

  it('has no effect other than recording', async () => {
    const { service } = make();
    await service.send('passwordReset', to, { link });
    await service.send('passwordReset', to, { link });
    await service.send('passwordChanged', to, {});
    expect(service.sent).toHaveLength(3);
  });

  it('logs the link in local, never the recipient', async () => {
    const { service, logger } = make('local');
    await service.send('staffInvitation', to, { link });
    expect(logger.info).toHaveBeenCalledWith(
      { template: 'staffInvitation', link },
      'email recorded, not sent',
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(to);
  });

  it.each(['staging', 'kvitka-uat', 'wisla-uat'])('logs only the template in %s', async (env) => {
    const { service, logger } = make(env);
    await service.send('staffInvitation', to, { link });
    expect(logger.info).toHaveBeenCalledWith(
      { template: 'staffInvitation' },
      'email recorded, not sent',
    );
    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).not.toContain('SECRET123');
    expect(logged).not.toContain(to);
  });

  it('logs only the template for passwordChanged, even locally', async () => {
    const { service, logger } = make('local');
    await service.send('passwordChanged', to, {});
    expect(logger.info).toHaveBeenCalledWith(
      { template: 'passwordChanged' },
      'email recorded, not sent',
    );
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
