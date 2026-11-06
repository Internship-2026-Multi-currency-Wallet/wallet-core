import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ClientHookActivator } from './client-hook-activator.js';
import { HookRegistry } from './hook-registry.js';

/**
 * The customization engine: the per-application `HookRegistry` and the activator that client
 * modules subscribe to. Client modules import this module; core modules never import it.
 * `AppConfig` and `PinoLogger` come from the global config and logging modules.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [HookRegistry, ClientHookActivator],
  exports: [ClientHookActivator],
})
export class CustomizationsCoreModule {}
