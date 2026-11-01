import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
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
  constructor(
    @Inject(KNEX) private readonly db: Knex,
    @InjectPinoLogger(DatabaseModule.name) private readonly logger: PinoLogger,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
    this.logger.info('Database pool closed');
  }
}
