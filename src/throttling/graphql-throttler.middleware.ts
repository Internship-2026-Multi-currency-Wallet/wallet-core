import { Injectable, type NestMiddleware } from '@nestjs/common';
import { InjectThrottlerStorage, type ThrottlerStorage } from '@nestjs/throttler';
import type { NextFunction, Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { Authenticator } from '../auth/authenticator.js';
import { AppConfig } from '../config/app-config.js';
import { Metrics } from '../metrics/metrics.js';
import { countGraphqlErrors } from '../metrics/request-metrics.js';
import {
  throttledCallerFields,
  throttleKey,
  throttleLimit,
  throttleTracker,
} from './throttle-caller.js';
import { tooManyRequestsError } from './throttle-errors.js';

/** Before Apollo, because documents that fail to parse or validate never reach a guard. */
@Injectable()
export class GraphqlThrottlerMiddleware implements NestMiddleware {
  constructor(
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
    private readonly authenticator: Authenticator,
    private readonly config: AppConfig,
    private readonly metrics: Metrics,
    // Plain `PinoLogger`, not `@InjectPinoLogger`: that provider only exists if this file loads before LoggingModule.
    private readonly pinoLogger: PinoLogger,
  ) {
    pinoLogger.setContext(GraphqlThrottlerMiddleware.name);
  }

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (req.method === 'OPTIONS') return next();
    // Bad credentials count as anonymous; AuthGuard refuses them later.
    const user = (await this.authenticator.authenticate(req).catch(() => null)) ?? undefined;
    const limit = throttleLimit(this.config, user);
    const { totalHits, timeToExpire, isBlocked, timeToBlockExpire } = await this.storage.increment(
      throttleKey(this.config, throttleTracker(user, req.ip)),
      this.config.throttle.ttlSeconds * 1000,
      limit,
      0,
      'default',
    );

    if (isBlocked) {
      // Only the first refusal in a window is logged, so a flood of refused requests does not flood the logs.
      if (totalHits === limit + 1) {
        this.pinoLogger.warn(throttledCallerFields(user, req.ip), 'request throttled');
      }
      res.setHeader('Retry-After', timeToBlockExpire);
      const error = tooManyRequestsError(timeToBlockExpire).toJSON();
      // Apollo's metrics plugin never sees this request, so the refusal is counted here.
      countGraphqlErrors(this.metrics, undefined, [error], req.id);
      res.status(200).json({ errors: [error] });
      return;
    }
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - totalHits));
    res.setHeader('X-RateLimit-Reset', timeToExpire);
    next();
  }
}
