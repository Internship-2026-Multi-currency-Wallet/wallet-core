import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { AuthModule } from './auth/auth.module.js';
import { AppConfig } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { EventsModule } from './events/events.module.js';
import { graphqlOptions } from './graphql/graphql.config.js';
import { HealthModule } from './health/health.module.js';
import { RatesModule } from './rates/rates.module.js';
import { RedisModule } from './redis/redis.module.js';
import { ClientSettingsModule } from './settings/client-settings.module.js';

/**
 * Root module. Shared file: change it only in small, dedicated PRs.
 * Add one module per feature (e.g. `LedgerModule`) to `imports`.
 */
@Module({
  imports: [
    // Infrastructure
    ConfigModule,
    DatabaseModule,
    RedisModule,
    EventsModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [AppConfig],
      useFactory: graphqlOptions,
    }),
    // Seams
    AuthModule,
    ClientSettingsModule,
    RatesModule,
    // Features
    HealthModule,
  ],
})
export class AppModule {}
