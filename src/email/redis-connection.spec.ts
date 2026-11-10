import { describe, expect, it } from '@jest/globals';
import { queuePrefix, redisConnectionOptions } from './redis-connection.js';

describe('redisConnectionOptions', () => {
  it('parses host, port, credentials and db', () => {
    expect(redisConnectionOptions('redis://u:p%40ss@cache.local:6380/2')).toMatchObject({
      host: 'cache.local',
      port: 6380,
      username: 'u',
      password: 'p@ss',
      db: 2,
    });
  });

  it('defaults the port, leaves db unset and enables tls for rediss', () => {
    const o = redisConnectionOptions('rediss://cache.local', { maxRetriesPerRequest: null });
    expect(o).toMatchObject({
      host: 'cache.local',
      port: 6379,
      tls: {},
      maxRetriesPerRequest: null,
    });
    expect((o as { db?: number }).db).toBeUndefined();
  });
});

describe('queuePrefix', () => {
  it('returns the env and rejects empty or colon-containing prefixes', () => {
    expect(queuePrefix('local')).toBe('local');
    expect(() => queuePrefix('')).toThrow();
    expect(() => queuePrefix('a:b')).toThrow();
  });
});
