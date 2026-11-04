import { Inject, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { KNEX } from '../database/database.module.js';
import type { User } from './user.model.js';

const SESSIONS = 'sessions';

export interface NewSession {
  id: string;
  userId: string;
  /** SHA-256 hex of the refresh token; the token itself is only in the client's cookie. */
  refreshTokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface ActiveSession {
  user: User;
  expiresAt: Date;
}

interface SessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
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

  // The lookup and replacement must hold the same row lock so concurrent refreshes cannot both
  // consume one token. The user is read in the same transaction: if that fails, the swap rolls
  // back and the client can retry with its token instead of losing the session.
  async rotate(
    refreshTokenHash: string,
    newRefreshTokenHash: string,
    now: Date,
  ): Promise<ActiveSession | null> {
    return this.db.transaction(async (trx) => {
      const row = await trx<SessionRow>(SESSIONS)
        .where({ refresh_token_hash: refreshTokenHash })
        .whereNull('revoked_at')
        .andWhere('expires_at', '>', now)
        .forUpdate()
        .first('id', 'user_id', 'expires_at');
      if (!row) return null;
      await trx(SESSIONS).where({ id: row.id }).update({ refresh_token_hash: newRefreshTokenHash });
      const user = await trx<User>('users')
        .where({ id: row.user_id })
        .first('id', 'email', 'phone');
      // Unreachable: a deleted user has no sessions (ON DELETE CASCADE).
      if (!user) throw new Error(`session ${row.id} has no user`);
      return { user, expiresAt: row.expires_at };
    });
  }

  async revoke(refreshTokenHash: string, now: Date): Promise<void> {
    await this.db(SESSIONS)
      .where({ refresh_token_hash: refreshTokenHash })
      .whereNull('revoked_at')
      .update({ revoked_at: now });
  }
}
