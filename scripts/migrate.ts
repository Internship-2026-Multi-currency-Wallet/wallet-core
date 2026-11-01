/**
 * Knex migrations CLI. Runs with plain Node (built-in TypeScript type stripping), no build needed.
 *
 *   npm run migrate                 # apply all pending migrations
 *   npm run migrate:rollback        # roll back the last batch
 *   npm run migrate:status          # list completed / pending migrations
 *   npm run migrate:make -- <name>  # create migrations/<timestamp>_<name>.ts
 *
 * Uses DATABASE_URL (default: the local docker-compose database).
 * Logs like the service: JSON lines in production (the container runs this before the app),
 * pino-pretty locally.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import knex from 'knex';
import { pino } from 'pino';

const DEFAULT_DATABASE_URL = 'mysql://wallet:wallet@localhost:3306/wallet_core';
const root = join(import.meta.dirname, '..');
const migrations = {
  directory: join(root, 'migrations'),
  extension: 'ts',
  loadExtensions: ['.ts'],
  stub: join(root, 'migrations', 'migration.stub'),
  tableName: 'knex_migrations',
};

const service = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string })
  .name;
const stream =
  process.env.NODE_ENV === 'production'
    ? pino.destination({ sync: true })
    : (await import('pino-pretty')).default({
        sync: true,
        ignore: 'pid,hostname,service,appEnv,client',
      });
const log = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: {
      service,
      appEnv: process.env.APP_ENV || 'local',
      client: process.env.CLIENT || 'demo',
      context: 'migrate',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  },
  stream,
);

const [command = 'latest', name] = process.argv.slice(2);

if (command === 'make') {
  if (!name) {
    log.error('Usage: npm run migrate:make -- <name>');
    process.exit(1);
  }
  // `make` only writes a file; it does not need a database connection.
  const db = knex({ client: 'mysql2' });
  const file = await db.migrate.make(name, migrations);
  log.info({ file }, `Created ${file}`);
  await db.destroy();
  process.exit(0);
}

const db = knex({
  client: 'mysql2',
  connection: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
  migrations,
});

try {
  log.info({ command }, `Migrations: ${command}`);
  switch (command) {
    case 'latest': {
      const [batch, files] = (await db.migrate.latest()) as [number, string[]];
      log.info(
        { batch, files },
        files.length ? `Batch ${batch}: ${files.join(', ')}` : 'Already up to date',
      );
      break;
    }
    case 'rollback': {
      const [batch, files] = (await db.migrate.rollback()) as [number, string[]];
      log.info(
        { batch, files },
        files.length ? `Rolled back batch ${batch}: ${files.join(', ')}` : 'Nothing to roll back',
      );
      break;
    }
    case 'status': {
      const [done, pending] = (await db.migrate.list()) as [{ name: string }[], { file: string }[]];
      log.info(`Completed: ${done.map((m) => m.name).join(', ') || '-'}`);
      log.info(`Pending:   ${pending.map((m) => m.file).join(', ') || '-'}`);
      break;
    }
    default:
      log.error(`Unknown command "${command}". Use latest | rollback | status | make <name>.`);
      process.exitCode = 1;
  }
} catch (error) {
  log.error({ err: error }, `Migrations failed: ${String(error)}`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
