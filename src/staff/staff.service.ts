import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import type { GraphQLError } from 'graphql';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { EmailService } from '../email/email.service.js';
import { LOGIN_LOCK_MS, MAX_FAILED_LOGINS } from '../auth/auth.service.js';
import { PASSWORD_MAX_LENGTH, registerInputSchema } from '../auth/register.schema.js';
import { TokenService, hashRefreshToken, newRefreshToken } from '../auth/tokens.js';
import { ROLE_PERMISSIONS, StaffRole } from './permissions.js';
import type {
  AcceptStaffInvitationInput,
  InviteStaffInput,
  StaffLoginInput,
} from './staff.inputs.js';
import { StaffAuthPayload, StaffMe, StaffMember, StaffStatus } from './staff.model.js';
import { InsertStaffResult, type StaffRecord, StaffRepository } from './staff.repository.js';
import { STAFF_ERROR_MESSAGES, StaffErrorCode, staffError } from './staff-errors.js';

export interface InvitationResult {
  member: StaffMember;
  link: string;
}

const INVITATION_TTL_MS = 48 * 60 * 60 * 1000;
export const STAFF_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface StaffLoginResult {
  payload: StaffAuthPayload;
  /** For the cookie only; never part of the response body. */
  refreshToken: string;
  sessionExpiresAt: Date;
}

@Injectable()
export class StaffService {
  // Verified against for an unusable account, so the answer takes as long as for a real one.
  private readonly dummyHash: Promise<string> = hash(randomBytes(16).toString('hex'));

  constructor(
    private readonly staff: StaffRepository,
    // Not `@InjectPinoLogger`: its provider only exists if this file loads before LoggingModule.
    private readonly logger: PinoLogger,
    private readonly email: EmailService,
    private readonly config: AppConfig,
    private readonly tokens: TokenService,
  ) {
    logger.setContext(StaffService.name);
  }

  async invite(
    actorId: string,
    input: InviteStaffInput,
    now: Date = new Date(),
  ): Promise<StaffMember> {
    return (await this.inviteWithLink(actorId, input, now)).member;
  }

  async inviteWithLink(
    actorId: string,
    input: InviteStaffInput,
    now: Date = new Date(),
  ): Promise<InvitationResult> {
    return (await this.createInvitation(actorId, input, now, false))!;
  }

  async inviteFirstAdmin(
    actorId: string,
    email: string,
    now: Date = new Date(),
  ): Promise<InvitationResult | undefined> {
    return this.createInvitation(actorId, { email, role: StaffRole.ADMIN }, now, true);
  }

  private async createInvitation(
    actorId: string,
    input: InviteStaffInput,
    now: Date,
    onlyIfNoAdmin: boolean,
  ): Promise<InvitationResult | undefined> {
    const email = parseEmail(input.email);
    const id = randomUUID();
    const token = await this.staff.transaction(async (tx) => {
      if (onlyIfNoAdmin && (await tx.lockAdminIds()).length > 0) return undefined;
      const result = await tx.insert({ id, email, role: input.role, createdAt: now });
      if (result === InsertStaffResult.EmailTaken) {
        throw staffError(
          StaffErrorCode.StaffAlreadyExists,
          STAFF_ERROR_MESSAGES.staffAlreadyExists,
        );
      }
      return insertInvitation(tx, id, now);
    });
    if (token === undefined) return undefined;
    const link = await this.sendInvitation(id, email, token);
    this.logger.info(
      { audit: 'staff.invite', actorId, staffId: id, role: input.role },
      'staff action',
    );
    return {
      member: { id, email, role: input.role, status: StaffStatus.INVITED, createdAt: now },
      link,
    };
  }

  async resendInvitation(
    actorId: string,
    staffId: string,
    now: Date = new Date(),
  ): Promise<StaffMember> {
    return (await this.resendInvitationWithLink(actorId, staffId, now)).member;
  }

  async resendInvitationWithLink(
    actorId: string,
    staffId: string,
    now: Date = new Date(),
    expectedRole?: StaffRole,
  ): Promise<InvitationResult> {
    const { record, token } = await this.staff.transaction(async (tx) => {
      const found = await lockOrThrow(tx, staffId);
      if (
        found.status !== StaffStatus.INVITED ||
        (expectedRole !== undefined && found.role !== expectedRole)
      ) {
        throw staffError(StaffErrorCode.NotInvited, STAFF_ERROR_MESSAGES.notInvited);
      }
      await tx.expireInvitations(found.id, now);
      return { record: found, token: await insertInvitation(tx, found.id, now) };
    });
    const link = await this.sendInvitation(record.id, record.email, token);
    this.logger.info(
      { audit: 'staff.resendInvitation', actorId, staffId: record.id },
      'staff action',
    );
    return { member: toMember(record), link };
  }

  /** Runs after the commit; a failed email must not fail the mutation, the admin can resend. */
  private async sendInvitation(staffId: string, to: string, token: string): Promise<string> {
    const link = `${this.config.backofficeUrl}/accept-invitation?token=${token}`;
    try {
      await this.email.send('staffInvitation', to, { link });
    } catch (err) {
      this.logger.warn({ err, staffId }, 'invitation email failed');
    }
    return link;
  }

  async acceptInvitation(
    input: AcceptStaffInvitationInput,
    clock: () => Date = () => new Date(),
  ): Promise<void> {
    const password = registerInputSchema.shape.password.safeParse(input.password);
    if (!password.success) {
      throw staffError(StaffErrorCode.BadUserInput, password.error.issues[0].message, {
        field: 'password',
      });
    }
    const tokenHash = createHash('sha256').update(input.token).digest('hex');
    // Dead tokens must not cost an argon2 hash or the admin locks.
    const id = await this.staff.findInvitationStaffId(tokenHash, clock());
    if (id === undefined) throw invalidInvitation();
    const passwordHash = await hash(password.data);
    const staffId = await this.staff.transaction(async (tx) => {
      await tx.lockActiveAdminIds();
      const member = await tx.lockById(id);
      // Read after the locks: a resend committed while argon2 ran must win.
      const now = clock();
      if (member?.status !== StaffStatus.INVITED) throw invalidInvitation();
      if ((await tx.consumeInvitation(tokenHash, now)) === null) throw invalidInvitation();
      await tx.activate(member.id, passwordHash, now);
      return member.id;
    });
    this.logger.info(
      { audit: 'staff.acceptInvitation', actorId: staffId, staffId },
      'staff action',
    );
  }

  async login(
    input: StaffLoginInput,
    previousRefreshToken?: string,
    now: Date = new Date(),
  ): Promise<StaffLoginResult> {
    if (input.password.length > PASSWORD_MAX_LENGTH) throw invalidCredentials();

    const found = await this.staff.findByEmail(input.email.trim().toLowerCase());
    if (found?.status !== StaffStatus.ACTIVE || found.passwordHash === null) {
      await verify(await this.dummyHash, input.password);
      this.logger.warn('staff login rejected: unknown or unusable account');
      throw invalidCredentials();
    }
    // Checked before the password, so a locked account does not tell whether a guess was right.
    if (found.lockedUntil && found.lockedUntil > now) {
      this.logger.warn({ staffId: found.id }, 'staff login rejected: account locked');
      throw accountLocked(found.lockedUntil);
    }

    const verifiedHash = found.passwordHash;
    if (!(await verify(verifiedHash, input.password))) {
      const lockedUntil = await this.staff.recordFailedLogin(found.id, {
        now,
        maxFailedAttempts: MAX_FAILED_LOGINS,
        lockDurationMs: LOGIN_LOCK_MS,
      });
      this.logger.warn({ staffId: found.id, locked: lockedUntil !== null }, 'staff login rejected');
      throw lockedUntil ? accountLocked(lockedUntil) : invalidCredentials();
    }

    const refreshToken = newRefreshToken();
    const sessionExpiresAt = new Date(now.getTime() + STAFF_SESSION_TTL_MS);
    // The session is inserted under the row lock that deactivation and role changes also take,
    // after rechecking what argon2 ran against.
    const row = await this.staff.transaction(async (tx) => {
      const locked = await tx.lockById(found.id);
      if (locked?.status !== StaffStatus.ACTIVE || locked.passwordHash !== verifiedHash) {
        throw invalidCredentials();
      }
      if (locked.lockedUntil && locked.lockedUntil > now) throw accountLocked(locked.lockedUntil);
      await tx.resetFailedLogins(locked.id, now);
      await tx.createSession({
        id: randomUUID(),
        staffId: locked.id,
        refreshTokenHash: refreshToken.hash,
        expiresAt: sessionExpiresAt,
        createdAt: now,
      });
      if (previousRefreshToken) {
        await tx.revokeSessionByHash(hashRefreshToken(previousRefreshToken), now);
      }
      return locked;
    });

    // Built from the locked row, so a role change committed after the first read is honoured.
    const staff = toMe(row);
    const access = this.tokens.signAccessToken(
      { userId: row.id, aud: 'backoffice', permissions: staff.permissions },
      now,
    );
    this.logger.info({ staffId: row.id }, 'staff logged in');
    return {
      payload: { accessToken: access.token, accessTokenExpiresAt: access.expiresAt, staff },
      refreshToken: refreshToken.token,
      sessionExpiresAt,
    };
  }

  async logout(refreshToken: string | undefined, now: Date = new Date()): Promise<void> {
    if (refreshToken) await this.staff.revokeSessionByHash(hashRefreshToken(refreshToken), now);
  }

  async deactivate(actorId: string, staffId: string, now: Date = new Date()): Promise<StaffMember> {
    const { record, changed } = await this.staff.transaction(async (tx) => {
      const admins = await tx.lockActiveAdminIds();
      const target = await lockOrThrow(tx, staffId);
      // Ids are case-insensitive in MySQL, so compare them in lower case.
      if (target.id.toLowerCase() === actorId.toLowerCase()) {
        throw staffError(
          StaffErrorCode.CannotDeactivateSelf,
          STAFF_ERROR_MESSAGES.cannotDeactivateSelf,
        );
      }
      if (target.status === StaffStatus.DEACTIVATED) return { record: target, changed: false };
      if (target.status === StaffStatus.ACTIVE && target.role === StaffRole.ADMIN) {
        assertNotLastAdmin(admins, target.id);
      }
      await tx.update(target.id, { status: StaffStatus.DEACTIVATED }, now);
      await tx.revokeSessions(target.id, now);
      await tx.expireInvitations(target.id, now);
      return { record: { ...target, status: StaffStatus.DEACTIVATED }, changed: true };
    });
    if (changed) {
      this.logger.info({ audit: 'staff.deactivate', actorId, staffId: record.id }, 'staff action');
    }
    return toMember(record);
  }

  async changeRole(
    actorId: string,
    staffId: string,
    role: StaffRole,
    now: Date = new Date(),
  ): Promise<StaffMember> {
    const { before, record } = await this.staff.transaction(async (tx) => {
      const admins = await tx.lockActiveAdminIds();
      const target = await lockOrThrow(tx, staffId);
      if (target.role === role) return { before: target, record: target };
      if (target.status === StaffStatus.ACTIVE && target.role === StaffRole.ADMIN) {
        assertNotLastAdmin(admins, target.id);
      }
      await tx.update(target.id, { role }, now);
      await tx.revokeSessions(target.id, now);
      return { before: target, record: { ...target, role } };
    });
    if (before.role !== role) {
      this.logger.info(
        { audit: 'staff.changeRole', actorId, staffId: record.id, from: before.role, to: role },
        'staff action',
      );
    }
    return toMember(record);
  }

  async list(): Promise<StaffMember[]> {
    return (await this.staff.list()).map(toMember);
  }

  async me(actorId: string): Promise<StaffMe> {
    return toMe(await findOrThrow(this.staff, actorId));
  }
}

function toMe(record: StaffRecord): StaffMe {
  return {
    id: record.id,
    email: record.email,
    role: record.role,
    permissions: [...ROLE_PERMISSIONS[record.role]],
  };
}

function invalidCredentials(): GraphQLError {
  return staffError(StaffErrorCode.InvalidCredentials, STAFF_ERROR_MESSAGES.invalidCredentials);
}

function accountLocked(lockedUntil: Date): GraphQLError {
  return staffError(StaffErrorCode.AccountLocked, STAFF_ERROR_MESSAGES.accountLocked(lockedUntil), {
    lockedUntil: lockedUntil.toISOString(),
  });
}

/** `admins` must come from `lockActiveAdminIds` in the same transaction. */
function assertNotLastAdmin(admins: string[], staffId: string): void {
  if (admins.length === 1 && admins[0] === staffId) {
    throw staffError(StaffErrorCode.LastAdmin, STAFF_ERROR_MESSAGES.lastAdmin);
  }
}

export function parseEmail(email: string): string {
  const result = registerInputSchema.shape.email.safeParse(email);
  if (result.success) return result.data;
  throw staffError(StaffErrorCode.BadUserInput, result.error.issues[0].message, { field: 'email' });
}

/** One message for every cause, so a link reveals nothing about its state. */
function invalidInvitation(): GraphQLError {
  return staffError(StaffErrorCode.InvalidInvitation, STAFF_ERROR_MESSAGES.invalidInvitation);
}

async function findOrThrow(repo: StaffRepository, staffId: string): Promise<StaffRecord> {
  const record = await repo.findById(staffId);
  if (!record) throw staffError(StaffErrorCode.StaffNotFound, STAFF_ERROR_MESSAGES.staffNotFound);
  return record;
}

async function lockOrThrow(tx: StaffRepository, staffId: string): Promise<StaffRecord> {
  const record = await tx.lockById(staffId);
  if (!record) throw staffError(StaffErrorCode.StaffNotFound, STAFF_ERROR_MESSAGES.staffNotFound);
  return record;
}

/** Invitation tokens are credentials: only their SHA-256 is stored, and the plaintext goes only into the invitation link. */
async function insertInvitation(tx: StaffRepository, staffId: string, now: Date): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await tx.insertInvitation({
    id: randomUUID(),
    staffId,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    createdAt: now,
  });
  return token;
}

function toMember(record: StaffRecord): StaffMember {
  return {
    id: record.id,
    email: record.email,
    role: record.role,
    status: record.status,
    createdAt: record.createdAt,
  };
}
