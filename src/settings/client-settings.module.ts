import { Global, Module } from '@nestjs/common';
import { ClientSettingsService } from './client-settings.service.js';
import { SettingsResolver } from './settings.resolver.js';

@Global()
@Module({
  providers: [ClientSettingsService, SettingsResolver],
  exports: [ClientSettingsService],
})
export class ClientSettingsModule {}
