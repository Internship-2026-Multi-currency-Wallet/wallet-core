import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { AUTH_STRATEGIES, type AuthStrategy } from './auth-strategy.js';
import { AuthGuard } from './auth.guard.js';
import { AuthResolver } from './auth.resolver.js';
import { AuthService } from './auth.service.js';
import { DevAuthStrategy } from './dev-auth.strategy.js';
import { JwtAuthStrategy } from './jwt-auth.strategy.js';
import { MeResolver } from './me.resolver.js';
import { SessionsRepository } from './sessions.repository.js';
import { TokenService } from './tokens.js';
import { UsersRepository } from './users.repository.js';
import { PermissionGuard } from '../permissions/permission.guard.js';

@Module({
  imports: [JwtModule.register({})],
  providers: [
    DevAuthStrategy,
    JwtAuthStrategy,
    {
      provide: AUTH_STRATEGIES,
      inject: [AppConfig, JwtAuthStrategy, DevAuthStrategy, PinoLogger],
      useFactory: (
        config: AppConfig,
        jwt: JwtAuthStrategy,
        dev: DevAuthStrategy,
        logger: PinoLogger,
      ): AuthStrategy[] => {
        const strategies: AuthStrategy[] = [jwt];
        if (config.devAuth) {
          if (config.isProduction) {
            logger.setContext('AuthModule');
            logger.warn('DEV_AUTH is enabled in production mode');
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
    AuthResolver,
    AuthService,
    UsersRepository,
    SessionsRepository,
    TokenService,
  ],
  exports: [AUTH_STRATEGIES, TokenService],
})
export class AuthModule {}
