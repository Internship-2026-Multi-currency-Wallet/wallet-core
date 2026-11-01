import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';

async function bootstrap(): Promise<void> {
  // Buffer Nest's own startup logs until the JSON logger is ready.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
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
