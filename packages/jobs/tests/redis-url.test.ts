import { describe, expect, it } from 'vitest';

import { parseRedisUrl, redactRedisUrl } from '../src/redis-url';

describe('parseRedisUrl', () => {
  it('keeps the username, the password, the port and the db', () => {
    expect(parseRedisUrl('redis://app:s3cret@cache.example.com:6380/4')).toEqual({
      host: 'cache.example.com',
      port: 6380,
      username: 'app',
      password: 's3cret',
      db: 4,
    });
  });

  it('decodes a password with reserved characters', () => {
    expect(parseRedisUrl('redis://:p%40ss%3Aw%2Frd@localhost').password).toBe('p@ss:w/rd');
  });

  it('turns rediss into TLS with the host as server name', () => {
    expect(parseRedisUrl('rediss://cache.example.com').tls).toEqual({
      servername: 'cache.example.com',
    });
  });

  it('defaults the host and port and leaves the db unset', () => {
    expect(parseRedisUrl('redis://localhost')).toEqual({ host: 'localhost', port: 6379 });
  });

  it('reads an IPv6 host and the family parameter', () => {
    expect(parseRedisUrl('redis://[::1]:6390?family=6')).toEqual({
      host: '::1',
      port: 6390,
      family: 6,
    });
  });

  it('refuses another protocol, a bad db and a non-URL', () => {
    expect(() => parseRedisUrl('http://localhost')).toThrow(/redis:\/\/ or rediss:\/\//u);
    expect(() => parseRedisUrl('redis://localhost/abc')).toThrow(/not a whole number/u);
    expect(() => parseRedisUrl('localhost:6379')).toThrow(TypeError);
  });

  it('redacts the password for logs', () => {
    expect(redactRedisUrl('redis://app:s3cret@localhost:6379/1')).toBe(
      'redis://app:***@localhost:6379/1',
    );

    expect(redactRedisUrl('nonsense')).toBe('(invalid url)');
  });
});
