import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger, PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';
import { configureApp } from './configure-app.js';
import { useRequestMetrics } from './metrics/request-metrics.js';

async function bootstrap(): Promise<void> {
  // Buffer Nest's own startup logs until the JSON logger is ready.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  configureApp(app);
  app.useLogger(app.get(Logger));
  useRequestMetrics(app);
  const config = app.get(AppConfig);
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.enableShutdownHooks();
  await app.listen(config.port);
  const logger = await app.resolve(PinoLogger);
  logger.setContext('Bootstrap');
  logger.info(
    { version: config.version, port: config.port, devAuth: config.devAuth },
    `${config.serviceName} ${config.version} listening on :${config.port}`,
  );
}

await bootstrap();
