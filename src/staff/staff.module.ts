import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StaffAuthResolver } from './staff-auth.resolver.js';
import { StaffRepository } from './staff.repository.js';
import { StaffBootstrapService } from './staff-bootstrap.service.js';
import { StaffResolver } from './staff.resolver.js';
import { StaffService } from './staff.service.js';

/** Staff accounts, roles, invitations and back-office login. */
@Module({
  imports: [AuthModule],
  providers: [
    StaffResolver,
    StaffAuthResolver,
    StaffService,
    StaffRepository,
    StaffBootstrapService,
  ],
})
export class StaffModule {}
