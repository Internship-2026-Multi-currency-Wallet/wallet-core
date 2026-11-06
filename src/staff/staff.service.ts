import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { EMAIL_SENDER, EmailTemplate, type EmailSender } from '../email/email-sender.js';
import { registerInputSchema } from '../auth/register.schema.js';
import { ROLE_PERMISSIONS, StaffRole } from './permissions.js';
import type { InviteStaffInput } from './staff.inputs.js';
import { StaffMe, StaffMember, StaffStatus } from './staff.model.js';
import { InsertStaffResult, type StaffRecord, StaffRepository } from './staff.repository.js';
import { STAFF_ERROR_MESSAGES, StaffErrorCode, staffError } from './staff-errors.js';

export interface InvitationResult {
  member: StaffMember;
  link: string;
}

const INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

@Injectable()
export class StaffService {
  constructor(
    private readonly staff: StaffRepository,
    // Not `@InjectPinoLogger`: its provider only exists if this file loads before LoggingModule.
    private readonly logger: PinoLogger,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    private readonly config: AppConfig,
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
  ): Promise<InvitationResult> {
    const { record, token } = await this.staff.transaction(async (tx) => {
      const found = await lockOrThrow(tx, staffId);
      if (found.status !== StaffStatus.INVITED) {
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
      await this.email.send({ template: EmailTemplate.StaffInvitation, to, data: { link } });
    } catch (err) {
      this.logger.warn({ err, staffId }, 'invitation email failed');
    }
    return link;
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
    const record = await findOrThrow(this.staff, actorId);
    return {
      id: record.id,
      email: record.email,
      role: record.role,
      permissions: [...ROLE_PERMISSIONS[record.role]],
    };
  }
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
