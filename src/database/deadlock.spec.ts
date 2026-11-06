import { isDeadlock } from './deadlock.js';

describe('isDeadlock', () => {
  it('recognises the MySQL deadlock error by errno or code', () => {
    expect(isDeadlock(Object.assign(new Error('Deadlock found'), { errno: 1213 }))).toBe(true);
    expect(
      isDeadlock(Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' })),
    ).toBe(true);
  });

  it('ignores other errors and non-objects', () => {
    expect(isDeadlock(Object.assign(new Error('Duplicate'), { errno: 1062 }))).toBe(false);
    expect(isDeadlock(new Error('boom'))).toBe(false);
    expect(isDeadlock(null)).toBe(false);
    expect(isDeadlock('ER_LOCK_DEADLOCK')).toBe(false);
  });
});
