import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { EmailPreviewController } from './email-preview.controller.js';
import { EmailService } from './email.service.js';
import { FakeEmailService } from './fake-email.service.js';
import { createEmailTransport } from './transports/create-transport.js';
import { EMAIL_TRANSPORT_CLIENT } from './transports/email-transport.js';

@Global()
@Module({
  controllers: [EmailPreviewController],
  providers: [
    // The fake is bound until real delivery lands.
    { provide: EmailService, useClass: FakeEmailService },
    { provide: EMAIL_TRANSPORT_CLIENT, useFactory: createEmailTransport, inject: [AppConfig] },
  ],
  exports: [EmailService],
})
export class EmailModule {}
