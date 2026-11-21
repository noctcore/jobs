---
'@noctcore/jobs': minor
---

First release: BullMQ 6 for NestJS with the safe choice made the default.

> **Pre-1.0.** The API may change between minor versions. Pin an exact version.

### Highlights

- **Policies that refuse unsafe options at compile time.** `defineQueue(name, policy)` requires attempts, a jittered backoff (`expo()` or `fixed()`), bounded retention for completed and failed jobs, and a concurrency. One attempt has to be spelled `'once'`; unbounded retention, retries without a backoff and a backoff without jitter do not type-check.
- **Dedupe is a required choice on every enqueue.** `queue.add(name, data, { dedupe })` takes `dedupe.window(key, ttl)`, `dedupe.until(key)`, `dedupe.debounce(key, wait)` or `dedupe.none()`. Keys are hashed with SHA-256, a colon is refused, and there is no caller-built `jobId`, so a dedupe never depends on how long a job is retained.
- **Two Redis connection policies.** Producers fail fast (no offline queue, one retry, a command timeout, and an immediate refusal while an outage is known), so a request never hangs on an enqueue. Workers keep BullMQ's never-give-up policy. Every connection is built from the whole `redisUrl`: password, username, db and TLS included.
- **`@Worker(queue)` with a `JobHost` base.** Typed jobs, the producer's context and trace carried into the worker, a span per attempt, duration and failure metrics, `onFinalFailure` called once when a job fails for good, and errors classified as retryable or fatal.
- **`@Sweep(name, { cron, tz } | { every })` on BullMQ job schedulers.** One run per tick however many replicas run, stale schedulers removed at boot, and a failure counter, a last-success timestamp and an error hook built in.
- **`QueuePause` and graceful shutdown.** A pause never shortens a longer one that is running, and `installGracefulShutdown(app)` drains workers (bounded) before the app closes, then closes the queues and the producer connection, flushes telemetry and re-raises the signal.
- **Telemetry without vendor dependencies.** `prometheusMetrics(promClient)`, `openTelemetryTracing(otelApi)` and `sentryReporter(Sentry)` adapt the vendor module you already have.
