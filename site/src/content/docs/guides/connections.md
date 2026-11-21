---
title: Fail-fast enqueue and connections
description: Why producers and workers get opposite Redis policies on separate connections, how add() refuses during an outage, and how the Redis URL is parsed.
---

BullMQ wants opposite Redis policies from its two sides, so they get two connections.

## Producers fail fast

Every `queue.add()` runs on the producer connection, often on a request path. With ioredis's
defaults a command sent while Redis is down is queued offline and retried, so a sign-up or a
password reset hangs for the whole outage and the caller's error path never runs.

The producer connection:

- has no offline queue, so a command is rejected at once while Redis is unreachable;
- retries a command that was in flight when the connection dropped once, then gives up;
- bounds every command with a timeout (`producer.commandTimeoutMs`, 3000 ms by default), for a Redis
  that accepted the connection and never answers;
- keeps TCP keepalive at 30 s, so a dead peer on an idle socket is noticed in seconds.

On top of that, `add()` checks the connection first: while an outage is known it refuses at once,
and every `add()` as a whole is bounded by the same timeout. BullMQ waits for a connection's first
`ready` without a bound, so with Redis unreachable at boot (or a wrong password) a plain `add()`
would hang forever.

A refused or timed-out `add()` rejects with `EnqueueUnavailableError`. Catch it where the request
can do something useful instead: return a 503, write an outbox row, or tell the user to retry.

```ts
import { EnqueueUnavailableError } from '@noctcore/jobs';

try {
  await this.mail.add('welcome', { userId }, { dedupe: dedupe.window(['welcome', userId], '1d') });
} catch (error) {
  if (error instanceof EnqueueUnavailableError) throw new ServiceUnavailableException();
  throw error;
}
```

## Workers wait it out

Workers keep BullMQ's required `maxRetriesPerRequest: null` (its blocking reads must never be cut off
by a retry limit) and the offline queue, so they simply resume when Redis comes back. Each worker
builds its own connections from options and closes them itself.

## The whole URL, every time

Connections are parsed from the whole `redisUrl`: user, password, database number and TLS. A
connection built from host and port alone silently drops the rest. `rediss://` turns TLS on.

```
redis://user:pass@host:6379/2
rediss://default:pass@redis.example.com:6380
```

`parseRedisUrl(url)` and `redactRedisUrl(url)` are exported for your own clients and logs.

Never use ioredis's `keyPrefix` with BullMQ; set `prefix` on the module instead (default `bull`).

## Redis requirements

Redis must run with `maxmemory-policy noeviction`, as BullMQ requires: an evicted key can lose a job
or a lock.
