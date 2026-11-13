import { Inject, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { isDeadlock } from '../database/deadlock.js';
import { KNEX } from '../database/database.module.js';
import { isUniqueViolation } from '../database/unique-violation.js';

const ACCOUNTS = 'user_google_accounts';
const SUB_UNIQUE = 'user_google_accounts_google_sub_unique';
const USER_PRIMARY = 'PRIMARY';
const MAX_TRANSACTION_ATTEMPTS = 3;

export interface LinkedGoogleAccount {
  userId: string;
  googleSub: string;
  email: string;
  linkedAt: Date;
}

export interface GoogleLoginUser {
  id: string;
  email: string;
  phone: string | null;
  lockedUntil: Date | null;
}

export const LinkGoogleResult = {
  Linked: 'linked',
  GoogleAccountTaken: 'googleAccountTaken',
  UserHasGoogleAccount: 'userHasGoogleAccount',
} as const;

export type LinkGoogleResult = (typeof LinkGoogleResult)[keyof typeof LinkGoogleResult];

interface AccountRow {
  user_id: string;
  google_sub: string;
  email: string;
  linked_at: Date;
}

@Injectable()
export class GoogleAccountsRepository {
  constructor(@Inject(KNEX) private readonly db: Knex) {}

  async insert(account: LinkedGoogleAccount): Promise<LinkGoogleResult> {
    try {
      await this.db(ACCOUNTS).insert({
        user_id: account.userId,
        google_sub: account.googleSub,
        email: account.email,
        linked_at: account.linkedAt,
      });
      return LinkGoogleResult.Linked;
    } catch (error) {
      if (isUniqueViolation(error, SUB_UNIQUE)) return LinkGoogleResult.GoogleAccountTaken;
      if (isUniqueViolation(error, USER_PRIMARY)) return LinkGoogleResult.UserHasGoogleAccount;
      throw error;
    }
  }

  async findByUser(userId: string): Promise<LinkedGoogleAccount | null> {
    const row = await this.db<AccountRow>(ACCOUNTS).where({ user_id: userId }).first();
    return row ? toAccount(row) : null;
  }

  async transaction<T>(
    work: (accounts: GoogleAccountsRepository, trx: Knex.Transaction) => Promise<T>,
  ): Promise<T> {
    // A login and an unlink lock the same link row through different indexes, so InnoDB may pick one
    // of them to break a deadlock; running it again is safe.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.db.transaction((trx) => work(new GoogleAccountsRepository(trx), trx));
      } catch (error) {
        if (attempt >= MAX_TRANSACTION_ATTEMPTS || !isDeadlock(error)) throw error;
      }
    }
  }

  /**
   * Call inside `transaction`: holds the link until it commits, so a parallel unlink waits for the
   * session to exist and then ends it, instead of leaving it behind.
   */
  async lockUserBySub(googleSub: string): Promise<GoogleLoginUser | null> {
    const link = await this.db<AccountRow>(ACCOUNTS)
      .where({ google_sub: googleSub })
      .forUpdate()
      .first('user_id');
    if (!link) return null;
    const row = await this.db('users')
      .where({ id: link.user_id })
      .first<
        { id: string; email: string; phone: string | null; locked_until: Date | null } | undefined
      >('id', 'email', 'phone', 'locked_until');
    if (!row) return null;
    return { id: row.id, email: row.email, phone: row.phone, lockedUntil: row.locked_until };
  }

  async deleteByUser(userId: string): Promise<boolean> {
    return (await this.db(ACCOUNTS).where({ user_id: userId }).delete()) > 0;
  }
}

function toAccount(row: AccountRow): LinkedGoogleAccount {
  return {
    userId: row.user_id,
    googleSub: row.google_sub,
    email: row.email,
    linkedAt: row.linked_at,
  };
}
