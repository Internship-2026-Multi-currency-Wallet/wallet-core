import type { Knex } from 'knex';
import { AppConfig } from './config/app-config.js';
import { createKnex } from './database/database.module.js';
import { formatLedgerVerifyReport } from './ledger/ledger-verify-output.js';
import { verifyLedger } from './ledger/ledger-verifier.js';

// No Nest here: only the database is needed, and booting AppModule would also connect Redis, so the check
// would fail while Redis is down although the ledger is fine.
// Built before the `try`: an invalid env fails with the validation message, which names variables, not values.
const config = AppConfig.fromEnv();
let db: Knex | undefined;
try {
  db = createKnex(config.databaseUrl);
  const { text, consistent } = formatLedgerVerifyReport(await verifyLedger(db));
  process.stdout.write(text);
  process.exitCode = consistent ? 0 : 1;
} catch (err) {
  // Name and code only: a database error message can carry SQL values, its code (ER_NO_SUCH_TABLE, ECONNREFUSED) cannot.
  const name = err instanceof Error ? err.name : 'unknown';
  const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
  process.stderr.write(
    `ledger:verify failed (${typeof code === 'string' ? `${name} ${code}` : name})\n`,
  );
  process.exitCode = 1;
} finally {
  await db?.destroy();
}
