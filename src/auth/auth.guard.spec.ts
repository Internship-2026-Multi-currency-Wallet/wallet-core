import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthStrategy } from './auth-strategy.js';
import { AuthGuard } from './auth.guard.js';
import { DevAuthStrategy } from './dev-auth.strategy.js';
import { Public } from './public.decorator.js';
import type { RequestLike } from './request-context.js';

class TestController {
  @Public()
  open(): void {}

  closed(): void {}
}

function httpContext(handler: keyof TestController, request: RequestLike): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => TestController.prototype[handler],
    getClass: () => TestController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
  const reflector = new Reflector();

  describe('with DEV_AUTH enabled (dev strategy registered)', () => {
    const guard = new AuthGuard(reflector, [new DevAuthStrategy()]);

    it('authenticates a dev header and stores the user on the request', async () => {
      const request: RequestLike = { headers: { authorization: 'Dev 5:wallet' } };
      await expect(guard.canActivate(httpContext('closed', request))).resolves.toBe(true);
      expect(request.user).toEqual({ id: '5', permissions: ['wallet'], strategy: 'dev' });
    });

    it('rejects requests without credentials', async () => {
      await expect(guard.canActivate(httpContext('closed', { headers: {} }))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects malformed dev credentials', async () => {
      const request = { headers: { authorization: 'Dev :wallet' } };
      await expect(guard.canActivate(httpContext('closed', request))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('lets anonymous callers reach @Public() handlers', async () => {
      await expect(guard.canActivate(httpContext('open', { headers: {} }))).resolves.toBe(true);
    });

    it('still identifies the user on @Public() handlers', async () => {
      const request: RequestLike = { headers: { authorization: 'Dev 9' } };
      await guard.canActivate(httpContext('open', request));
      expect(request.user?.id).toBe('9');
    });
  });

  describe('with DEV_AUTH disabled and no real strategy', () => {
    const guard = new AuthGuard(reflector, []);

    it('rejects even a valid dev header', async () => {
      const request = { headers: { authorization: 'Dev 1:wallet' } };
      await expect(guard.canActivate(httpContext('closed', request))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('allows @Public() handlers', async () => {
      await expect(guard.canActivate(httpContext('open', { headers: {} }))).resolves.toBe(true);
    });
  });

  it('tries strategies in order, so a real strategy can be added without touching callers', async () => {
    const jwtLike: AuthStrategy = {
      name: 'jwt',
      authenticate: ({ authorization }) =>
        authorization === 'Bearer good' ? { id: 'u1', permissions: [], strategy: 'jwt' } : null,
    };
    const guard = new AuthGuard(reflector, [jwtLike, new DevAuthStrategy()]);

    const jwtRequest: RequestLike = { headers: { authorization: 'Bearer good' } };
    await guard.canActivate(httpContext('closed', jwtRequest));
    expect(jwtRequest.user?.strategy).toBe('jwt');

    const devRequest: RequestLike = { headers: { authorization: 'Dev 2' } };
    await guard.canActivate(httpContext('closed', devRequest));
    expect(devRequest.user?.strategy).toBe('dev');
  });
});
