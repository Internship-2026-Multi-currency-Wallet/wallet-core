import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { AppModule } from '../src/app.module.js';
import type { AuthUser } from '../src/auth/auth-user.js';
import { CurrentUser } from '../src/auth/current-user.decorator.js';
import { AppConfig } from '../src/config/app-config.js';
import { configureApp } from '../src/configure-app.js';
import { useRequestMetrics } from '../src/metrics/request-metrics.js';
import { RequirePermission } from '../src/permissions/require-permission.decorator.js';
import { REDIS } from '../src/redis/redis.module.js';

/** HTTP-only test endpoints (kept out of the GraphQL schema on purpose). */
@Controller('__test')
class SeamsTestController {
  @Get('whoami')
  whoami(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  @RequirePermission('wallet')
  @Get('wallet')
  wallet(): { ok: true } {
    return { ok: true };
  }

  @RequirePermission('bo:users:modify')
  @Get('modify-users')
  modifyUsers(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [SeamsTestController] })
class SeamsTestModule {}

/** Boots the real AppModule (+ test endpoints) with optional env overrides. */
export async function createApp(env: Record<string, string> = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, SeamsTestModule] })
    .overrideProvider(AppConfig)
    .useValue(AppConfig.fromEnv({ ...process.env, ...env }))
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: ['error', 'warn'],
  });
  configureApp(app);
  useRequestMetrics(app);
  await app.init();
  return app;
}

/**
 * For tests whose first request needs Redis: the client connects in the background after init, and
 * until then health reports it DOWN and the rate limit fails open.
 */
export async function waitForRedis(app: INestApplication, timeoutMs = 5000): Promise<void> {
  const redis = app.get<Redis>(REDIS);
  if (redis.status === 'ready') return;
  let onReady = (): void => undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      onReady = resolve;
      redis.once('ready', onReady);
      timer = setTimeout(
        () => reject(new Error(`Redis not ready after ${timeoutMs} ms (status: ${redis.status})`)),
        timeoutMs,
      );
    });
  } finally {
    clearTimeout(timer);
    redis.off('ready', onReady);
  }
}
