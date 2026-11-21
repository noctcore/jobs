import type { RedisOptions } from 'ioredis';

/**
 * Turns a `redis://` or `rediss://` URL into ioredis options, keeping every
 * part of it.
 *
 * The trap this exists for: a connection rebuilt from the URL's host and port
 * alone silently drops the password, the username, the db index and TLS. On a
 * Redis with `requirepass` every worker connection then fails `NOAUTH` and all
 * jobs wedge, while the app's own Redis client (handed the full URL) works, so
 * nothing looks wrong until the queue backs up.
 *
 * Workers need options rather than a client (each Worker opens and closes its
 * own connections), so the URL is parsed once here and every connection is
 * built from the same result.
 */
export function parseRedisUrl(url: string): RedisOptions {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError('redisUrl is not a valid URL (expected redis://host:port/db).');
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new TypeError(
      `redisUrl must use redis:// or rediss://, not ${parsed.protocol.replace(/:$/u, '')}://.`,
    );
  }

  const options: RedisOptions = {
    host: parsed.hostname.replace(/^\[(.*)\]$/u, '$1') || 'localhost',
    port: parsed.port === '' ? 6379 : Number(parsed.port),
  };

  if (parsed.username !== '') options.username = decodeURIComponent(parsed.username);
  if (parsed.password !== '') options.password = decodeURIComponent(parsed.password);

  const path = parsed.pathname.replace(/^\//u, '');

  if (path !== '') {
    const db = Number(path);

    if (!Number.isSafeInteger(db) || db < 0) {
      throw new TypeError(`redisUrl names db "${path}", which is not a whole number.`);
    }

    options.db = db;
  }

  // rediss:// is Redis over TLS. The server name is the host, so certificate
  // validation checks the name the app asked for.
  if (parsed.protocol === 'rediss:') options.tls = { servername: options.host ?? 'localhost' };

  const family = parsed.searchParams.get('family');

  if (family === '4' || family === '6') options.family = Number(family);

  return options;
}

/** The URL with its password replaced, safe to log. */
export function redactRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);

    if (parsed.password !== '') parsed.password = '***';

    return parsed.toString();
  } catch {
    return '(invalid url)';
  }
}
