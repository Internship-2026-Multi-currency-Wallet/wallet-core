import { isStaffPermission } from './user-kind.js';

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
