import { type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerException,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import type { AuthUser } from '../auth/auth-user.js';
import type { RequestLike } from '../auth/request-context.js';
import { UserKind } from '../auth/user-kind.js';
import { AppConfig } from '../config/app-config.js';
import type { GraphqlContext } from '../graphql/graphql.config.js';
import { tooManyRequestsError } from './throttle-errors.js';

const COUNTED = Symbol('throttleCounted');

interface ThrottledRequest extends RequestLike {
  ip?: string;
  [COUNTED]?: Promise<boolean>;
}

type ThrottledGraphqlContext = GraphqlContext & { req: ThrottledRequest };

/** Must run after `AuthGuard` so caller keys use the authenticated identity. */
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
    if (context.getType<string>() === 'graphql') {
      // Websocket operations have no Express request, so there is no client IP to count.
      return Promise.resolve(graphqlContext(context).res === undefined);
    }
    return Promise.resolve(false);
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (await this.shouldSkip(context)) return true;
    const { req } = this.getRequestResponse(context);
    // GraphQL runs the guard once per top-level field, concurrently, so a shared Promise (not a flag) counts the request once.
    const counted = req[COUNTED];
    if (counted) return counted;
    const result = super.canActivate(context);
    req[COUNTED] = result;
    return result;
  }

  protected override getRequestResponse(context: ExecutionContext): {
    req: ThrottledRequest;
    res: Response;
  } {
    if (context.getType<string>() === 'graphql') {
      const { req, res } = graphqlContext(context);
      return { req, res: res as Response };
    }
    return super.getRequestResponse(context) as { req: ThrottledRequest; res: Response };
  }

  protected override async getTracker(req: ThrottledRequest): Promise<string> {
    if (req.user) return `${keyType(req.user)}:${req.user.id}`;
    return `ip:${await super.getTracker(req)}`;
  }

  // No handler name, so all endpoints share one counter; the service name separates backends sharing one Redis.
  protected override generateKey(_context: ExecutionContext, tracker: string): string {
    return `${this.config.appEnv}:throttle:${this.config.serviceName}:${tracker}`;
  }

  protected override throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    // Only the first refusal in a window is logged, so a flood of refused requests does not flood the logs.
    if (detail.totalHits === detail.limit + 1) {
      const { req } = this.getRequestResponse(context);
      const caller = req.user
        ? { keyType: keyType(req.user), userId: req.user.id }
        : { keyType: 'ip', ip: req.ip };
      this.pinoLogger.warn(caller, 'request throttled');
    }

    if (context.getType<string>() === 'graphql') {
      return Promise.reject(tooManyRequestsError(detail.timeToBlockExpire));
    }
    // `Retry-After` is already set on the response by ThrottlerGuard.
    return Promise.reject(new ThrottlerException());
  }
}

function graphqlContext(context: ExecutionContext): ThrottledGraphqlContext {
  return GqlExecutionContext.create(context).getContext<ThrottledGraphqlContext>();
}

function keyType(user: AuthUser): 'staff' | 'user' {
  return user.kind === UserKind.STAFF ? 'staff' : 'user';
}
