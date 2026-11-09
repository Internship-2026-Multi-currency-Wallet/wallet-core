import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { EmailService, type EmailTemplate, type EmailTemplates } from './email.service.js';

/** Records emails instead of delivering them. */
@Injectable()
export class FakeEmailService extends EmailService {
  readonly sent: Array<{
    template: EmailTemplate;
    to: string;
    data: EmailTemplates[EmailTemplate];
  }> = [];

  constructor(
    private readonly config: AppConfig,
    @InjectPinoLogger(FakeEmailService.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  send<T extends EmailTemplate>(template: T, to: string, data: EmailTemplates[T]): Promise<void> {
    this.sent.push({ template, to, data });
    // The link holds a one-time token, so it is logged only where developers need it to click through.
    const link = this.config.appEnv === 'local' && 'link' in data ? { link: data.link } : {};
    this.logger.info({ template, ...link }, 'email recorded, not sent');
    return Promise.resolve();
  }
}
