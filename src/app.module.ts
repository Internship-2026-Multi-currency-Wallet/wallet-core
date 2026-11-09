import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { PinoLogger } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { AppConfig } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DiagnosticsModule } from './diagnostics/diagnostics.module.js';
import { EmailModule } from './email/email.module.js';
import { EventsModule } from './events/events.module.js';
import { graphqlOptions } from './graphql/graphql.config.js';
import { HealthModule } from './health/health.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { RatesModule } from './rates/rates.module.js';
import { RedisModule } from './redis/redis.module.js';
import { ClientSettingsModule } from './settings/client-settings.module.js';
import { StaffModule } from './staff/staff.module.js';
import { ThrottlingModule } from './throttling/throttling.module.js';

/**
 * Root module. Shared file: change it only in small, dedicated PRs.
 * Add one module per feature (e.g. `LedgerModule`) to `imports`.
 */
@Module({
  imports: [
    // Infrastructure
    ConfigModule,
    LoggingModule,
    DatabaseModule,
    RedisModule,
    EventsModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [AppConfig, PinoLogger],
      useFactory: graphqlOptions,
    }),
    // Seams
    AuthModule,
    // After AuthModule: global guards run in module order, and the throttler needs req.user.
    ThrottlingModule,
    ClientSettingsModule,
    RatesModule,
    EmailModule,
    // Features
    HealthModule,
    DiagnosticsModule,
    StaffModule,
  ],
})
export class AppModule {}
