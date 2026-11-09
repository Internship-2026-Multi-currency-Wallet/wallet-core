import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service.js';
import { FakeEmailService } from './fake-email.service.js';

@Global()
@Module({
  // The fake is bound until real delivery lands.
  providers: [{ provide: EmailService, useClass: FakeEmailService }],
  exports: [EmailService],
})
export class EmailModule {}
