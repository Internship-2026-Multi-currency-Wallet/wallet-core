import { Module } from '@nestjs/common';
import { StaffAuthResolver } from './staff-auth.resolver.js';
import { StaffResolver } from './staff.resolver.js';

/** Staff accounts, roles, invitations and back-office login. */
@Module({
  providers: [StaffResolver, StaffAuthResolver],
})
export class StaffModule {}
