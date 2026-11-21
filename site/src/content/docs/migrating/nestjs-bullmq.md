---
title: Migrating from @nestjs/bullmq
description: Map BullModule, registerQueue, @Processor, WorkerHost and @OnWorkerEvent to @noctcore/jobs, one queue at a time.
---

Both modules can run in one app, since they share BullMQ's keys. Migrate one queue at a time, and
never register a worker for the same queue in both.

| `@nestjs/bullmq` | Here |
| --- | --- |
| `BullModule.forRoot({ connection })` | `JobsModule.forRoot({ redisUrl })` |
| `BullModule.registerQueue({ name, defaultJobOptions })` | `defineQueue(name, policy)` and `JobsModule.forFeature([queue])` |
| `@InjectQueue('mail') queue: Queue` | `@InjectQueue(mail) queue: JobQueue<MailJobs>` |
| `@Processor('mail') class extends WorkerHost` | `@Worker(mail) class extends JobHost<typeof mail>` |
| `process(job: Job)` | `handle(job: JobOf<MailJobs>)` |
| `@OnWorkerEvent('failed')` | `onFinalFailure` |

## Before and after

```ts title="Before"
@Module({
  imports: [
    BullModule.forRoot({ connection: { host: 'localhost', port: 6379 } }),
    BullModule.registerQueue({ name: 'mail' }),
  ],
})
export class MailModule {}

@Processor('mail')
export class MailProcessor extends WorkerHost {
  async process(job: Job) {
    if (job.name === 'welcome') await this.mailer.sendWelcome(job.data.userId);
  }
}
```

```ts title="After"
export const mail = defineQueue<MailJobs>('mail', {
  attempts: 5,
  backoff: expo('2s'),
  keep: { completed: '1d', failed: '14d' },
  concurrency: 10,
});

@Module({
  imports: [JobsModule.forRoot({ redisUrl: process.env.REDIS_URL! }), JobsModule.forFeature([mail])],
  providers: [MailWorker],
})
export class MailModule {}

@Worker(mail)
export class MailWorker extends JobHost<typeof mail> {
  async handle(job: JobOf<MailJobs>) {
    if (job.name === 'welcome') await this.mailer.sendWelcome(job.data.userId);
  }
}
```

The "before" queue had one attempt and kept every job forever, because `registerQueue` without
`defaultJobOptions` leaves both to BullMQ's defaults. The "after" queue has to say what it wants.

The same two differences as [from raw BullMQ](/jobs/migrating/bullmq/#two-differences-to-plan-for)
apply: a `_jobs` key in job data when context or tracing is on, and hashed dedupe ids.

## Schedules

`@nestjs/schedule` crons run once per replica. Move them to [`@Sweep`](/jobs/guides/sweeps/), which
runs once per tick across replicas and needs an explicit time zone.
