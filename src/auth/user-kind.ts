export enum UserKind {
  CLIENT = 'client',
  STAFF = 'staff',
}

/** `bo` and `bo:…` only: `startsWith('bo')` would also take a client permission like `bonus`. */
export function isStaffPermission(permission: string): boolean {
  return permission === 'bo' || permission.startsWith('bo:');
}

/** `wallet` and `wallet:…` only, like `isStaffPermission`. */
export function isClientPermission(permission: string): boolean {
  return permission === 'wallet' || permission.startsWith('wallet:');
}
