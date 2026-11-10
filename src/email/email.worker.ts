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
import { EMAIL_QUEUE, type EmailJobData } from './queued-email.service.js';
import { queuePrefix, redisConnectionOptions } from './redis-connection.js';
import { renderEmail } from './templates/index.js';
import {
  EMAIL_TRANSPORT_CLIENT,
  EmailTransportError,
  type EmailTransport,
} from './transports/email-transport.js';

@Injectable()
export class EmailWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly worker?: Worker<EmailJobData>;

  constructor(
    private readonly config: AppConfig,
    @Inject(EMAIL_TRANSPORT_CLIENT) private readonly transport: EmailTransport | undefined,
    @InjectPinoLogger(EmailWorker.name) private readonly logger: PinoLogger,
  ) {
    if (config.email.transport === 'fake' || !transport) return;
    this.worker = new Worker<EmailJobData>(EMAIL_QUEUE, (job) => this.process(job), {
      prefix: queuePrefix(config.appEnv),
      connection: redisConnectionOptions(config.redisUrl, { maxRetriesPerRequest: null }),
      concurrency: 5,
      autorun: false,
    });
    this.worker.on('error', (err) => logger.warn({ err }, 'email queue connection error'));
  }

  onApplicationBootstrap(): void {
    // run() resolves only when the worker closes, so it must not be awaited.
    void this.worker
      ?.run()
      .catch((err: unknown) => this.logger.error({ err }, 'email worker stopped'));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }

  async process(
    job: Pick<Job<EmailJobData>, 'id' | 'data' | 'attemptsMade' | 'opts'>,
  ): Promise<void> {
    const { template, to, data } = job.data;
    const fields = { jobId: job.id, template };
    try {
      const { subject, html, text } = renderEmail(template, data as never, brand);
      await this.transport!.send({
        from: { name: brand.senderName, address: this.config.email.from },
        to,
        subject,
        html,
        text,
        idempotencyKey: `${this.config.appEnv}/${job.id}`,
      });
    } catch (err) {
      const attemptsMade = job.attemptsMade + 1;
      const permanent = err instanceof EmailTransportError && !err.retryable;
      const exhausted = attemptsMade >= (job.opts.attempts ?? 1);
      const failure = { err, ...fields, attemptsMade };
      if (permanent || exhausted) this.logger.error(failure, 'email send failed');
      else this.logger.warn(failure, 'email send failed');
      if (permanent) throw new UnrecoverableError((err as Error).message);
      throw err;
    }
    this.logger.info({ ...fields, attempt: job.attemptsMade + 1 }, 'email sent');
  }
}
