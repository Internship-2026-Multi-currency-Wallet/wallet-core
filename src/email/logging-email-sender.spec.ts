import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import type { AppConfig } from '../config/app-config.js';
import { EmailTemplate } from './email-sender.js';
import { LoggingEmailSender } from './logging-email-sender.js';

const LINK = 'http://localhost:5174/accept-invitation?token=secret-token-value';
const MESSAGE = {
  template: EmailTemplate.StaffInvitation,
  to: 'new@test.com',
  data: { link: LINK },
};

function setup(appEnv: string) {
  const logger = { info: jest.fn(), setContext: jest.fn() };
  const sender = new LoggingEmailSender(
    { appEnv } as unknown as AppConfig,
    logger as unknown as PinoLogger,
  );
  return { sender, logger };
}

describe('LoggingEmailSender', () => {
  it('logs the link with the template in the local environment', async () => {
    const { sender, logger } = setup('local');
    await sender.send(MESSAGE);

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { template: 'staffInvitation', link: LINK },
      'email sent',
    );
  });

  it.each(['staging', 'kvitka-uat', 'wisla-uat'])(
    'logs only the template, never the link, token or recipient, in %s',
    async (appEnv) => {
      const { sender, logger } = setup(appEnv);
      await sender.send(MESSAGE);

      expect(logger.info).toHaveBeenCalledWith({ template: 'staffInvitation' }, 'email sent');
      const logged = JSON.stringify(logger.info.mock.calls);
      expect(logged).not.toContain('secret-token-value');
      expect(logged).not.toContain('new@test.com');
    },
  );

  it('does not log the recipient locally either', async () => {
    const { sender, logger } = setup('local');
    await sender.send(MESSAGE);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('new@test.com');
  });
});
