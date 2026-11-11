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
 * Fixed permission lists per role. No role may receive `wallet`: `PermissionGuard` does not check the token
 * kind on client endpoints, so this is what keeps staff tokens off them (task 1220388983957407).
 */
export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  [StaffRole.ADMIN]: PERMISSIONS,
  [StaffRole.SUPPORT]: ['bo'],
  [StaffRole.COMPLIANCE]: ['bo'],
  [StaffRole.FINANCE]: ['bo', 'bo:settings', 'bo:settings:modify'],
};
