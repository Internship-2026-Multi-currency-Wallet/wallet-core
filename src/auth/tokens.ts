import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../config/app-config.js';
import type { AccessTokenPayload } from './access-token.js';

// Staff permissions come with staff accounts (E1-8).
export const USER_PERMISSIONS: readonly string[] = ['wallet'];

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
}

export interface RefreshToken {
  /** Goes only to the client's cookie. */
  token: string;
  /** What the database stores. */
  hash: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  signAccessToken(userId: string, now: Date): IssuedAccessToken {
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + this.config.jwt.accessTtlSeconds;
    const payload: AccessTokenPayload = {
      sub: userId,
      permissions: [...USER_PERMISSIONS],
      iss: this.config.jwt.issuer,
      iat,
      exp,
    };
    const token = this.jwt.sign(payload, { secret: this.config.jwt.secret, algorithm: 'HS256' });
    return { token, expiresAt: new Date(exp * 1000) };
  }
}

export function newRefreshToken(): RefreshToken {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

// A random 256-bit token needs no slow hash: SHA-256 keeps it unguessable and lets the
// session be found by its unique index.
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
