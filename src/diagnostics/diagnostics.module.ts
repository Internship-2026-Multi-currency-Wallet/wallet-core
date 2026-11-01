/**
 * Diagnostics: trace one request across the backends of an environment.
 * This file is IDENTICAL in wallet-core, rates-service and treasury-service.
 *
 *   curl -X POST https://staging-wallet-core.wallet.shatori.com/diagnostics/ping \
 *     -H 'Authorization: Dev 1:wallet' -H 'x-request-id: trace-123'
 *
 * The service publishes `system.ping`; every backend of the environment logs
 * "system.ping received" with the same `requestId` — search it in Grafana.
 */
import {
  Controller,
  HttpCode,
  Inject,
  Module,
  type OnModuleDestroy,
  type OnModuleInit,
  Post,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { AppConfig } from '../config/app-config.js';
import { EventPublisher, EventSubscriber, type Unsubscribe } from '../events/event-bus.js';

@Controller('diagnostics')
export class DiagnosticsController {
  constructor(
    @Inject(EventPublisher) private readonly publisher: EventPublisher,
    @Inject(AppConfig) private readonly config: AppConfig,
    @InjectPinoLogger(DiagnosticsController.name) private readonly logger: PinoLogger,
  ) {}

  /** Publishes `system.ping` (any authenticated user). */
  @Post('ping')
  @HttpCode(200)
  async ping(@CurrentUser() user: AuthUser): Promise<{ published: true }> {
    await this.publisher.publish('system.ping', {
      v: 1,
      from: this.config.serviceName,
      ts: new Date().toISOString(),
    });
    this.logger.info({ userId: user.id }, 'system.ping published');
    return { published: true };
  }
}

@Module({ controllers: [DiagnosticsController] })
export class DiagnosticsModule implements OnModuleInit, OnModuleDestroy {
  private unsubscribe?: Unsubscribe;

  constructor(
    @Inject(EventSubscriber) private readonly subscriber: EventSubscriber,
    @InjectPinoLogger(DiagnosticsModule.name) private readonly logger: PinoLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    this.unsubscribe = await this.subscriber.subscribe('system.ping', (ping, meta) => {
      this.logger.info(
        { from: ping.from, publishedAt: meta.publishedAt },
        `system.ping received from ${ping.from}`,
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.unsubscribe?.();
  }
}
