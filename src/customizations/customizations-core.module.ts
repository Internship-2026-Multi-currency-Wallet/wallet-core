import { Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { ClientAvailabilityGuard } from './client-availability.guard.js';
import { ClientAvailabilityValidator } from './client-availability.validator.js';
import { ClientHookActivator } from './client-hook-activator.js';
import { HookRegistry } from './hook-registry.js';

/**
 * The customization engine: the per-application `HookRegistry` and the activator that client
 * modules subscribe to. Client modules import this module; core modules never import it.
 * `AppConfig` and `PinoLogger` come from the global config and logging modules.
 *
 * The guard's position before `AuthGuard` depends on the import order in `AppModule`.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    HookRegistry,
    ClientHookActivator,
    ClientAvailabilityValidator,
    { provide: APP_GUARD, useClass: ClientAvailabilityGuard },
  ],
  exports: [ClientHookActivator],
})
export class CustomizationsCoreModule {}
