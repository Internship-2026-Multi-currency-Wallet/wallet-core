import { Global, Inject, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { MetricsServer } from './metrics-server.js';
import { Metrics } from './metrics.js';
import { requestMetricsMiddleware } from './request-metrics.js';

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
export class MetricsModule implements NestModule {
  constructor(@Inject(Metrics) private readonly metrics: Metrics) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestMetricsMiddleware(this.metrics)).forRoutes('*');
  }
}
