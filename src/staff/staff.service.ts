import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { registerInputSchema } from '../auth/register.schema.js';
import { ROLE_PERMISSIONS, StaffRole } from './permissions.js';
import type { InviteStaffInput } from './staff.inputs.js';
import { StaffMe, StaffMember, StaffStatus } from './staff.model.js';
import { InsertStaffResult, type StaffRecord, StaffRepository } from './staff.repository.js';
import { STAFF_ERROR_MESSAGES, StaffErrorCode, staffError } from './staff-errors.js';

const INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

@Injectable()
export class StaffService {
  constructor(
    private readonly staff: StaffRepository,
    // Not `@InjectPinoLogger`: its provider only exists if this file loads before LoggingModule.
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(StaffService.name);
  }

  async invite(
    actorId: string,
    input: InviteStaffInput,
    now: Date = new Date(),
  ): Promise<StaffMember> {
    const email = parseEmail(input.email);
    const id = randomUUID();
    await this.staff.transaction(async (tx) => {
      const result = await tx.insert({ id, email, role: input.role, createdAt: now });
      if (result === InsertStaffResult.EmailTaken) {
        throw staffError(
          StaffErrorCode.StaffAlreadyExists,
          STAFF_ERROR_MESSAGES.staffAlreadyExists,
        );
      }
      await insertInvitation(tx, id, now);
    });
    this.logger.info(
      { audit: 'staff.invite', actorId, staffId: id, role: input.role },
      'staff action',
    );
    return { id, email, role: input.role, status: StaffStatus.INVITED, createdAt: now };
  }

  async resendInvitation(
    actorId: string,
    staffId: string,
    now: Date = new Date(),
  ): Promise<StaffMember> {
    const record = await this.staff.transaction(async (tx) => {
      const found = await findOrThrow(tx, staffId);
      if (found.status !== StaffStatus.INVITED) {
        throw staffError(StaffErrorCode.NotInvited, STAFF_ERROR_MESSAGES.notInvited);
      }
      await tx.expireInvitations(staffId, now);
      await insertInvitation(tx, staffId, now);
      return found;
    });
    this.logger.info({ audit: 'staff.resendInvitation', actorId, staffId }, 'staff action');
    return toMember(record);
  }

  async deactivate(actorId: string, staffId: string, now: Date = new Date()): Promise<StaffMember> {
    if (staffId === actorId) {
      throw staffError(
        StaffErrorCode.CannotDeactivateSelf,
        STAFF_ERROR_MESSAGES.cannotDeactivateSelf,
      );
    }
    const { record, changed } = await this.staff.transaction(async (tx) => {
      const target = await findOrThrow(tx, staffId);
      if (target.status === StaffStatus.DEACTIVATED) return { record: target, changed: false };
      if (target.status === StaffStatus.ACTIVE && target.role === StaffRole.ADMIN) {
        await assertNotLastAdmin(tx, staffId);
      }
      await tx.update(staffId, { status: StaffStatus.DEACTIVATED }, now);
      await tx.revokeSessions(staffId, now);
      return { record: { ...target, status: StaffStatus.DEACTIVATED }, changed: true };
    });
    if (changed) {
      this.logger.info({ audit: 'staff.deactivate', actorId, staffId }, 'staff action');
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
      const target = await findOrThrow(tx, staffId);
      if (target.role === role) return { before: target, record: target };
      if (target.status === StaffStatus.ACTIVE && target.role === StaffRole.ADMIN) {
        await assertNotLastAdmin(tx, staffId);
      }
      await tx.update(staffId, { role }, now);
      await tx.revokeSessions(staffId, now);
      return { before: target, record: { ...target, role } };
    });
    if (before.role !== role) {
      this.logger.info(
        { audit: 'staff.changeRole', actorId, staffId, from: before.role, to: role },
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

/** Throws LAST_ADMIN when the target is the only ACTIVE admin. Call inside a transaction. */
async function assertNotLastAdmin(tx: StaffRepository, staffId: string): Promise<void> {
  const admins = await tx.lockActiveAdminIds();
  if (admins.length === 1 && admins[0] === staffId) {
    throw staffError(StaffErrorCode.LastAdmin, STAFF_ERROR_MESSAGES.lastAdmin);
  }
}

function parseEmail(email: string): string {
  const result = registerInputSchema.shape.email.safeParse(email);
  if (result.success) return result.data;
  throw staffError(StaffErrorCode.BadUserInput, result.error.issues[0].message, { field: 'email' });
}

async function findOrThrow(repo: StaffRepository, staffId: string): Promise<StaffRecord> {
  const record = await repo.findById(staffId);
  if (!record) throw staffError(StaffErrorCode.StaffNotFound, STAFF_ERROR_MESSAGES.staffNotFound);
  return record;
}

/** One-time link: only its SHA-256 is stored. The token itself is neither returned nor logged. */
async function insertInvitation(tx: StaffRepository, staffId: string, now: Date): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await tx.insertInvitation({
    id: randomUUID(),
    staffId,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
    createdAt: now,
  });
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
