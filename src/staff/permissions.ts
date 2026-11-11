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

/** Fixed permission lists per role. A staff token carries its role list; no role may get `wallet`, the only thing keeping staff tokens off client endpoints (PermissionGuard checks no kind there; task 1220388983957407). */
export const ROLE_PERMISSIONS: Record<StaffRole, readonly Permission[]> = {
  [StaffRole.ADMIN]: PERMISSIONS,
  [StaffRole.SUPPORT]: ['bo'],
  [StaffRole.COMPLIANCE]: ['bo'],
  [StaffRole.FINANCE]: ['bo', 'bo:settings', 'bo:settings:modify'],
};
