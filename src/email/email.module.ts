import { Global, Module } from '@nestjs/common';
import { EMAIL_SENDER } from './email-sender.js';
import { LoggingEmailSender } from './logging-email-sender.js';

@Global()
@Module({
  providers: [{ provide: EMAIL_SENDER, useClass: LoggingEmailSender }],
  exports: [EMAIL_SENDER],
})
export class EmailModule {}
