import { Inject, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { KNEX } from '../database/database.module.js';
import { isUniqueViolation } from '../database/unique-violation.js';

const ACCOUNTS = 'user_google_accounts';
const SUB_UNIQUE = 'user_google_accounts_google_sub_unique';
const USER_PRIMARY = 'PRIMARY';

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

  async findUserBySub(googleSub: string): Promise<GoogleLoginUser | null> {
    const row = await this.db(ACCOUNTS)
      .join('users', 'users.id', `${ACCOUNTS}.user_id`)
      .where(`${ACCOUNTS}.google_sub`, googleSub)
      .first<
        { id: string; email: string; phone: string | null; locked_until: Date | null } | undefined
      >('users.id', 'users.email', 'users.phone', 'users.locked_until');
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
