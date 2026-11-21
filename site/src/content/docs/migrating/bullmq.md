---
title: Migrating from raw BullMQ
description: Map Queue, Worker, jobId, deduplication, schedulers and rate limits from BullMQ to @noctcore/jobs, and the two differences to plan for.
---

The Redis keys are BullMQ's own, so existing queues keep their jobs. Move one queue at a time.

| BullMQ | Here |
| --- | --- |
| `new Queue(name, { connection, defaultJobOptions })` | `defineQueue(name, policy)` plus `JobsModule.forFeature([queue])` |
| `queue.add(name, data, { jobId })` | `queue.add(name, data, { dedupe: dedupe.until(key) })` |
| `{ deduplication: { id, ttl } }` | `dedupe.window(key, ttl)` |
| `new Worker(name, processor, { concurrency })` | `@Worker(queue) class extends JobHost` with `concurrency` in the policy |
| `worker.on('failed')` plus an `attemptsMade` check | `onFinalFailure` |
| `queue.upsertJobScheduler(...)` in `onModuleInit` | `@Sweep(name, schedule)` |
| `worker.rateLimit(ms); throw Worker.RateLimitError()` | `throw await this.pauseQueue(ms)` |
| `connection: { host, port }` | `redisUrl` |
| `{ removeOnComplete: true }` | `keep: { completed: '1h', failed: '14d' }` |
| `{ attempts: 3, backoff: { type: 'exponential', delay: 1000 } }` | `attempts: 3, backoff: expo('1s')` (jittered) |

## Two differences to plan for

- **Job data gains a `_jobs` key** when a context hook or tracing is configured. Workers built with
  this package strip it before `handle()`; a worker still on raw BullMQ sees it in `job.data`.
- **Dedupe ids are hashes**, so a window opened by the old code does not block the new code. Expect
  one duplicate per window that is open when you switch.

## Steps for one queue

1. Write the queue's `defineQueue` with the attempts, backoff and retention it has today, made
   explicit. Keep the same queue name and `prefix`.
2. Replace its `add()` calls, choosing a dedupe for each. Where the old code passed a `jobId` for
   uniqueness, `dedupe.until(key)` is the closest match.
3. Move the processor into a `JobHost` class and its `failed` listener into `onFinalFailure`.
4. Deploy, and stop the old worker for that queue in the same deploy: two workers on one queue both
   take jobs.

`queue.bull` is the underlying BullMQ `Queue` for anything this package does not wrap (flows,
inspection, a dashboard).
