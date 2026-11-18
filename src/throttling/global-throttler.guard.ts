import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerException,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { PinoLogger } from 'nestjs-pino';
import type { RequestLike } from '../auth/request-context.js';
import { AppConfig } from '../config/app-config.js';
import { throttledCallerFields, throttleKey, throttleTracker } from './throttle-caller.js';

interface ThrottledRequest extends RequestLike {
  ip?: string;
}

/**
 * Counts REST requests; must run after `AuthGuard` so caller keys use the authenticated identity.
 * GraphQL is counted before Apollo by `GraphqlThrottlerMiddleware`.
 */
@Injectable()
export class GlobalThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: AppConfig,
    // Plain `PinoLogger`, not `@InjectPinoLogger`: that provider only exists if this file loads before LoggingModule.
    private readonly pinoLogger: PinoLogger,
  ) {
    super(options, storage, reflector);
    pinoLogger.setContext(GlobalThrottlerGuard.name);
  }

  protected override shouldSkip(context: ExecutionContext): Promise<boolean> {
    return Promise.resolve(context.getType<string>() === 'graphql');
  }

  protected override getTracker(req: ThrottledRequest): Promise<string> {
    return Promise.resolve(throttleTracker(req.user, req.ip));
  }

  protected override generateKey(_context: ExecutionContext, tracker: string): string {
    return throttleKey(this.config, tracker);
  }

  protected override throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    // Only the first refusal in a window is logged, so a flood of refused requests does not flood the logs.
    if (detail.totalHits === detail.limit + 1) {
      const req = context.switchToHttp().getRequest<ThrottledRequest>();
      this.pinoLogger.warn(throttledCallerFields(req.user, req.ip), 'request throttled');
    }
    // `Retry-After` is already set on the response by ThrottlerGuard.
    return Promise.reject(new ThrottlerException());
  }
}
