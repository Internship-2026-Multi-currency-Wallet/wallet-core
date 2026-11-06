import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import type { EmailMessage, EmailSender } from './email-sender.js';

/** Stand-in until a real provider exists: nothing is delivered. */
@Injectable()
export class LoggingEmailSender implements EmailSender {
  constructor(
    private readonly config: AppConfig,
    // Not `@InjectPinoLogger`: its provider only exists if this file loads before LoggingModule.
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(LoggingEmailSender.name);
  }

  send({ template, data }: EmailMessage): Promise<void> {
    // The link holds a one-time token, so it is logged only where developers need it to click through.
    const link = this.config.appEnv === 'local' ? { link: data.link } : {};
    this.logger.info({ template, ...link }, 'email sent');
    return Promise.resolve();
  }
}
