import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import knex, { type Knex } from 'knex';
import { AppConfig } from '../config/app-config.js';

/** Injection token for the shared Knex instance: `@Inject(KNEX) private readonly db: Knex`. */
export const KNEX = Symbol('KNEX');

export function createKnex(databaseUrl: string): Knex {
  return knex({
    client: 'mysql2',
    connection: databaseUrl,
    pool: { min: 0, max: 10 },
  });
}

@Global()
@Module({
  providers: [
    {
      provide: KNEX,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => createKnex(config.databaseUrl),
    },
  ],
  exports: [KNEX],
})
export class DatabaseModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(@Inject(KNEX) private readonly db: Knex) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
    this.logger.log('Database pool closed');
  }
}
