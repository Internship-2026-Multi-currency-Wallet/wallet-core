import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { MetricsServer } from './metrics-server.js';
import { Metrics } from './metrics.js';

@Global()
@Module({
  providers: [
    {
      provide: Metrics,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        new Metrics({ service: config.serviceName, env: config.appEnv }),
    },
    MetricsServer,
  ],
  exports: [Metrics],
})
export class MetricsModule {}
