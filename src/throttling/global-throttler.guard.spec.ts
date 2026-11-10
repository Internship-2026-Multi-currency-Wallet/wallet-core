import { jest } from '@jest/globals';
import { type ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SkipThrottle, ThrottlerException, type ThrottlerStorage } from '@nestjs/throttler';
import { GraphQLError } from 'graphql';
import type { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import type { AuthUser } from '../auth/auth-user.js';
import { UserKind } from '../auth/user-kind.js';
import { AppConfig } from '../config/app-config.js';
import { GlobalThrottlerGuard } from './global-throttler.guard.js';
import { throttlerOptions } from './throttling.module.js';
import type { ThrottlerStorageRecord } from './window-throttler-storage.js';

const OK: ThrottlerStorageRecord = {
  totalHits: 1,
  timeToExpire: 59,
  isBlocked: false,
  timeToBlockExpire: 0,
};
const BLOCKED: ThrottlerStorageRecord = {
  totalHits: 4,
  timeToExpire: 30,
  isBlocked: true,
  timeToBlockExpire: 42,
};

const TOKEN = 'secret-token-value';

const config = AppConfig.fromEnv({
  APP_ENV: 'staging',
  THROTTLE_LIMIT_ANONYMOUS: '3',
  THROTTLE_LIMIT_USER: '7',
});

interface FakeRequest {
  headers: Record<string, string>;
  ip?: string;
  path?: string;
  user?: AuthUser;
}

class TestController {
  handler(): void {}
}

@SkipThrottle()
class SkippedController {
  handler(): void {}
}

class SkippedHandlerController {
  @SkipThrottle()
  handler(): void {}
}

function user(id: string, kind: UserKind): AuthUser {
  return { id, kind, permissions: [], strategy: 'jwt' };
}

function request(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    headers: { authorization: `Bearer ${TOKEN}` },
    ip: '203.0.113.5',
    path: '/graphql',
    ...overrides,
  };
}

type Controller =
  typeof TestController | typeof SkippedController | typeof SkippedHandlerController;

function baseContext(type: string, args: unknown[], controller: Controller): ExecutionContext {
  return {
    getType: () => type,
    getArgs: () => args,
    getHandler: () => controller.prototype.handler,
    getClass: () => controller,
  } as unknown as ExecutionContext;
}

function httpContext(
  req: FakeRequest,
  res: object,
  controller: Controller = TestController,
): ExecutionContext {
  return {
    ...baseContext('http', [], controller),
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

/** `res` is left out for websocket operations, like the real GraphQL context does. */
function graphqlContext(req: FakeRequest, res?: object): ExecutionContext {
  return baseContext('graphql', [{}, {}, { req, res }, {}], TestController);
}

function setup() {
  const storage = { increment: jest.fn<ThrottlerStorage['increment']>() };
  storage.increment.mockResolvedValue(OK);
  const logger = { warn: jest.fn(), setContext: jest.fn() };
  const options = {
    ...throttlerOptions(
      config,
      { status: 'ready' } as unknown as Redis,
      logger as unknown as PinoLogger,
    ),
    storage,
  };
  const guard = new GlobalThrottlerGuard(
    options,
    storage,
    new Reflector(),
    config,
    logger as unknown as PinoLogger,
  );
  const res = { header: jest.fn() };
  return { guard, storage, logger, res, options };
}

async function readyGuard() {
  const parts = setup();
  await parts.guard.onModuleInit();
  return parts;
}

describe('GlobalThrottlerGuard', () => {
  describe('counter key', () => {
    it('counts a client user under user:<id>, prefixed with APP_ENV and the service name', async () => {
      const { guard, storage, res } = await readyGuard();
      const req = request({ user: user('42', UserKind.CLIENT) });
      await expect(guard.canActivate(graphqlContext(req, res))).resolves.toBe(true);
      expect(storage.increment).toHaveBeenCalledTimes(1);
      expect(storage.increment.mock.calls[0]?.[0]).toBe('staging:throttle:wallet-core:user:42');
    });

    it('counts staff under staff:<id>', async () => {
      const { guard, storage, res } = await readyGuard();
      const req = request({ user: user('7', UserKind.STAFF) });
      await guard.canActivate(graphqlContext(req, res));
      expect(storage.increment.mock.calls[0]?.[0]).toBe('staging:throttle:wallet-core:staff:7');
    });

    it('counts an anonymous caller under ip:<ip>', async () => {
      const { guard, storage, res } = await readyGuard();
      await guard.canActivate(graphqlContext(request(), res));
      expect(storage.increment.mock.calls[0]?.[0]).toBe(
        'staging:throttle:wallet-core:ip:203.0.113.5',
      );
    });

    it('uses one counter for every endpoint', async () => {
      const { guard, storage, res } = await readyGuard();
      await guard.canActivate(httpContext(request({ path: '/a' }), res));
      await guard.canActivate(graphqlContext(request(), res));
      const [first, second] = storage.increment.mock.calls;
      expect(first?.[0]).toBe(second?.[0]);
    });
  });

  describe('limit', () => {
    it('allows a user limitUser requests and an anonymous caller limitAnonymous', async () => {
      const { guard, storage, res } = await readyGuard();
      await guard.canActivate(graphqlContext(request({ user: user('1', UserKind.CLIENT) }), res));
      await guard.canActivate(graphqlContext(request(), res));
      expect(storage.increment.mock.calls[0]?.[2]).toBe(7);
      expect(storage.increment.mock.calls[1]?.[2]).toBe(3);
    });

    it('turns the window from seconds into milliseconds', async () => {
      const { guard, storage, res } = await readyGuard();
      await guard.canActivate(graphqlContext(request(), res));
      expect(storage.increment.mock.calls[0]?.[1]).toBe(config.throttle.ttlSeconds * 1000);
    });
  });

  describe('one count per HTTP request', () => {
    it('counts once when GraphQL runs the guard for several fields at the same time', async () => {
      const { guard, storage, res } = await readyGuard();
      const req = request();
      const results = await Promise.all([
        guard.canActivate(graphqlContext(req, res)),
        guard.canActivate(graphqlContext(req, res)),
      ]);
      expect(results).toEqual([true, true]);
      expect(storage.increment).toHaveBeenCalledTimes(1);
    });

    it('counts each separate request', async () => {
      const { guard, storage, res } = await readyGuard();
      await guard.canActivate(graphqlContext(request(), res));
      await guard.canActivate(graphqlContext(request(), res));
      expect(storage.increment).toHaveBeenCalledTimes(2);
    });
  });

  describe('refusal', () => {
    it('throws a TOO_MANY_REQUESTS GraphQL error with retryAfterSeconds, and warns once per request', async () => {
      const { guard, storage, logger, res } = await readyGuard();
      storage.increment.mockResolvedValue(BLOCKED);
      const req = request({ user: user('42', UserKind.CLIENT) });

      const outcomes = await Promise.allSettled([
        guard.canActivate(graphqlContext(req, res)),
        guard.canActivate(graphqlContext(req, res)),
      ]);

      for (const outcome of outcomes) {
        expect(outcome.status).toBe('rejected');
        const reason = (outcome as PromiseRejectedResult).reason as GraphQLError;
        expect(reason).toBeInstanceOf(GraphQLError);
        expect(reason.extensions).toEqual({ code: 'TOO_MANY_REQUESTS', retryAfterSeconds: 42 });
      }
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        { keyType: 'user', userId: '42' },
        'request throttled',
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(TOKEN);
    });

    it('answers REST with 429 and a Retry-After header', async () => {
      const { guard, storage, logger, res } = await readyGuard();
      storage.increment.mockResolvedValue(BLOCKED);
      const context = httpContext(request({ path: '/diagnostics/ping' }), res);

      const error: unknown = await guard.canActivate(context).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ThrottlerException);
      expect((error as ThrottlerException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(res.header).toHaveBeenCalledWith('Retry-After', 42);
      expect(logger.warn).toHaveBeenCalledWith(
        { keyType: 'ip', ip: '203.0.113.5' },
        'request throttled',
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(TOKEN);
    });
  });

  describe('skipped requests', () => {
    it('does not count GraphQL over websocket (no response object)', async () => {
      const { guard, storage } = await readyGuard();
      await expect(guard.canActivate(graphqlContext(request()))).resolves.toBe(true);
      expect(storage.increment).not.toHaveBeenCalled();
    });

    it.each([
      ['a class', SkippedController],
      ['a handler', SkippedHandlerController],
    ])('does not count a route whose %s is marked @SkipThrottle()', async (_name, controller) => {
      const { guard, storage, res } = await readyGuard();
      storage.increment.mockResolvedValue(BLOCKED);
      await expect(guard.canActivate(httpContext(request(), res, controller))).resolves.toBe(true);
      expect(storage.increment).not.toHaveBeenCalled();
    });
  });
});
