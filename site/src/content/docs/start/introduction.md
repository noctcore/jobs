---
title: Introduction
description: What @noctcore/jobs is, the BullMQ traps it closes, and when a different tool fits better.
---

BullMQ is a good queue. Most of the incidents I have had with it were not bugs in BullMQ but
defaults I forgot to change: a producer that hung a request for 20 seconds while Redis restarted, a
`removeOnComplete: true` that silently broke a dedupe, a retry storm with no jitter, a cron that
moved an hour when the clocks changed, a scheduler for a renamed job that kept firing for months, a
deploy that killed jobs halfway through.

`@noctcore/jobs` is a thin layer over BullMQ 6 for NestJS that makes those choices once. Each
default exists because of one of those traps, and each module starts with a comment that names it.
Underneath it is still BullMQ: the same Redis keys, the same `Queue`, `Worker` and `Job`, and
`queue.bull` when you need something this package does not wrap.

## The traps

| Trap | What the package does |
| --- | --- |
| An enqueue during a Redis outage hangs the request (ioredis queues commands offline and retries 20 times) | Producers use their own connection: no offline queue, one retry, a 3 s command timeout. While an outage is known `add()` refuses at once, and every `add()` is bounded by the timeout. [Connections](/jobs/guides/connections/) |
| Workers give up during a Redis restart | Workers use a separate connection with `maxRetriesPerRequest: null`, as BullMQ requires. |
| The password, username, db or TLS in `REDIS_URL` is dropped when a connection is built from host and port | Every connection is parsed from the whole URL; `rediss://` turns TLS on. |
| Retries without jitter turn one outage into a synchronised storm | A retrying policy needs a backoff from `expo()` or `fixed()`, jittered by default; a hand-written object or zero jitter does not compile. [Policies](/jobs/guides/queues-and-policies/) |
| Unbounded retries, or `attempts` read from config as any number | `attempts` is a literal from 2 to 20, or `'once'`. |
| `removeOnComplete: false` (or forgetting it) fills Redis | Retention for completed and failed jobs is required and always has an age. |
| A dedupe built on a caller `jobId` stops working once the job is removed | Every `add()` must choose a dedupe; caller jobIds do not exist; keys are hashed and a colon is refused. [Dedupe](/jobs/guides/dedupe/) |
| Mixed units: backoff in ms, retention age in seconds | Every duration is written with its unit (`'2s'`, `'14d'`) and converted where BullMQ reads it. |
| A worker loses the request id and the trace of the request that enqueued the job | `add()` stamps a context envelope; the worker validates it, re-enters it and opens a span. [Telemetry](/jobs/guides/telemetry/) |
| A failure alert fires on every attempt, or never | `onFinalFailure` and the error reporter run once, on the attempt that ends the job. [Workers](/jobs/guides/workers/) |
| A bug that no retry can fix spends every attempt | `classify()` or `fatal()` fails the job at once. |
| A provider's 429 is retried as a failure and burns attempts | `throw await this.pauseQueue(ms)` pauses the queue and hands the job back without spending an attempt. |
| A cron runs once per replica | Sweeps are BullMQ job schedulers: one job per tick, however many replicas upsert them. [Sweeps](/jobs/guides/sweeps/) |
| A renamed or deleted sweep keeps firing from Redis | At boot the sweeps queue is reconciled: schedulers no sweep declares are removed. |
| A cron moves with the server's time zone | `cron` needs `tz`. |
| A failing sweep is noticed weeks later | A failure counter, a last-success timestamp and an `onError` hook. |
| A deploy kills jobs halfway | `installGracefulShutdown` drains workers (bounded) before the app closes. [Shutdown](/jobs/guides/shutdown/) |

Each row has a test in the repository: unit tests for the types and the pure parts, and
integration suites against a real Redis for outages, retries, dedupe, pauses, sweeps and shutdown.

## When it is a bad fit

- **You already run Postgres and not Redis.** A Postgres queue such as
  [pg-boss](https://github.com/timgit/pg-boss) or [Graphile Worker](https://worker.graphile.org/)
  saves you a second datastore and lets a job be enqueued in the same transaction as the write that
  caused it.
- **You need durable multi-step workflows** (sagas, human approval steps, workflows that sleep for
  weeks). [Temporal](https://temporal.io/) or [Inngest](https://www.inngest.com/) model those
  directly; a queue of independent jobs does not.
- **You need flows, a dashboard or an outbox.** They are out of scope here. BullMQ's own flows, and
  dashboards that read BullMQ's keys, work alongside this package through `queue.bull`.

## Status

0.x: the API may change between minor versions. Pin an exact version and read the
[changelog](/jobs/reference/changelog/) before you upgrade. Releases are published to npm with
provenance.
