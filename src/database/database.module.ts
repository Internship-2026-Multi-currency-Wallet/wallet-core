import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import knex, { type Knex } from 'knex';
import { AppConfig } from '../config/app-config.js';

/** Injection token for the shared Knex instance: `@Inject(KNEX) private readonly db: Knex`. */
export const KNEX = Symbol('KNEX');

export function createKnex(databaseUrl: string): Knex {
  const db = knex({
    client: 'mysql2',
    connection: databaseUrl,
    pool: { min: 0, max: 10 },
    // Error messages carry the SQL with `?`, not the values (emails, password hashes) that went into it.
    compileSqlOnError: false,
  });
  db.on('query-error', scrubQueryError);
  return db;
}

/** Fields of a failed query's error (mysql2) that can carry the values that went into it. */
interface QueryError {
  message: string;
  sql?: string;
  sqlMessage?: string;
}

const DUPLICATE_VALUE = /Duplicate entry '.*' for key '/s;

/**
 * Removes the query's values from its error before anyone catches or logs it: mysql2 adds `sql`
 * with the values inlined, and MySQL names the duplicate value in "Duplicate entry '…'". The key
 * name stays, so a duplicate can still be told apart by its index.
 */
export function scrubQueryError(error: QueryError): void {
  delete error.sql;
  error.message = error.message.replace(DUPLICATE_VALUE, "Duplicate entry '?' for key '");
  if (error.sqlMessage !== undefined) {
    error.sqlMessage = error.sqlMessage.replace(DUPLICATE_VALUE, "Duplicate entry '?' for key '");
  }
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
