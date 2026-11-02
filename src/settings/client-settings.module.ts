import { Global, Module } from '@nestjs/common';
import { ClientSettingsService } from './client-settings.service.js';
import { SettingsRepository } from './settings.repository.js';
import { SettingsResolver } from './settings.resolver.js';

@Global()
@Module({
  providers: [ClientSettingsService, SettingsRepository, SettingsResolver],
  exports: [ClientSettingsService],
})
export class ClientSettingsModule {}
