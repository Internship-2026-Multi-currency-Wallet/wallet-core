import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../config/app-config.js';

export const GOOGLE_AUTH_STATE_COOKIE = 'google_auth_state';
export const GOOGLE_AUTH_STATE_TTL_SECONDS = 10 * 60;
const AUDIENCE = 'google-auth-state';

export type GoogleAuthPurpose = 'link' | 'login';

export interface GoogleAuthStateIssued {
  state: string;
  nonce: string;
  expiresAt: Date;
  cookie: string;
}

interface StateClaims {
  purpose: GoogleAuthPurpose;
  uid?: string;
  state: string;
  nonce: string;
}

@Injectable()
export class GoogleAuthStateService {
  // Derived, so this token can never pass as an access token signed with JWT_SECRET.
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {
    this.secret = createHmac('sha256', config.jwt.secret).update(AUDIENCE).digest('base64url');
  }

  issue(purpose: GoogleAuthPurpose, userId: string | null, now: Date): GoogleAuthStateIssued {
    const claims: StateClaims = {
      purpose,
      ...(userId === null ? {} : { uid: userId }),
      state: randomBytes(32).toString('base64url'),
      nonce: randomBytes(32).toString('base64url'),
    };
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + GOOGLE_AUTH_STATE_TTL_SECONDS;
    const cookie = this.jwt.sign(
      { ...claims, iat, exp },
      {
        secret: this.secret,
        algorithm: 'HS256',
        audience: AUDIENCE,
        issuer: this.config.jwt.issuer,
      },
    );
    return { state: claims.state, nonce: claims.nonce, expiresAt: new Date(exp * 1000), cookie };
  }

  check(
    cookie: string | undefined,
    expected: { purpose: GoogleAuthPurpose; userId: string | null; state: string },
    now: Date,
  ): string | null {
    if (!cookie) return null;
    let claims: StateClaims;
    try {
      claims = this.jwt.verify<StateClaims>(cookie, {
        secret: this.secret,
        algorithms: ['HS256'],
        audience: AUDIENCE,
        issuer: this.config.jwt.issuer,
        clockTimestamp: Math.floor(now.getTime() / 1000),
      });
    } catch {
      return null;
    }
    const sameUser = (claims.uid ?? null) === expected.userId;
    if (claims.purpose !== expected.purpose || !sameUser || !equal(claims.state, expected.state)) {
      return null;
    }
    return claims.nonce;
  }
}

export function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
