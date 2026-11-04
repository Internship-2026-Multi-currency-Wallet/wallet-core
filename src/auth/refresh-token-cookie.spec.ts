import { readRefreshToken } from './refresh-token-cookie.js';

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
