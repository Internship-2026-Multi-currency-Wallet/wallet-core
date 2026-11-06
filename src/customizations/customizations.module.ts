import { Module } from '@nestjs/common';
import { DemoModule } from './clients/demo/demo.module.js';
import { KvitkaModule } from './clients/kvitka/kvitka.module.js';
import { WislaModule } from './clients/wisla/wisla.module.js';
import { CustomizationsCoreModule } from './customizations-core.module.js';

/**
 * Client customization, as seen by the rest of the application: import this one module in
 * `AppModule`. It registers EVERY client module; each of them checks `AppConfig.client` when it
 * initialises and takes part only if it is the configured client. Adding a client = adding its
 * module under `clients/<client>/` and listing it here.
 *
 * The dependency runs one way: this module (and the client modules) know the core engine and the
 * core services they hook; no core module imports anything from `clients/` (enforced by ESLint).
 */
@Module({
  imports: [CustomizationsCoreModule, KvitkaModule, WislaModule, DemoModule],
})
export class CustomizationsModule {}
