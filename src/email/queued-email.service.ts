import { randomUUID } from 'node:crypto';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { EmailService, type EmailTemplate, type EmailTemplates } from './email.service.js';
import { queuePrefix } from './redis-connection.js';

export const EMAIL_QUEUE = 'email';
const ENQUEUE_TIMEOUT_MS = 5000;

export interface EmailJobData {
  template: EmailTemplate;
  to: string;
  data: EmailTemplates[EmailTemplate];
}

export class EmailEnqueueError extends Error {
  constructor() {
    super('email could not be enqueued');
    this.name = 'EmailEnqueueError';
  }
}

@Injectable()
export class QueuedEmailService extends EmailService implements OnApplicationShutdown {
  private readonly queue: Queue<EmailJobData>;

  constructor(config: AppConfig, @InjectPinoLogger(QueuedEmailService.name) logger: PinoLogger) {
    super();
    this.queue = new Queue<EmailJobData>(EMAIL_QUEUE, {
      prefix: queuePrefix(config.appEnv),
      connection: { url: config.redisUrl, enableOfflineQueue: false },
    });
    this.queue.on('error', (err) => logger.warn({ err }, 'email queue connection error'));
  }

  async send<T extends EmailTemplate>(
    template: T,
    to: string,
    data: EmailTemplates[T],
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    // BullMQ waits for the first connection forever when Redis is down at boot, so bound the add.
    // shortcut: a timed-out add may still land later and send; the admin can resend, upgrade if duplicates show up.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new EmailEnqueueError()), ENQUEUE_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        this.queue
          .add(
            'send',
            { template, to, data },
            {
              jobId: randomUUID(),
              attempts: 8,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: true,
              removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
            },
          )
          .catch(() => {
            throw new EmailEnqueueError();
          }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
