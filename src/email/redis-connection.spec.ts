import { describe, expect, it } from '@jest/globals';
import { queuePrefix } from './redis-connection.js';

describe('queuePrefix', () => {
  it('returns the env and rejects empty or colon-containing prefixes', () => {
    expect(queuePrefix('local')).toBe('local');
    expect(() => queuePrefix('')).toThrow();
    expect(() => queuePrefix('a:b')).toThrow();
  });
});
