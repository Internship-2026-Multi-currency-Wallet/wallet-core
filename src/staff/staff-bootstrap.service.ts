import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { StaffRole } from './permissions.js';
import { StaffStatus } from './staff.model.js';
import { StaffRepository } from './staff.repository.js';
import { StaffService, parseEmail } from './staff.service.js';
import { StaffErrorCode } from './staff-errors.js';

export type CreateAdminResult =
  | { outcome: 'created' | 'resent'; staffId: string; link: string }
  | { outcome: 'exists' | 'adminExists' | 'emailTaken' | 'invalidEmail'; link?: undefined };

const BOOTSTRAP_ACTOR = 'system:bootstrap';
const CLI_ACTOR = 'system:cli';

/** Invites the first admin so a fresh deployment can be entered. */
@Injectable()
export class StaffBootstrapService implements OnApplicationBootstrap {
  constructor(
    private readonly staff: StaffService,
    private readonly repo: StaffRepository,
    private readonly config: AppConfig,
    // Not `@InjectPinoLogger`: it breaks boot in this repo (see StaffService).
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(StaffBootstrapService.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    const email = this.config.bootstrapAdminEmail;
    if (email === undefined) return;
    try {
      await this.bootstrapAdmin(email);
    } catch (err) {
      this.logger.error({ err }, 'bootstrap admin failed');
    }
  }

  async bootstrapAdmin(email: string, now: Date = new Date()): Promise<CreateAdminResult> {
    const normalized = this.normalize(email);
    if (normalized === undefined) {
      this.logger.warn({}, 'BOOTSTRAP_ADMIN_EMAIL is not a valid email, no admin invited');
      return { outcome: 'invalidEmail' };
    }
    if (await this.repo.anyAdminExists()) return { outcome: 'exists' };
    try {
      const { member, link } = await this.staff.inviteWithLink(
        BOOTSTRAP_ACTOR,
        { email: normalized, role: StaffRole.ADMIN },
        now,
      );
      this.logger.info({ staffId: member.id }, 'bootstrap admin invited');
      return { outcome: 'created', staffId: member.id, link };
    } catch (err) {
      if (isStaffAlreadyExists(err)) return { outcome: 'exists' };
      throw err;
    }
  }

  async createAdminOrReissue(email: string, now: Date = new Date()): Promise<CreateAdminResult> {
    const normalized = this.normalize(email);
    if (normalized === undefined) return { outcome: 'invalidEmail' };
    const existing = await this.repo.findByEmail(normalized);
    if (existing) {
      if (existing.status !== StaffStatus.INVITED || existing.role !== StaffRole.ADMIN) {
        return { outcome: 'emailTaken' };
      }
      const { link } = await this.staff.resendInvitationWithLink(CLI_ACTOR, existing.id, now);
      return { outcome: 'resent', staffId: existing.id, link };
    }
    if (await this.repo.anyAdminExists()) return { outcome: 'adminExists' };
    const { member, link } = await this.staff.inviteWithLink(
      CLI_ACTOR,
      { email: normalized, role: StaffRole.ADMIN },
      now,
    );
    return { outcome: 'created', staffId: member.id, link };
  }

  private normalize(email: string): string | undefined {
    try {
      return parseEmail(email);
    } catch {
      return undefined;
    }
  }
}

function isStaffAlreadyExists(err: unknown): boolean {
  return err instanceof GraphQLError && err.extensions.code === StaffErrorCode.StaffAlreadyExists;
}
