import { Inject, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { KNEX } from '../database/database.module.js';

const SESSIONS = 'sessions';

export interface NewSession {
  id: string;
  userId: string;
  /** SHA-256 hex of the refresh token; the token itself is only in the client's cookie. */
  refreshTokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

@Injectable()
export class SessionsRepository {
  constructor(@Inject(KNEX) private readonly db: Knex) {}

  async create(session: NewSession): Promise<void> {
    await this.db(SESSIONS).insert({
      id: session.id,
      user_id: session.userId,
      refresh_token_hash: session.refreshTokenHash,
      expires_at: session.expiresAt,
      created_at: session.createdAt,
    });
  }
}
