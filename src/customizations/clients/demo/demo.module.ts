import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config.js';
import { ClientHookActivator } from '../../client-hook-activator.js';
import { CustomizationsCoreModule } from '../../customizations-core.module.js';

/**
 * Customizations of the `demo` client.
 * The demo client has no production hooks: it exists so a default deployment (`CLIENT=demo`) runs
 * the same wiring as the others. Example hooks for it belong in tests.
 *
 * Hook providers (classes with `@ClientHook` methods) are listed in `providers` below, so they must
 * be declared HERE: the activator only looks at the providers of the module that subscribed.
 *
 * This module is imported by every deployment, whatever its `CLIENT`, so the first thing it does is
 * check the configured client and subscribe itself only when it is `demo`. For any other
 * client nothing is subscribed, and its hook providers are merely constructed and never registered.
 */
@Module({
  imports: [CustomizationsCoreModule],
  providers: [],
})
export class DemoModule implements OnModuleInit {
  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(ClientHookActivator) private readonly activator: ClientHookActivator,
  ) {}

  onModuleInit(): void {
    if (this.config.client !== 'demo') return;
    this.activator.subscribe(DemoModule);
  }
}
