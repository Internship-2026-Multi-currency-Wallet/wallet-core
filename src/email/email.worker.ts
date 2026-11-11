import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { type Job, UnrecoverableError, Worker } from 'bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { brand } from '../brand/brand.js';
import { AppConfig } from '../config/app-config.js';
import { redisErrorReason } from '../redis/redis-connection.js';
import { EMAIL_QUEUE, type EmailJobData } from './queued-email.service.js';
import { queuePrefix } from './redis-connection.js';
import { renderEmail, sampleData } from './templates/index.js';
import {
  EMAIL_TRANSPORT_CLIENT,
  EmailTransportError,
  type EmailTransport,
} from './transports/email-transport.js';

// Grace for active sends to finish and be recorded; close() without force can wait indefinitely
// while Redis does not answer.
const SHUTDOWN_GRACE_MS = 3000;

@Injectable()
export class EmailWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly worker?: Worker<EmailJobData>;
  // Jobs acquired here whose outcome BullMQ has not yet written to Redis.
  private readonly unsettled = new Set<string>();
  private onSettled?: () => void;

  constructor(
    private readonly config: AppConfig,
    @Inject(EMAIL_TRANSPORT_CLIENT) transport: EmailTransport | undefined,
    @InjectPinoLogger(EmailWorker.name) private readonly logger: PinoLogger,
  ) {
    if (config.email.transport === 'fake') return;
    if (!transport) {
      throw new Error(`Email transport '${config.email.transport}' is configured but not provided`);
    }
    this.worker = new Worker<EmailJobData>(EMAIL_QUEUE, (job) => this.process(job, transport), {
      prefix: queuePrefix(config.appEnv),
      connection: { url: config.redisUrl, maxRetriesPerRequest: null },
      concurrency: 5,
      autorun: false,
    });
    // BullMQ emits an error per reconnect attempt and its messages carry the Redis host.
    let lastReason: string | undefined;
    const worker = this.worker;
    this.worker.on('error', (err) => {
      // Commands still pending at a forced close are rejected with "Connection is closed".
      if (worker.closing) return;
      const reason = redisErrorReason(err);
      if (reason === lastReason) return;
      lastReason = reason;
      logger.warn({ reason }, 'email worker Redis error, BullMQ reconnects with backoff');
    });
    const settle = (job?: Job<EmailJobData>) => {
      this.unsettled.delete(String(job?.id));
      if (this.unsettled.size === 0) this.onSettled?.();
    };
    // 'active' is emitted when a job is acquired, a few awaits before the processor starts.
    this.worker.on('active', (job) => this.unsettled.add(String(job.id)));
    this.worker.on('completed', settle);
    this.worker.on('failed', settle);
    this.worker.getBackend().on('ready', () => {
      if (lastReason === undefined) return;
      lastReason = undefined;
      logger.info('email worker Redis connection restored');
    });
  }

  onApplicationBootstrap(): void {
    // run() resolves only when the worker closes, so it must not be awaited.
    void this.worker
      ?.run()
      .catch((err: unknown) =>
        this.logger.error({ reason: redisErrorReason(err) }, 'email worker stopped'),
      );
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.worker) return;
    // Only stops fetching: plain pause() reconnects the blocking client once active jobs end, even
    // after close().
    await this.worker.pause(true);
    if (this.unsettled.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      await new Promise<void>((resolve) => {
        this.onSettled = resolve;
        timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
      });
      clearTimeout(timer);
    }
    // Force skips QUIT, which may not settle while Redis does not answer. It does not cancel a send
    // still running (see README, Email).
    await this.worker.close(true);
  }

  async process(
    job: Pick<Job<EmailJobData>, 'id' | 'data' | 'attemptsMade' | 'opts'>,
    transport: EmailTransport,
  ): Promise<void> {
    const { template, to, data } = job.data;
    const fields = { jobId: job.id, template };
    if (!Object.hasOwn(sampleData, template)) {
      this.logger.error(fields, 'email job has an unknown template');
      throw new UnrecoverableError('email job has an unknown template');
    }
    try {
      const { subject, html, text } = renderEmail(template, data, brand);
      await transport.send({
        from: { name: brand.senderName, address: this.config.email.from },
        to,
        subject,
        html,
        text,
        idempotencyKey: `${this.config.appEnv}/${job.id}`,
      });
    } catch (err) {
      const attempt = job.attemptsMade + 1;
      const permanent = err instanceof EmailTransportError && !err.retryable;
      const exhausted = attempt >= (job.opts.attempts ?? 1);
      const failure = { err, ...fields, attempt };
      if (permanent || exhausted) this.logger.error(failure, 'email send failed');
      else this.logger.warn(failure, 'email send failed');
      if (permanent) throw new UnrecoverableError((err as Error).message);
      throw err;
    }
    this.logger.info({ ...fields, attempt: job.attemptsMade + 1 }, 'email sent');
  }
}
