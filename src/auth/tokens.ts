import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../config/app-config.js';
import type { AccessTokenPayload, TokenAudience } from './access-token.js';

export const USER_PERMISSIONS: readonly string[] = ['wallet'];

export interface AccessTokenSubject {
  userId: string;
  aud: TokenAudience;
  permissions: readonly string[];
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
}

export interface RefreshToken {
  /** Goes only to the client's cookie. */
  token: string;
  /** Persist only the hash so a database leak does not expose usable refresh tokens. */
  hash: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  signAccessToken({ userId, aud, permissions }: AccessTokenSubject, now: Date): IssuedAccessToken {
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + this.config.jwt.accessTtlSeconds;
    const payload: AccessTokenPayload = {
      sub: userId,
      aud,
      permissions: [...permissions],
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
