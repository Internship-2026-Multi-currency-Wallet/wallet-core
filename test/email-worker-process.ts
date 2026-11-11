/**
 * Child process for email-worker-shutdown.e2e-spec.ts: runs the real EmailWorker, shuts it down on
 * request and then lets the process exit on its own. Anything logged after shutdown goes to stdout.
 */
import 'reflect-metadata';
import { writeSync } from 'node:fs';
import type { Worker } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../src/config/app-config.js';
import { EmailWorker } from '../src/email/email.worker.js';

const [redisUrl, appEnv, sendMs, shutdownOn] = process.argv.slice(2);
const tell = (message: object) => process.connected && process.send?.(message);
let closed = false;
const afterShutdown = (what: string) => {
  if (closed) writeSync(1, `${what}\n`);
};
process.on('unhandledRejection', (err) => writeSync(1, `unhandled rejection: ${String(err)}\n`));

// A send that outlives the shutdown still logs its success; only warnings and errors are reported.
const report = (level: string) => (fields: unknown, msg?: string) =>
  afterShutdown(`${level} ${msg ?? ''} ${JSON.stringify(fields)}`);
const logger = { info: () => {}, warn: report('warn'), error: report('error'), debug: () => {} };

const config = AppConfig.fromEnv({ ...process.env, EMAIL_TRANSPORT: 'smtp', REDIS_URL: redisUrl });
Object.defineProperty(config, 'appEnv', { value: appEnv });
const transport = {
  send: async () => {
    tell({ type: 'sending' });
    await new Promise((resolve) => setTimeout(resolve, Number(sendMs)));
  },
};
const worker = new EmailWorker(config, transport, logger as unknown as PinoLogger);
const bull = (worker as unknown as { worker: Worker }).worker;
worker.onApplicationBootstrap();
void bull
  .waitUntilReady()
  .then(() => tell({ type: 'ready' }))
  .catch(() => undefined);

function shutdown() {
  const started = Date.now();
  void worker.onApplicationShutdown().then(() => {
    closed = true;
    tell({ type: 'closed', ms: Date.now() - started });
    process.disconnect?.();
  });
}
process.on('message', (message) => message === 'shutdown' && shutdown());
// Shutdown between acquisition and processor entry: BullMQ emits 'active' before it calls the processor.
if (shutdownOn === 'active') bull.once('active', shutdown);
