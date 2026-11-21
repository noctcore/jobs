# @noctcore/jobs

BullMQ 6 for NestJS with the safe choice made the default: typed queues, a required dedupe choice on
every enqueue, bounded retries with jitter, bounded retention, producers that fail fast during a
Redis outage, sweeps that run once per tick across replicas, and a shutdown that waits for running
jobs.

```sh
bun add @noctcore/jobs bullmq ioredis
```

```ts
import { defineQueue, dedupe, expo, JobHost, Worker, type JobOf } from '@noctcore/jobs';

type MailJobs = { welcome: { userId: string } };

export const mail = defineQueue<MailJobs>('mail', {
  attempts: 5,
  backoff: expo('2s'),
  keep: { completed: '1d', failed: '14d' },
  concurrency: 10,
});

await mailQueue.add('welcome', { userId }, { dedupe: dedupe.window(['welcome', userId], '1d') });

@Worker(mail)
export class MailWorker extends JobHost<typeof mail> {
  async handle(job: JobOf<MailJobs>) {
    await this.mailer.sendWelcome(job.data.userId);
  }
}
```

0.x: the API may change between minor versions, so pin an exact version.

The full guide (every API, the trap each default prevents, how dedupe interacts with retention, and
migrating from BullMQ or `@nestjs/bullmq`) is in the [docs](https://noctcore.github.io/jobs/).

MIT licensed.
