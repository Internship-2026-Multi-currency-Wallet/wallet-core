import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(AppConfig);
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  app.enableShutdownHooks();
  await app.listen(config.port);
  new Logger('Bootstrap').log(
    `${config.serviceName} ${config.version} listening on :${config.port} ` +
      `(client=${config.client}, devAuth=${config.devAuth})`,
  );
}

await bootstrap();
