import { STAFF_REFRESH_TOKEN_COOKIE, readRefreshToken } from './refresh-token-cookie.js';

describe('readRefreshToken', () => {
  it('reads the refresh token among other cookies', () => {
    expect(
      readRefreshToken({ headers: { cookie: 'theme=dark; refresh_token=abc-123_x; a=b' } }),
    ).toBe('abc-123_x');
  });

  it.each([
    ['no Cookie header', {}],
    ['no refresh token cookie', { cookie: 'theme=dark' }],
    ['an empty refresh token', { cookie: 'refresh_token=' }],
  ])('returns undefined for %s', (_case, headers) => {
    expect(readRefreshToken({ headers })).toBeUndefined();
  });
});

describe('readRefreshToken with another cookie name', () => {
  it('reads only the named cookie', () => {
    const req = { headers: { cookie: 'refresh_token=user; staff_refresh_token=staff' } };
    expect(readRefreshToken(req, STAFF_REFRESH_TOKEN_COOKIE)).toBe('staff');
    expect(readRefreshToken(req)).toBe('user');
  });
});
