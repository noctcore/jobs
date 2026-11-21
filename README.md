<div align="center">
  <h1>noctcore jobs</h1>

  <p><strong>BullMQ 6 for NestJS with the safe choice made the default: typed queues, required dedupe, bounded retries and retention, sweeps that run once per tick, and a shutdown that waits for running jobs.</strong></p>

  <p>
    <a href="https://github.com/noctcore/jobs/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/noctcore/jobs/ci.yml?branch=main&style=flat&label=ci" alt="CI status"></a>
    <a href="https://scorecard.dev/viewer/?uri=github.com/noctcore/jobs"><img src="https://api.scorecard.dev/projects/github.com/noctcore/jobs/badge" alt="OpenSSF Scorecard"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3b4a8c?style=flat" alt="MIT license"></a>
    <a href="#status"><img src="https://img.shields.io/badge/status-0.x-b45309?style=flat" alt="Status: 0.x"></a>
    <img src="https://img.shields.io/badge/node-%3E%3D22-3b4a8c?style=flat" alt="Node 22 or later">
  </p>

  <p>
    <a href="#quick-start"><strong>Quick start</strong></a>
    &nbsp;·&nbsp;
    <a href="#the-traps"><strong>The traps</strong></a>
    &nbsp;·&nbsp;
    <a href="CONTRIBUTING.md"><strong>Contributing</strong></a>
    &nbsp;·&nbsp;
    <a href="SECURITY.md"><strong>Security</strong></a>
  </p>
</div>

<a id="status"></a>

> [!NOTE]
> **0.x.** The API may change between minor versions. Pin an exact version and read the changelog
> before you upgrade.

## What it is

BullMQ is a good queue. Most of the incidents I have had with it were not bugs in BullMQ but
defaults I forgot to change: a producer that hung a request for 20 seconds while Redis restarted, a
`removeOnComplete: true` that silently broke a dedupe, a retry storm with no jitter, a cron that
moved an hour when the clocks changed, a scheduler for a renamed job that kept firing for months,
a deploy that killed jobs halfway through.

`@noctcore/jobs` is a thin layer over BullMQ 6 for NestJS that makes those choices once. Each
default exists because of one of those traps, and each module starts with a comment that names
it. Underneath it is still BullMQ: the same Redis keys, the same `Queue`, `Worker` and `Job`, and
`queue.bull` when you need something this package does not wrap.

### When it is a bad fit

- **You already run Postgres and not Redis.** A Postgres queue such as
  [pg-boss](https://github.com/timgit/pg-boss) or [Graphile Worker](https://worker.graphile.org/)
  saves you a second datastore and lets a job be enqueued in the same transaction as the write
  that caused it.
- **You need durable multi-step workflows** (sagas, human approval steps, workflows that sleep for
  weeks). [Temporal](https://temporal.io/) or [Inngest](https://www.inngest.com/) model those
  directly; a queue of independent jobs does not.
- **You need flows, a dashboard or an outbox.** They are out of scope here. BullMQ's own flows,
  and dashboards that read BullMQ's keys, work alongside this package through `queue.bull`.

## Install

```sh
bun add @noctcore/jobs bullmq ioredis
# or: pnpm add / npm install
```

Peers: `@nestjs/common` and `@nestjs/core` 11 or 12, `bullmq` 6.3 or later (below 7), `ioredis` 5
or 6. Node 22 or later. Redis must run with `maxmemory-policy noeviction`, as BullMQ requires.

## Quick start

Define a queue, with its policy and its typed jobs, in a file both producers and workers import:

```ts
// mail.queue.ts
import { defineQueue, expo } from '@noctcore/jobs';

export type MailJobs = {
  welcome: { userId: string };
  receipt: { orderId: string };
};

export const mail = defineQueue<MailJobs>('mail', {
  attempts: 5,
  backoff: expo('2s'), // 2s, 4s, 8s, 16s, each with jitter
  keep: { completed: '1d', failed: '14d' },
  concurrency: 10,
  pace: { max: 50, per: '1s' }, // across every replica
});
```

Register the module once, and the queues where they are used:

```ts
// app.module.ts
import { JobsModule } from '@noctcore/jobs';

@Module({
  imports: [
    JobsModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ redisUrl: config.getOrThrow('REDIS_URL') }),
    }),
    JobsModule.forFeature([mail]),
  ],
  providers: [SignupService, MailWorker, MaintenanceSweeps],
})
export class AppModule {}
```

Enqueue, choosing a dedupe every time:

```ts
import { InjectQueue, JobQueue, dedupe } from '@noctcore/jobs';

@Injectable()
export class SignupService {
  constructor(@InjectQueue(mail) private readonly mail: JobQueue<MailJobs>) {}

  async onSignedUp(userId: string) {
    await this.mail.add('welcome', { userId }, { dedupe: dedupe.window(['welcome', userId], '1d') });
  }
}
```

Process:

```ts
import { JobHost, Worker, type JobOf } from '@noctcore/jobs';

@Worker(mail)
export class MailWorker extends JobHost<typeof mail> {
  async handle(job: JobOf<MailJobs>) {
    switch (job.name) {
      case 'welcome':
        return this.sendWelcome(job.data.userId); // job.data is typed per name
      case 'receipt':
        return this.sendReceipt(job.data.orderId);
    }
  }

  async onFinalFailure(job: JobOf<MailJobs>, error: unknown) {
    this.logger.error('Mail gave up', { job: job.name, id: job.id });
  }
}
```

Run something on a schedule:

```ts
import { Sweep, type SweepContext } from '@noctcore/jobs';

@Injectable()
export class MaintenanceSweeps {
  @Sweep('expired-tokens', { cron: '15 * * * *', tz: 'UTC' })
  async purgeExpiredTokens(ctx: SweepContext) {
    await this.tokens.deleteExpiredBefore(ctx.scheduledAt);
  }
}
```

And stop cleanly:

```ts
// main.ts
const app = await NestFactory.create(AppModule);
installGracefulShutdown(app, { flush: () => Sentry.flush(2_000) });
await app.listen(3000);
```

## The traps

| Trap | What the package does | Test |
|---|---|---|
| An enqueue during a Redis outage hangs the request (ioredis queues commands offline and retries 20 times) | Producers use their own connection: no offline queue, one retry, a 3 s command timeout. While an outage is known `add()` refuses at once, and every `add()` is bounded by the timeout | `outage.int.test.ts` |
| Workers give up during a Redis restart | Workers use a separate connection with `maxRetriesPerRequest: null`, as BullMQ requires | `connections.test.ts` |
| The password, username, db or TLS in `REDIS_URL` is dropped when a connection is built from host and port | Every connection is parsed from the whole URL; `rediss://` turns TLS on | `redis-url.test.ts`, `redis-auth.int.test.ts` |
| Retries without jitter turn one outage into a synchronised storm | A retrying policy needs a backoff from `expo()` or `fixed()`, jittered by default; a hand-written object or zero jitter does not compile | `policy.test.ts`, `retry.int.test.ts` |
| Unbounded retries, or `attempts` read from config as any number | `attempts` is a literal from 2 to 20, or `'once'` | `policy.test.ts` |
| `removeOnComplete: false` (or forgetting it) fills Redis | Retention for completed and failed jobs is required and always has an age | `policy.test.ts` |
| A dedupe built on a caller `jobId` stops working once the job is removed | Every `add()` must choose a dedupe; caller jobIds do not exist; keys are hashed and a colon is refused | `dedupe.test.ts`, `dedupe.int.test.ts` |
| Mixed units: backoff in ms, retention age in seconds | Every duration is written with its unit (`'2s'`, `'14d'`) and converted where BullMQ reads it | `duration.test.ts` |
| A worker loses the request id and the trace of the request that enqueued the job | `add()` stamps a context envelope (your hook plus W3C trace headers); the worker validates it, re-enters it and opens a span | `job-context.test.ts`, `job-runner.test.ts` |
| A failure alert fires on every attempt, or never | `onFinalFailure` and the error reporter run once, on the attempt that ends the job | `retry.int.test.ts` |
| A bug that no retry can fix spends every attempt | `classify()` or `UnrecoverableError` (`fatal()`) fails the job at once | `retry.int.test.ts` |
| A cron runs once per replica | Sweeps are BullMQ job schedulers: one job per tick, however many replicas upsert them | `sweeps.int.test.ts` |
| A renamed or deleted sweep keeps firing from Redis | At boot the sweeps queue is reconciled: schedulers no sweep declares are removed | `sweeps.int.test.ts` |
| A cron moves with the server's time zone | `cron` needs `tz` | `decorators.test.ts` (types) |
| A failing sweep is noticed weeks later | A failure counter, a last-success timestamp and an `onError` hook | `sweeps.int.test.ts` |
| A provider's 429 is retried as a failure and burns attempts | `throw await this.pauseQueue(ms)` pauses the queue and hands the job back without spending an attempt; a shorter pause never cuts a longer one | `queue-pause.test.ts`, `pause.int.test.ts` |
| A deploy kills jobs halfway | `installGracefulShutdown` drains workers (bounded) before the app closes, then closes the queues and the producer | `shutdown.test.ts`, `shutdown.int.test.ts` |

## API

### `JobsModule.forRoot(options)` / `forRootAsync({ imports, inject, useFactory })`

A global module. `forFeature([queues])` makes each queue injectable with `@InjectQueue(queue)`.

| Option | Default | |
|---|---|---|
| `redisUrl` | required | `redis://user:pass@host:6379/2`, or `rediss://` for TLS |
| `prefix` | `bull` | BullMQ's key prefix. Never use ioredis's `keyPrefix` with BullMQ |
| `workers` | `true` | `false` on replicas that only enqueue |
| `producer.commandTimeoutMs` | `3000` | Bound on one Redis command and on one `add()` |
| `telemetry` | none | `{ metrics, tracing, errors }`, see below |
| `context` | none | A `JobContextHook` that carries your request context into workers |
| `sweeps.queue` | `jobs-sweeps` | One per app |
| `sweeps.concurrency` | `1` | Sweeps one process runs at once |
| `sweeps.reconcile` | `true` | Remove schedulers no sweep declares |
| `sweeps.onError` | none | Called after a sweep fails |
| `shutdown.drainTimeoutMs` | `20000` | How long draining waits for running jobs |

### `defineQueue<Jobs>(name, policy)`

```ts
defineQueue<Jobs>(name, {
  attempts: 2..20, backoff: expo(delay, { jitter? }) | fixed(delay, { jitter? }),
  // or
  attempts: 'once',

  keep: { completed: Retention, failed: Retention }, // Retention = '1d' | { age: '1d', count?: 1000 }
  concurrency: number,                               // per worker process
  pace?: { max, per } | paceFrom({ inject, useFactory }),
});
```

Names may hold letters, digits, `.`, `_` and `-`. What does not compile: `attempts: 50`,
`attempts: someNumber`, retries without a backoff, `{ type: 'exponential', delay: 1000 }` written by
hand, `keep: { completed: false }`, `keep: { completed: { count: 100 } }` (no age), and a missing
`keep` or `concurrency`. The same rules are checked at runtime for callers without types.

`paceFrom` resolves a pace through Nest DI at boot, for limits that come from configuration.

### `queue.add(name, data, { dedupe, delay?, priority? })`

`name` and `data` are typed by the queue. Resolves to `{ id }`; when a dedupe dropped the call,
the id is that of the job already holding the key. Rejects with `EnqueueUnavailableError` when Redis
cannot take the job.

| Dedupe | Behaviour |
|---|---|
| `dedupe.window(key, ttl)` | The first job runs; repeats within `ttl` are dropped, even after the first one finished |
| `dedupe.until(key)` | Repeats are dropped while the first job waits, runs or retries; after it settles, the next is a new job |
| `dedupe.debounce(key, wait)` | The job waits `wait`; each repeat replaces the payload and restarts the wait, so only the last runs |
| `dedupe.none()` | Every call is a new job, said out loud |

A key is a string or an array of strings (`['receipt', orderId]`). It is hashed with SHA-256 before
it reaches Redis, so ids and emails in it are not stored, and a colon (BullMQ's key separator) is
refused. `queue.releaseDedupe(key)` ends a window early for a deliberate resend.

**Dedupe and retention.** The dedupe key lives in its own Redis key, not in the job, so automatic
retention (`keep`) never ends a window early: a one-day window holds for a day even if the job was
removed after an hour. A manual `queue.bull.clean()`, `obliterate()` or `job.remove()` does release
the key. `dedupe.until` ends when the job completes or fails for good, whatever the retention.

### `@Worker(queue)` and `JobHost`

One worker class per queue, a singleton that extends `JobHost<typeof queue>`.

- `handle(job)`: `job.name` narrows `job.data`. `job.attempt`, `job.maxAttempts`, `job.context`
  (the producer's context) and `job.raw` (the BullMQ job) are there too.
- `onFinalFailure(job, error)`: once, when the job fails for good. A throw in it is logged and
  ignored.
- `classify(error)`: return `'fatal'` for errors that a retry cannot fix. `fatal(message)` builds an
  `UnrecoverableError` you can throw directly.
- `throw await this.pauseQueue(ms)`: for a downstream that said "not now". The queue stops for at
  least `ms` across every replica, and the job goes back without spending an attempt.
- `this.logger`: a Nest logger named after the class.

### `@Sweep(name, { cron, tz } | { every })`

On any singleton provider method. The name is the scheduler id. A failure is counted, reported,
passed to `sweeps.onError` and logged; the next tick is the retry. Sweeps run on replicas that run
workers; every replica schedules them, which is harmless.

During a rolling deploy, an old replica that boots after a new one re-adds the schedulers it knows,
and the next new boot removes them again. If a renamed sweep must never run twice, deploy the
rename when no old replica can still start.

### `QueuePause`

`queue.pause.forAtLeast(ms)` (or `queue.pauseFor(ms)`) stops the queue from handing out jobs for at
least `ms`. It reads the running pause first and only ever extends it, so two workers that hit a
limit at the same time cannot shorten each other's pause.

### Shutdown

`installGracefulShutdown(app, { flush?, drainTimeoutMs?, deadlineMs?, signals? })` handles SIGTERM
and SIGINT: it drains the workers (running jobs finish, no new ones start, bounded by
`drainTimeoutMs`), then calls `app.close()`, then `flush`, all within `deadlineMs` (25 s), then
re-raises the signal. A job still running at the drain timeout is abandoned and BullMQ's stalled
check gives it to another worker. Use it instead of `app.enableShutdownHooks()`, not together with
it. `shutdownGracefully(app, options)` runs the same sequence without touching signals.

### Telemetry

None of these is a dependency; pass the module you already have.

```ts
import * as promClient from 'prom-client';
import * as otel from '@opentelemetry/api';
import * as Sentry from '@sentry/node';
import { openTelemetryTracing, prometheusMetrics, sentryReporter } from '@noctcore/jobs';

JobsModule.forRoot({
  redisUrl,
  telemetry: {
    metrics: prometheusMetrics(promClient), // jobs_job_duration_seconds, jobs_job_failures_total, jobs_sweep_failures_total, jobs_sweep_last_success_timestamp_seconds
    tracing: openTelemetryTracing(otel),
    errors: sentryReporter(Sentry),
  },
});
```

Or implement `JobsMetrics`, `JobsTracing` and `ErrorReporter` yourself; they are small interfaces.

### Job context

```ts
JobsModule.forRoot({
  redisUrl,
  context: {
    capture: () => ({ requestId: als.getStore()?.requestId ?? '' }),
    run: (ctx, fn) => als.run({ requestId: ctx.requestId }, fn),
  },
});
```

The envelope lives under the reserved `_jobs` key in the job data and is removed before `handle`
sees it. It holds at most 32 string fields; put ids in it, never secrets. Coming back from Redis it
is validated, and a malformed one is dropped whole.

## Migrating

### From raw BullMQ

| BullMQ | Here |
|---|---|
| `new Queue(name, { connection, defaultJobOptions })` | `defineQueue(name, policy)` plus `JobsModule.forFeature([queue])` |
| `queue.add(name, data, { jobId })` | `queue.add(name, data, { dedupe: dedupe.until(key) })` |
| `{ deduplication: { id, ttl } }` | `dedupe.window(key, ttl)` |
| `new Worker(name, processor, { concurrency })` | `@Worker(queue) class extends JobHost` with `concurrency` in the policy |
| `worker.on('failed')` plus an `attemptsMade` check | `onFinalFailure` |
| `queue.upsertJobScheduler(...)` in `onModuleInit` | `@Sweep(name, schedule)` |
| `worker.rateLimit(ms); throw Worker.RateLimitError()` | `throw await this.pauseQueue(ms)` |
| `connection: { host, port }` | `redisUrl` |

The Redis keys are BullMQ's own, so existing queues keep their jobs. Two differences to plan for:
job data gains a `_jobs` key when a context hook or tracing is configured, and dedupe ids are now
hashes, so a window opened by the old code does not block the new code.

### From `@nestjs/bullmq`

| `@nestjs/bullmq` | Here |
|---|---|
| `BullModule.forRoot({ connection })` | `JobsModule.forRoot({ redisUrl })` |
| `BullModule.registerQueue({ name, defaultJobOptions })` | `defineQueue(name, policy)` and `JobsModule.forFeature([queue])` |
| `@InjectQueue('mail') queue: Queue` | `@InjectQueue(mail) queue: JobQueue<MailJobs>` |
| `@Processor('mail') class extends WorkerHost` | `@Worker(mail) class extends JobHost<typeof mail>` |
| `process(job: Job)` | `handle(job: JobOf<MailJobs>)` |
| `@OnWorkerEvent('failed')` | `onFinalFailure` |

Migrate one queue at a time: both modules can run in one app, since they share BullMQ's keys.
Do not register a worker for the same queue in both.

## Development

```sh
bun install
bun run services:up          # two Redis containers (plain, and one with a password)
bun run gate                 # format, build, typecheck, lint, API report, deps, workflows, package, unit, integration
bun run services:down
```

The integration suites read `REDIS_URL` and `REDIS_AUTH_URL` (values in `.env.example`). Without
them they skip locally; CI sets `JOBS_REQUIRE_SERVICES=1` so they never skip there.

## Contributing

Issues and pull requests are welcome; please open an issue first for anything larger than a small
fix. [CONTRIBUTING.md](CONTRIBUTING.md) covers the checks and conventions. Everyone taking part
follows the [Code of Conduct](CODE_OF_CONDUCT.md). Vulnerabilities go through
[SECURITY.md](SECURITY.md), never a public issue.

## License

[MIT](LICENSE)
