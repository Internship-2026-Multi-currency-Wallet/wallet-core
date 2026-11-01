import { Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppConfig } from '../config/app-config.js';
import { AUTH_STRATEGIES, type AuthStrategy } from './auth-strategy.js';
import { AuthGuard } from './auth.guard.js';
import { DevAuthStrategy } from './dev-auth.strategy.js';
import { MeResolver } from './me.resolver.js';
import { PermissionGuard } from '../permissions/permission.guard.js';

/**
 * Authentication seam.
 *
 * To add the real JWT login later, implement `AuthStrategy` (e.g. `JwtStrategy`), add it to
 * `providers` and to the `AUTH_STRATEGIES` factory below. Business code keeps using
 * `@CurrentUser()`, `@Public()` and `@RequirePermission()` unchanged.
 */
@Module({
  providers: [
    DevAuthStrategy,
    {
      provide: AUTH_STRATEGIES,
      inject: [AppConfig, DevAuthStrategy],
      useFactory: (config: AppConfig, dev: DevAuthStrategy): AuthStrategy[] => {
        const strategies: AuthStrategy[] = [];
        if (config.devAuth) {
          if (config.isProduction) {
            new Logger('AuthModule').warn('DEV_AUTH is enabled in production mode');
          }
          strategies.push(dev);
        }
        return strategies;
      },
    },
    // Order matters: authenticate first, then check permissions.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    MeResolver,
  ],
  exports: [AUTH_STRATEGIES],
})
export class AuthModule {}
