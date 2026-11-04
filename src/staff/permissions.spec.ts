import { PERMISSIONS, ROLE_PERMISSIONS, StaffRole } from './permissions.js';

describe('ROLE_PERMISSIONS', () => {
  it('gives Admin every permission in the catalog', () => {
    expect([...ROLE_PERMISSIONS[StaffRole.ADMIN]].sort()).toEqual([
      'bo',
      'bo:settings',
      'bo:settings:modify',
      'bo:staff',
      'bo:staff:modify',
    ]);
    expect([...PERMISSIONS].sort()).toEqual([...ROLE_PERMISSIONS[StaffRole.ADMIN]].sort());
  });

  it.each([
    [StaffRole.SUPPORT, ['bo']],
    [StaffRole.COMPLIANCE, ['bo']],
    [StaffRole.FINANCE, ['bo', 'bo:settings', 'bo:settings:modify']],
  ])('gives %s exactly its agreed permissions', (role, expected) => {
    expect([...ROLE_PERMISSIONS[role]].sort()).toEqual(expected);
  });

  it('keeps staff management (bo:staff:modify) to Admin only', () => {
    const holders = Object.values(StaffRole).filter((role) =>
      ROLE_PERMISSIONS[role].includes('bo:staff:modify'),
    );
    expect(holders).toEqual([StaffRole.ADMIN]);
  });

  it('gives every role the base permission bo and nothing a user token carries', () => {
    for (const role of Object.values(StaffRole)) {
      expect(ROLE_PERMISSIONS[role]).toContain('bo');
      expect(ROLE_PERMISSIONS[role]).not.toContain('wallet');
    }
  });
});
