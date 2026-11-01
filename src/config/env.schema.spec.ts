import { AppConfig } from './app-config.js';
import { validateEnv } from './env.schema.js';

describe('validateEnv', () => {
  it('applies safe defaults', () => {
    const env = validateEnv({});
    expect(env.CLIENT).toBe('demo');
    expect(env.DEV_AUTH).toBe(false);
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

  it('rejects an invalid DEV_AUTH value', () => {
    expect(() => validateEnv({ DEV_AUTH: 'yes' })).toThrow(/DEV_AUTH/);
  });
});

describe('AppConfig', () => {
  it('exposes the current client and splits CORS origins', () => {
    const config = AppConfig.fromEnv({ CLIENT: 'wisla', CORS_ORIGINS: 'http://a, http://b' });
    expect(config.client).toBe('wisla');
    expect(config.corsOrigins).toEqual(['http://a', 'http://b']);
  });
});
