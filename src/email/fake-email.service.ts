import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { EmailService, type EmailTemplate, type EmailTemplates } from './email.service.js';

export type SentEmail = {
  [K in EmailTemplate]: { template: K; to: string; data: EmailTemplates[K] };
}[EmailTemplate];

/** Records emails instead of delivering them. */
@Injectable()
export class FakeEmailService extends EmailService {
  // shortcut: grows for the process lifetime; fine until real delivery replaces the fake outside tests.
  readonly sent: SentEmail[] = [];

  constructor(
    private readonly config: AppConfig,
    @InjectPinoLogger(FakeEmailService.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  send<T extends EmailTemplate>(template: T, to: string, data: EmailTemplates[T]): Promise<void> {
    this.sent.push({ template, to, data } as SentEmail);
    // The link holds a one-time token, so it is logged only where developers need it to click through.
    const link = this.config.appEnv === 'local' && 'link' in data ? { link: data.link } : {};
    this.logger.info({ template, ...link }, 'email recorded, not sent');
    return Promise.resolve();
  }
}
