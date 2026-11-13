import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../config/app-config.js';
import { GoogleAuthStateService } from './google-auth-state.js';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const USER_ID = '00000000-0000-4000-8000-000000000001';
const config = AppConfig.fromEnv({});

describe('GoogleAuthStateService', () => {
  const states = new GoogleAuthStateService(new JwtService(), config);

  it('issues a fresh state and nonce every time', () => {
    const first = states.issue('login', null, NOW);
    const second = states.issue('login', null, NOW);
    expect(first.state).not.toBe(second.state);
    expect(first.nonce).not.toBe(second.nonce);
  });

  it('accepts the state of its own cookie until it expires', () => {
    const issued = states.issue('link', USER_ID, NOW);
    const expected = { purpose: 'link' as const, userId: USER_ID, state: issued.state };
    expect(states.check(issued.cookie, expected, NOW)).toBe(issued.nonce);
    expect(states.check(issued.cookie, expected, new Date(NOW.getTime() + 9 * 60 * 1000))).toBe(
      issued.nonce,
    );
    expect(states.check(issued.cookie, expected, new Date(NOW.getTime() + 11 * 60 * 1000))).toBe(
      null,
    );
  });

  it.each([
    ['another purpose', { purpose: 'login' as const, userId: USER_ID }],
    ['another user', { purpose: 'link' as const, userId: 'someone-else' }],
    ['no user', { purpose: 'link' as const, userId: null }],
  ])('refuses %s', (_name, expected) => {
    const issued = states.issue('link', USER_ID, NOW);
    expect(states.check(issued.cookie, { ...expected, state: issued.state }, NOW)).toBeNull();
  });

  it('refuses a login sign-in for a user', () => {
    const issued = states.issue('login', null, NOW);
    expect(
      states.check(issued.cookie, { purpose: 'login', userId: USER_ID, state: issued.state }, NOW),
    ).toBeNull();
  });

  it('is signed with a key of its own: never valid as an access token signed with JWT_SECRET', () => {
    const issued = states.issue('link', USER_ID, NOW);
    expect(() => {
      new JwtService().verify(issued.cookie, { secret: config.jwt.secret, algorithms: ['HS256'] });
    }).toThrow(/invalid signature/);
  });

  it('refuses a missing cookie, even with the right state', () => {
    const issued = states.issue('login', null, NOW);
    expect(
      states.check(undefined, { purpose: 'login', userId: null, state: issued.state }, NOW),
    ).toBe(null);
  });
});
