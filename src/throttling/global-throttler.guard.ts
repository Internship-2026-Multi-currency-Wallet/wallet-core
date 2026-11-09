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

const UNLIMITED_PATHS = new Set(['/health', '/metrics']);

const COUNTED = Symbol('throttleCounted');

interface ThrottledRequest extends RequestLike {
  ip?: string;
  path?: string;
  [COUNTED]?: Promise<boolean>;
}

type ThrottledGraphqlContext = GraphqlContext & { req: ThrottledRequest };

/**
 * Global rate limit: one counter per caller (`user:<id>`, `staff:<id>` or `ip:<ip>`) for the whole
 * service. Must run after `AuthGuard`, which sets `req.user`.
 */
@Injectable()
export class GlobalThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly config: AppConfig,
    // Plain `PinoLogger`, not `@InjectPinoLogger`: that provider only exists if this file loads before
    // LoggingModule. Named `pinoLogger` because ThrottlerGuard already has a `logger` field.
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
    const { req } = this.getRequestResponse(context);
    return Promise.resolve(req.path !== undefined && UNLIMITED_PATHS.has(req.path));
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (await this.shouldSkip(context)) return true;
    const { req } = this.getRequestResponse(context);
    // GraphQL runs the guard once per top-level field, concurrently: the shared Promise (not a
    // flag) makes one HTTP request count once.
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

  // No class or handler name in the key: every endpoint shares one counter.
  protected override generateKey(_context: ExecutionContext, tracker: string): string {
    return `${this.config.appEnv}:throttle:${tracker}`;
  }

  protected override throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const { req } = this.getRequestResponse(context);
    const caller = req.user
      ? { keyType: keyType(req.user), userId: req.user.id }
      : { keyType: 'ip', ip: req.ip };
    this.pinoLogger.warn(caller, 'request throttled');

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
