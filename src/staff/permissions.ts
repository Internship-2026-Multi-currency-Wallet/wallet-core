/** Staff permissions and roles (README, "Staff roles"). Add a permission only with its endpoint, and update the roles below. */
export const PERMISSIONS = [
  /** Base permission of every staff member. Never given to users. */
  'bo',
  'bo:staff',
  'bo:staff:modify',
  'bo:settings',
  'bo:settings:modify',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export enum StaffRole {
  ADMIN = 'ADMIN',
  SUPPORT = 'SUPPORT',
  COMPLIANCE = 'COMPLIANCE',
  FINANCE = 'FINANCE',
}

/**
 * Fixed permission lists per role. No role may receive `wallet`. `PermissionGuard` also refuses staff tokens
 * on client endpoints; this is the first of the two locks.
 */
export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  [StaffRole.ADMIN]: PERMISSIONS,
  [StaffRole.SUPPORT]: ['bo'],
  [StaffRole.COMPLIANCE]: ['bo'],
  [StaffRole.FINANCE]: ['bo', 'bo:settings', 'bo:settings:modify'],
};
