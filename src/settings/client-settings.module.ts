import { Global, Module } from '@nestjs/common';
import { ClientSettingsService } from './client-settings.service.js';

@Global()
@Module({
  providers: [ClientSettingsService],
  exports: [ClientSettingsService],
})
export class ClientSettingsModule {}
