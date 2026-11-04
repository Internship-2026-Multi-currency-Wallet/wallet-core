/**
 * Staff permissions and roles: the only place they are defined. Documented in the README ("Staff roles").
 *
 * Only permissions that guard an endpoint today are listed. A new back-office feature adds its
 * permissions here (`bo:<area>` to view, `bo:<area>:modify` to change) and extends the roles below.
 */
export const PERMISSIONS = [
  /** Every staff member: staffMe, changeOwnStaffPassword. Never given to users. */
  'bo',
  /** staffMembers */
  'bo:staff',
  /** inviteStaff, resendStaffInvitation, deactivateStaff, changeStaffRole */
  'bo:staff:modify',
  /** staffSettings, settingHistory */
  'bo:settings',
  /** updateSetting, resetSetting */
  'bo:settings:modify',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export enum StaffRole {
  ADMIN = 'ADMIN',
  SUPPORT = 'SUPPORT',
  COMPLIANCE = 'COMPLIANCE',
  FINANCE = 'FINANCE',
}

/** Fixed permission lists per role. A staff token carries the list of its role. */
export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  [StaffRole.ADMIN]: PERMISSIONS,
  [StaffRole.SUPPORT]: ['bo'],
  [StaffRole.COMPLIANCE]: ['bo'],
  [StaffRole.FINANCE]: ['bo', 'bo:settings', 'bo:settings:modify'],
};
