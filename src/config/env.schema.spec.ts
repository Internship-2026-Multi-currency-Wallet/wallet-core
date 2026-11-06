import { AppConfig } from './app-config.js';
import { LOCAL_JWT_SECRET, validateEnv } from './env.schema.js';

describe('validateEnv', () => {
  it('applies safe defaults', () => {
    const env = validateEnv({});
    expect(env.CLIENT).toBe('demo');
    expect(env.DEV_AUTH).toBe(false);
    expect(env.APP_ENV).toBe('local');
    expect(env.PORT).toBe(3000);
  });

  it('parses DEV_AUTH and CLIENT', () => {
    const env = validateEnv({ DEV_AUTH: 'true', CLIENT: 'kvitka', PORT: '4000' });
    expect(env.DEV_AUTH).toBe(true);
    expect(env.CLIENT).toBe('kvitka');
    expect(env.PORT).toBe(4000);
  });

  it('treats empty values as unset', () => {
    expect(validateEnv({ CLIENT: '' }).CLIENT).toBe('demo');
  });

  it('rejects an unknown client with a readable message', () => {
    expect(() => validateEnv({ CLIENT: 'acme' })).toThrow(/CLIENT/);
  });

  it('defaults APP_ENV to local and validates it', () => {
    expect(validateEnv({}).APP_ENV).toBe('local');
    expect(validateEnv({ APP_ENV: 'kvitka-uat' }).APP_ENV).toBe('kvitka-uat');
    expect(() => validateEnv({ APP_ENV: 'production' })).toThrow(/APP_ENV/);
  });

  it('allows DEV_AUTH=true on local and staging', () => {
    expect(validateEnv({ APP_ENV: 'local', DEV_AUTH: 'true' }).DEV_AUTH).toBe(true);
    expect(validateEnv({ APP_ENV: 'staging', DEV_AUTH: 'true' }).DEV_AUTH).toBe(true);
  });

  it('refuses DEV_AUTH=true in client UAT environments', () => {
    expect(() => validateEnv({ APP_ENV: 'kvitka-uat', DEV_AUTH: 'true' })).toThrow(
      /DEV_AUTH=true is not allowed in client environment "kvitka-uat"/,
    );
    expect(() => validateEnv({ APP_ENV: 'wisla-uat', DEV_AUTH: '1' })).toThrow(/DEV_AUTH/);
    expect(validateEnv({ APP_ENV: 'wisla-uat', DEV_AUTH: 'false' }).DEV_AUTH).toBe(false);
  });

  it('rejects an invalid DEV_AUTH value', () => {
    expect(() => validateEnv({ DEV_AUTH: 'yes' })).toThrow(/DEV_AUTH/);
  });
});

describe('validateEnv: JWT', () => {
  const SECRET = 'x'.repeat(32);

  it('turns the TTLs into seconds, 15m and 30d by default', () => {
    expect(validateEnv({})).toMatchObject({ JWT_ACCESS_TTL: 900, JWT_REFRESH_TTL: 2_592_000 });
    expect(validateEnv({ JWT_ACCESS_TTL: '30s', JWT_REFRESH_TTL: '12h' })).toMatchObject({
      JWT_ACCESS_TTL: 30,
      JWT_REFRESH_TTL: 43_200,
    });
  });

  it.each(['15', '15 m', '0m', '-5m', '1.5h', '15M', 'abc'])('rejects the TTL %p', (ttl) => {
    expect(() => validateEnv({ JWT_ACCESS_TTL: ttl })).toThrow(/JWT_ACCESS_TTL/);
  });

  it('accepts a TTL of up to 365 days', () => {
    expect(validateEnv({ JWT_REFRESH_TTL: '365d' }).JWT_REFRESH_TTL).toBe(31_536_000);
    expect(validateEnv({ JWT_REFRESH_TTL: '8760h' }).JWT_REFRESH_TTL).toBe(31_536_000);
  });

  it.each(['366d', '31536001s', '9999999d', `${'9'.repeat(309)}s`])(
    'rejects the TTL %p as longer than 365 days',
    (ttl) => {
      expect(() => validateEnv({ JWT_REFRESH_TTL: ttl })).toThrow(
        /JWT_REFRESH_TTL: must be at most 365d/,
      );
    },
  );

  it('refuses a JWT_SECRET shorter than 32 characters', () => {
    expect(() => validateEnv({ JWT_SECRET: 'x'.repeat(31) })).toThrow(
      /JWT_SECRET: must be at least 32 characters/,
    );
  });

  it('does not require JWT_SECRET outside production', () => {
    expect(validateEnv({ NODE_ENV: 'development' }).JWT_SECRET).toBeUndefined();
    expect(validateEnv({ NODE_ENV: 'test', JWT_SECRET: '' }).JWT_SECRET).toBeUndefined();
  });

  it('requires JWT_SECRET in production', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow(
      /JWT_SECRET: is required in production/,
    );
    expect(() => validateEnv({ NODE_ENV: 'production', JWT_SECRET: '' })).toThrow(
      /JWT_SECRET: is required in production/,
    );
    expect(validateEnv({ NODE_ENV: 'production', JWT_SECRET: SECRET }).JWT_SECRET).toBe(SECRET);
  });

  it('refuses the local-only secret in production', () => {
    expect(() => validateEnv({ NODE_ENV: 'production', JWT_SECRET: LOCAL_JWT_SECRET })).toThrow(
      /JWT_SECRET: must not be the local-only secret/,
    );
  });
});

describe('AppConfig', () => {
  it('exposes the current client and splits CORS origins', () => {
    const config = AppConfig.fromEnv({ CLIENT: 'wisla', CORS_ORIGINS: 'http://a, http://b' });
    expect(config.client).toBe('wisla');
    expect(config.corsOrigins).toEqual(['http://a', 'http://b']);
  });

  it('validates BACKOFFICE_URL as an http(s) URL and strips trailing slashes in AppConfig', () => {
    expect(validateEnv({}).BACKOFFICE_URL).toBe('http://localhost:5174');
    expect(() => validateEnv({ BACKOFFICE_URL: 'not a url' })).toThrow(/BACKOFFICE_URL/);
    expect(() => validateEnv({ BACKOFFICE_URL: 'ftp://x' })).toThrow(/BACKOFFICE_URL/);
    expect(AppConfig.fromEnv({}).backofficeUrl).toBe('http://localhost:5174');
    expect(AppConfig.fromEnv({ BACKOFFICE_URL: 'https://bo.example.com//' }).backofficeUrl).toBe(
      'https://bo.example.com',
    );
  });

  it('uses the local-only JWT secret when none is set', () => {
    expect(AppConfig.fromEnv({}).jwt).toEqual({
      issuer: 'wallet-core',
      secret: LOCAL_JWT_SECRET,
      accessTtlSeconds: 900,
      sessionTtlSeconds: 2_592_000,
    });
    expect(AppConfig.fromEnv({ JWT_SECRET: 'y'.repeat(32) }).jwt.secret).toBe('y'.repeat(32));
  });
});
