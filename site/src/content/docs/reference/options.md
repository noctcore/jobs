---
title: Module options
description: Every option of JobsModule.forRoot and forRootAsync, with its default.
---

`JobsModule.forRoot(options)` or `JobsModule.forRootAsync({ imports, inject, useFactory })`
registers a global module. `JobsModule.forFeature([queues])` makes each queue injectable with
`@InjectQueue(queue)`.

| Option | Default | |
| --- | --- | --- |
| `redisUrl` | required | `redis://user:pass@host:6379/2`, or `rediss://` for TLS |
| `prefix` | `bull` | BullMQ's key prefix. Never use ioredis's `keyPrefix` with BullMQ |
| `workers` | `true` | `false` on replicas that only enqueue |
| `producer.commandTimeoutMs` | `3000` | Bound on one Redis command and on one `add()` |
| `telemetry` | none | `{ metrics, tracing, errors }`, see [Telemetry](/jobs/guides/telemetry/) |
| `context` | none | A `JobContextHook` that carries your request context into workers |
| `sweeps.queue` | `jobs-sweeps` | One per app |
| `sweeps.concurrency` | `1` | Sweeps one process runs at once |
| `sweeps.reconcile` | `true` | Remove schedulers no sweep declares |
| `sweeps.onError` | none | Called after a sweep fails |
| `shutdown.drainTimeoutMs` | `20000` | How long draining waits for running jobs |

## Exported defaults

| Constant | Value |
| --- | --- |
| `DEFAULT_PRODUCER_COMMAND_TIMEOUT_MS` | `3000` |
| `DEFAULT_DRAIN_TIMEOUT_MS` | `20000` |
| `DEFAULT_SHUTDOWN_DEADLINE_MS` | `25000` |
| `DEFAULT_SWEEPS_QUEUE` | `'jobs-sweeps'` |
| `DEFAULT_JITTER` | `0.5` |
| `DEFAULT_DURATION_BUCKETS` | `[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300]` |

Every export, with its type, is in the [API reference](/jobs/reference/api/).
