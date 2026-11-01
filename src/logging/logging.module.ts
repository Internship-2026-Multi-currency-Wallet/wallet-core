/**
 * Structured JSON logging (pino via nestjs-pino). This file is IDENTICAL in all three backends.
 *
 * Inject a logger with `@InjectPinoLogger(MyService.name) private readonly logger: PinoLogger`
 * and log objects first, message second: `this.logger.info({ conversionId }, 'conversion booked')`.
 * Inside an HTTP request, a GraphQL operation or an event handler every line carries `requestId`.
 */
import { Global, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { httpLoggerOptions, type LoggerSettings } from './logger.options.js';

export function loggerSettings(config: AppConfig): LoggerSettings {
  return {
    service: config.serviceName,
    appEnv: config.appEnv,
    client: config.client,
    level: config.logLevel,
    pretty: config.nodeEnv === 'development',
  };
}

@Global()
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: httpLoggerOptions(loggerSettings(config)),
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
