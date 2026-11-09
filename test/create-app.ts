import { Controller, Get, type INestApplication, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import type { AuthUser } from '../src/auth/auth-user.js';
import { CurrentUser } from '../src/auth/current-user.decorator.js';
import { AppConfig } from '../src/config/app-config.js';
import { configureApp } from '../src/configure-app.js';
import { RequirePermission } from '../src/permissions/require-permission.decorator.js';

/** HTTP-only test endpoints (kept out of the GraphQL schema on purpose). */
@Controller('__test')
class SeamsTestController {
  @Get('whoami')
  whoami(@CurrentUser() user: AuthUser): AuthUser {
    return user;
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
  await app.init();
  return app;
}
