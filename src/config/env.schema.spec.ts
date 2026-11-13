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

describe('validateEnv: EMAIL_PREVIEW_ENABLED', () => {
  it('is off by default', () => {
    expect(validateEnv({}).EMAIL_PREVIEW_ENABLED).toBe(false);
  });

  it('allows true on local and staging', () => {
    expect(
      validateEnv({ APP_ENV: 'local', EMAIL_PREVIEW_ENABLED: 'true' }).EMAIL_PREVIEW_ENABLED,
    ).toBe(true);
    expect(
      validateEnv({ APP_ENV: 'staging', EMAIL_PREVIEW_ENABLED: 'true' }).EMAIL_PREVIEW_ENABLED,
    ).toBe(true);
  });

  it.each(['kvitka-uat', 'wisla-uat'])('refuses true in %s', (appEnv) => {
    expect(() => validateEnv({ APP_ENV: appEnv, EMAIL_PREVIEW_ENABLED: 'true' })).toThrow(
      /EMAIL_PREVIEW_ENABLED/,
    );
    expect(
      validateEnv({ APP_ENV: appEnv, EMAIL_PREVIEW_ENABLED: 'false' }).EMAIL_PREVIEW_ENABLED,
    ).toBe(false);
  });
});

describe('validateEnv: email', () => {
  const SECRET = 'x'.repeat(32);
  const KEY = 're_secret_key_value';
  const deployedEnvs = ['staging', 'kvitka-uat', 'wisla-uat'];

  it('defaults to smtp to the local Mailpit', () => {
    expect(validateEnv({})).toMatchObject({
      EMAIL_TRANSPORT: 'smtp',
      SMTP_URL: 'smtp://localhost:1025',
      EMAIL_FROM: 'no-reply@wallet.shatori.com',
    });
    expect(AppConfig.fromEnv({}).email).toEqual({
      transport: 'smtp',
      from: 'no-reply@wallet.shatori.com',
      resendApiKey: undefined,
      smtpUrl: 'smtp://localhost:1025',
    });
  });

  it.each([{}, { RESEND_API_KEY: '' }])('requires RESEND_API_KEY for resend (%j)', (extra) => {
    expect(() => validateEnv({ EMAIL_TRANSPORT: 'resend', ...extra })).toThrow(/RESEND_API_KEY/);
  });

  it('rejects a whitespace-only RESEND_API_KEY without echoing it', () => {
    const blank = ' \t ';
    let message = '';
    try {
      validateEnv({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: blank });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/RESEND_API_KEY/);
    expect(message).not.toContain(blank);
  });

  it('exposes the Resend key on AppConfig', () => {
    const config = AppConfig.fromEnv({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: KEY });
    expect(config.email.transport).toBe('resend');
    expect(config.email.resendApiKey).toBe(KEY);
  });

  describe.each(deployedEnvs)('in production %s', (appEnv) => {
    const base = {
      NODE_ENV: 'production',
      APP_ENV: appEnv,
      JWT_SECRET: SECRET,
      BACKOFFICE_URL: 'https://bo.example.com',
    };

    it.each(['smtp', 'fake', undefined])('refuses transport %p', (transport) => {
      expect(() => validateEnv({ ...base, EMAIL_TRANSPORT: transport })).toThrow(
        /EMAIL_TRANSPORT.*resend/,
      );
    });

    it('accepts resend with a key', () => {
      expect(
        validateEnv({ ...base, EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: KEY }).EMAIL_TRANSPORT,
      ).toBe('resend');
    });
  });

  it.each(['test', 'development'])('allows fake on staging with NODE_ENV=%s', (nodeEnv) => {
    expect(
      validateEnv({ NODE_ENV: nodeEnv, APP_ENV: 'staging', EMAIL_TRANSPORT: 'fake' })
        .EMAIL_TRANSPORT,
    ).toBe('fake');
  });

  it('allows smtp with APP_ENV=local even in production', () => {
    expect(
      validateEnv({
        NODE_ENV: 'production',
        APP_ENV: 'local',
        JWT_SECRET: SECRET,
        BACKOFFICE_URL: 'https://bo.example.com',
        EMAIL_TRANSPORT: 'smtp',
      }).EMAIL_TRANSPORT,
    ).toBe('smtp');
  });

  it.each([
    { EMAIL_FROM: 'not-an-email' },
    { SMTP_URL: 'http://localhost:1025' },
    { EMAIL_TRANSPORT: 'sendgrid' },
  ])('rejects %j', (bad) => {
    expect(() => validateEnv(bad)).toThrow();
  });

  it('never puts the API key in the error message', () => {
    let message = '';
    try {
      validateEnv({ EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: KEY, EMAIL_FROM: 'bad' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/EMAIL_FROM/);
    expect(message).not.toContain(KEY);
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
    expect(
      validateEnv({
        NODE_ENV: 'production',
        JWT_SECRET: SECRET,
        BACKOFFICE_URL: 'https://bo.example.com',
      }).JWT_SECRET,
    ).toBe(SECRET);
  });

  it('refuses the local-only secret in production', () => {
    expect(() => validateEnv({ NODE_ENV: 'production', JWT_SECRET: LOCAL_JWT_SECRET })).toThrow(
      /JWT_SECRET: must not be the local-only secret/,
    );
  });
});

describe('validateEnv: throttling', () => {
  const NAMES = [
    'THROTTLE_TTL_SECONDS',
    'THROTTLE_LIMIT_ANONYMOUS',
    'THROTTLE_LIMIT_USER',
  ] as const;

  it('defaults to a 60 second window, 120 anonymous and 600 user requests', () => {
    expect(validateEnv({})).toMatchObject({
      THROTTLE_TTL_SECONDS: 60,
      THROTTLE_LIMIT_ANONYMOUS: 120,
      THROTTLE_LIMIT_USER: 600,
    });
  });

  it.each(NAMES)('parses %s from a string', (name) => {
    expect(validateEnv({ [name]: '30' })[name]).toBe(30);
  });

  describe.each(NAMES)('%s', (name) => {
    it.each(['0', '-1', '1.5', 'abc'])('rejects %p', (value) => {
      expect(() => validateEnv({ [name]: value })).toThrow(new RegExp(name));
    });
  });
});

describe('AppConfig', () => {
  it('exposes the current client and splits CORS origins', () => {
    const config = AppConfig.fromEnv({ CLIENT: 'wisla', CORS_ORIGINS: 'http://a, http://b' });
    expect(config.client).toBe('wisla');
    expect(config.corsOrigins).toEqual(['http://a', 'http://b']);
  });

  it.each([
    'https://bo.example.com/#/',
    'https://bo.example.com/?a=1',
    'https://bo.example.com/?',
    'https://bo.example.com#',
  ])('rejects BACKOFFICE_URL %s with a query or a fragment', (url) => {
    expect(() => validateEnv({ BACKOFFICE_URL: url })).toThrow(
      /BACKOFFICE_URL.*must not contain a query or a fragment/s,
    );
  });

  it.each(['https://bo.example.com', 'https://bo.example.com/', 'https://bo.example.com/app/'])(
    'accepts BACKOFFICE_URL %s',
    (url) => {
      expect(validateEnv({ BACKOFFICE_URL: url }).BACKOFFICE_URL).toBe(url);
    },
  );

  describe('BACKOFFICE_URL in production', () => {
    const production = { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32) };

    it.each([undefined, ''])('is required (%p)', (value) => {
      expect(() => validateEnv({ ...production, BACKOFFICE_URL: value })).toThrow(
        /BACKOFFICE_URL: is required when NODE_ENV=production/,
      );
    });

    it.each([
      'http://localhost:5174',
      'https://LOCALHOST/admin',
      'http://127.0.0.1:8080',
      'http://[::1]:5174/bo',
      'http://0.0.0.0',
      'http://localhost.:5174',
      'http://127.0.0.2:5174',
      'http://127.255.255.254',
      'http://app.localhost',
      'http://LOCALHOST./x',
    ])('refuses the local host %s', (url) => {
      expect(() => validateEnv({ ...production, BACKOFFICE_URL: url })).toThrow(
        /BACKOFFICE_URL: must not point to a local host/,
      );
    });

    it.each([
      'https://127.example.com',
      'https://notlocalhost.example.com',
      'https://localhost.example.com',
    ])('accepts the non-local host %s', (url) => {
      const env = {
        ...production,
        EMAIL_TRANSPORT: 'fake',
        BACKOFFICE_URL: url,
      };
      expect(validateEnv(env).BACKOFFICE_URL).toBe(url);
    });

    it.each(['staging', 'local'])('accepts a real URL with APP_ENV=%s', (appEnv) => {
      const env = {
        ...production,
        APP_ENV: appEnv,
        EMAIL_TRANSPORT: 'fake',
        BACKOFFICE_URL: 'https://bo.example.com',
      };
      // fake transport is refused in deployed environments only
      if (appEnv === 'staging')
        Object.assign(env, { EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_key' });
      expect(validateEnv(env).BACKOFFICE_URL).toBe('https://bo.example.com');
    });

    it('keeps the localhost default and accepts a local host outside production', () => {
      expect(validateEnv({ NODE_ENV: 'development' }).BACKOFFICE_URL).toBe('http://localhost:5174');
      expect(
        validateEnv({ NODE_ENV: 'test', BACKOFFICE_URL: 'http://127.0.0.1:5174' }).BACKOFFICE_URL,
      ).toBe('http://127.0.0.1:5174');
    });

    it('reports an invalid URL once', () => {
      expect(() => validateEnv({ ...production, BACKOFFICE_URL: 'not a url' })).not.toThrow(
        /local host/,
      );
    });
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

  it('groups the rate-limit settings', () => {
    expect(AppConfig.fromEnv({ THROTTLE_LIMIT_USER: '50' }).throttle).toEqual({
      ttlSeconds: 60,
      limitAnonymous: 120,
      limitUser: 50,
    });
  });

  it('allows METRICS_PORT=0 only in tests', () => {
    expect(validateEnv({ NODE_ENV: 'test', METRICS_PORT: '0' }).METRICS_PORT).toBe(0);
    expect(() => validateEnv({ NODE_ENV: 'production', METRICS_PORT: '0' })).toThrow(
      /METRICS_PORT/,
    );
    expect(() => validateEnv({ METRICS_PORT: '0' })).toThrow(/METRICS_PORT/);
  });
});

describe('BOOTSTRAP_ADMIN_EMAIL', () => {
  it('is undefined when unset or empty', () => {
    expect(AppConfig.fromEnv({}).bootstrapAdminEmail).toBeUndefined();
    expect(AppConfig.fromEnv({ BOOTSTRAP_ADMIN_EMAIL: '' }).bootstrapAdminEmail).toBeUndefined();
  });

  it('is trimmed', () => {
    expect(AppConfig.fromEnv({ BOOTSTRAP_ADMIN_EMAIL: '  a@b.co  ' }).bootstrapAdminEmail).toBe(
      'a@b.co',
    );
  });

  it('does not stop the app when the value is not an email', () => {
    expect(AppConfig.fromEnv({ BOOTSTRAP_ADMIN_EMAIL: 'not-an-email' }).bootstrapAdminEmail).toBe(
      'not-an-email',
    );
  });
});

describe('Google OAuth client', () => {
  it('is optional: nothing is configured by default', () => {
    expect(AppConfig.fromEnv({}).google).toEqual({ clientId: undefined, clientSecret: undefined });
  });

  it('exposes the client id and secret on AppConfig', () => {
    const config = AppConfig.fromEnv({
      GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'GOCSPX-test',
    });
    expect(config.google).toEqual({
      clientId: '123-abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-test',
    });
  });

  it('treats empty values as not set', () => {
    expect(AppConfig.fromEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }).google).toEqual({
      clientId: undefined,
      clientSecret: undefined,
    });
  });

  it('refuses a secret without a client id, without echoing the secret', () => {
    let message = '';
    try {
      validateEnv({ GOOGLE_CLIENT_SECRET: 'GOCSPX-test' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/GOOGLE_CLIENT_ID/);
    expect(message).not.toContain('GOCSPX-test');
  });
});
