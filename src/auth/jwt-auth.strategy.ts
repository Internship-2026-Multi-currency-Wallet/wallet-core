import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { KIND_BY_AUDIENCE, accessTokenPayloadSchema } from './access-token.js';
import type { AuthRequest, AuthStrategy } from './auth-strategy.js';
import type { AuthUser } from './auth-user.js';

const BEARER = /^Bearer\s+(\S+)$/i;

@Injectable()
export class JwtAuthStrategy implements AuthStrategy {
  readonly name = 'jwt';

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: AppConfig,
    @InjectPinoLogger(JwtAuthStrategy.name) private readonly logger: PinoLogger,
  ) {}

  async authenticate({ authorization }: AuthRequest): Promise<AuthUser | null> {
    const token = authorization ? BEARER.exec(authorization.trim())?.[1] : undefined;
    if (!token) return null;

    let decoded: unknown;
    try {
      decoded = await this.jwtService.verifyAsync<object>(token, {
        secret: this.config.jwt.secret,
        algorithms: ['HS256'],
        issuer: this.config.jwt.issuer,
      });
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        this.logger.debug({ expiredAt: error.expiredAt }, 'access token expired');
        throw new UnauthorizedException('Access token expired');
      }
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn({ reason }, 'access token rejected');
      throw new UnauthorizedException('Invalid access token');
    }

    const payload = accessTokenPayloadSchema.safeParse(decoded);
    if (!payload.success) {
      const claims = payload.error.issues.map((issue) => issue.path.join('.'));
      this.logger.warn({ reason: 'invalid claims', claims }, 'access token rejected');
      throw new UnauthorizedException('Invalid access token');
    }

    return {
      id: payload.data.sub,
      // From aud only, never from the permissions: a client token with "bo" is still a client.
      kind: KIND_BY_AUDIENCE[payload.data.aud],
      permissions: [...new Set(payload.data.permissions)],
      strategy: this.name,
    };
  }
}
