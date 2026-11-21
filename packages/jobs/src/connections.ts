import { Redis, type RedisOptions } from 'ioredis';

/**
 * BullMQ wants opposite Redis policies from its two sides, so they get two
 * connections.
 *
 * PRODUCERS (every `queue.add()`, often on a request path) fail fast:
 * `enableOfflineQueue: false` rejects a command at once while Redis is
 * unreachable, a bounded `maxRetriesPerRequest` gives up on one that was in
 * flight when the connection dropped, and `commandTimeout` bounds a command
 * sent to a Redis that accepted the connection and never answers. On the worker
 * policy ioredis holds the command and retries it forever, so a sign-up or a
 * password reset hangs for the whole outage and the caller's error path never
 * runs.
 *
 * WORKERS keep BullMQ's required `maxRetriesPerRequest: null` (its blocking
 * reads must never be cut off by a retry limit) and the offline queue, so they
 * simply resume when Redis comes back. Workers get options rather than a
 * client, so each Worker owns its connections and closes them itself.
 */

/** Default bound on one producer command, in milliseconds. */
export const DEFAULT_PRODUCER_COMMAND_TIMEOUT_MS = 3_000;

/** How often a producer command is retried across reconnects before it fails. */
const PRODUCER_MAX_RETRIES_PER_REQUEST = 1;

/** TCP keepalive, so a dead peer on an idle socket is noticed in seconds, not hours. */
const KEEPALIVE_MS = 30_000;

/** The options of the connection every queue (producer) shares. */
export function producerConnectionOptions(
  base: RedisOptions,
  commandTimeoutMs: number,
): RedisOptions {
  return {
    ...base,
    enableOfflineQueue: false,
    maxRetriesPerRequest: PRODUCER_MAX_RETRIES_PER_REQUEST,
    commandTimeout: commandTimeoutMs,
    keepAlive: KEEPALIVE_MS,
  };
}

/** The options each worker builds its own connections from. */
export function workerConnectionOptions(base: RedisOptions): RedisOptions {
  return {
    ...base,
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    keepAlive: KEEPALIVE_MS,
  };
}

/** The producer client. Construct it once per process and share it. */
export function createProducerConnection(base: RedisOptions, commandTimeoutMs: number): Redis {
  return new Redis(producerConnectionOptions(base, commandTimeoutMs));
}

/** How a client ended when it was closed. */
export type RedisCloseOutcome = 'quit' | 'not-connected' | 'dropped';

/** The part of an ioredis client `closeRedisClient` needs. */
export type ClosableRedis = Pick<Redis, 'status' | 'quit' | 'disconnect'>;

const NOT_CONNECTED = new Set(['wait', 'end']);

/**
 * Quits one client within `timeoutMs`, and drops its socket when it cannot.
 * Never rejects. A healthy Redis answers QUIT in milliseconds; a client whose
 * Redis is gone never gets the reply (and one in a reconnect loop would hold
 * QUIT forever), so without the bound a shutdown waits out the orchestrator's
 * grace period and ends in a SIGKILL.
 */
export async function closeRedisClient(
  client: ClosableRedis,
  timeoutMs: number,
): Promise<RedisCloseOutcome> {
  if (NOT_CONNECTED.has(client.status)) {
    client.disconnect();

    return 'not-connected';
  }

  if (client.status !== 'ready') {
    client.disconnect();

    return 'dropped';
  }

  let timer: NodeJS.Timeout | undefined;

  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });

  const quit = client.quit().then(
    () => 'quit' as const,
    () => 'failed' as const,
  );

  const result = await Promise.race([quit, timedOut]);

  clearTimeout(timer);

  if (result === 'quit') return 'quit';

  client.disconnect();

  return 'dropped';
}
