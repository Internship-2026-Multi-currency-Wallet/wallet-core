import { isClientPermission, isStaffPermission } from './user-kind.js';

describe('isStaffPermission', () => {
  it.each(['bo', 'bo:settings', 'bo:staff:modify'])(
    'takes %s as a staff permission',
    (permission) => {
      expect(isStaffPermission(permission)).toBe(true);
    },
  );

  it.each(['wallet', 'bonus', 'boss:bo', ''])(
    'does not take "%s" as a staff permission',
    (permission) => {
      expect(isStaffPermission(permission)).toBe(false);
    },
  );
});

describe('isClientPermission', () => {
  it.each(['wallet', 'wallet:transfers'])('takes %s as a client permission', (permission) => {
    expect(isClientPermission(permission)).toBe(true);
  });

  it.each(['wallets', 'walletbo', 'bo', 'bo:users', ''])(
    'does not take "%s" as a client permission',
    (permission) => {
      expect(isClientPermission(permission)).toBe(false);
    },
  );
});
