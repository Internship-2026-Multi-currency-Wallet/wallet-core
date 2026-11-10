import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EmailService, type EmailTemplate, type EmailTemplates } from './email.service.js';

export type SentEmail = {
  [K in EmailTemplate]: { template: K; to: string; data: EmailTemplates[K] };
}[EmailTemplate];

export const MAX_RECORDED_EMAILS = 1000;

@Injectable()
export class FakeEmailService extends EmailService {
  // Bounded: the fake is bound outside tests until real delivery lands.
  readonly sent: SentEmail[] = [];

  constructor(@InjectPinoLogger(FakeEmailService.name) private readonly logger: PinoLogger) {
    super();
  }

  send<T extends EmailTemplate>(template: T, to: string, data: EmailTemplates[T]): Promise<void> {
    this.sent.push({ template, to, data } as SentEmail);
    if (this.sent.length > MAX_RECORDED_EMAILS) this.sent.shift();
    this.logger.info({ template }, 'email recorded, not sent');
    return Promise.resolve();
  }
}
