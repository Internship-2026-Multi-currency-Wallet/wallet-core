import { Global, Module } from '@nestjs/common';
import { getLoggerToken, type PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { EmailPreviewController } from './email-preview.controller.js';
import { EmailService } from './email.service.js';
import { EmailWorker } from './email.worker.js';
import { FakeEmailService } from './fake-email.service.js';
import { QueuedEmailService } from './queued-email.service.js';
import { createEmailTransport } from './transports/create-transport.js';
import { EMAIL_TRANSPORT_CLIENT } from './transports/email-transport.js';

@Global()
@Module({
  controllers: [EmailPreviewController],
  providers: [
    {
      provide: EmailService,
      useFactory: (config: AppConfig, fakeLogger: PinoLogger, queuedLogger: PinoLogger) =>
        config.email.transport === 'fake'
          ? new FakeEmailService(fakeLogger)
          : new QueuedEmailService(config, queuedLogger),
      inject: [
        AppConfig,
        getLoggerToken(FakeEmailService.name),
        getLoggerToken(QueuedEmailService.name),
      ],
    },
    { provide: EMAIL_TRANSPORT_CLIENT, useFactory: createEmailTransport, inject: [AppConfig] },
    EmailWorker,
  ],
  exports: [EmailService],
})
export class EmailModule {}
