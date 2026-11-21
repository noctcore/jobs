import type { INestApplicationContext } from '@nestjs/common';
import { afterEach, expect, it } from 'vitest';

import {
  JobHost,
  Worker,
  dedupe,
  defineQueue,
  expo,
  fatal,
  queueToken,
  type FailureContext,
  type JobOf,
  type JobQueue,
  type JobsMetrics,
} from '../../src';
import {
  bootApp,
  describeRedis,
  dropPrefix,
  redisUrl,
  uniquePrefix,
  waitFor,
} from '../support/redis';

type Jobs = { flaky: { failTimes: number }; doomed: { reason: string } };

const work = defineQueue<Jobs>('work', {
  attempts: 3,
  backoff: expo('100ms'),
  keep: { completed: '1h', failed: '7d' },
  concurrency: 1,
});

let app: INestApplicationContext | undefined;
let prefix = '';

afterEach(async () => {
  await app?.close();
  app = undefined;
  await dropPrefix(redisUrl(), prefix);
});

interface Recorder {
  readonly attempts: { name: string; attempt: number; at: number }[];
  readonly finals: { name: string; attempt: number }[];
  readonly reports: FailureContext[];
  readonly failures: { job: string; final: boolean }[];
}

async function boot(): Promise<{ queue: JobQueue<Jobs>; rec: Recorder }> {
  prefix = uniquePrefix();

  const rec: Recorder = { attempts: [], finals: [], reports: [], failures: [] };

  @Worker(work)
  class WorkWorker extends JobHost<typeof work> {
    async handle(job: JobOf<Jobs>): Promise<string> {
      rec.attempts.push({ name: job.name, attempt: job.attempt, at: Date.now() });

      switch (job.name) {
        case 'flaky':
          if (job.attempt <= job.data.failTimes) throw new Error(`fail ${job.attempt}`);

          return 'ok';
        case 'doomed':
          if (job.data.reason === 'fatal') throw fatal('record is gone');

          throw new Error('still down');
      }
    }

    override onFinalFailure(job: JobOf<Jobs>): void {
      rec.finals.push({ name: job.name, attempt: job.attempt });
    }
  }

  const metrics: JobsMetrics = { jobFailed: ({ job, final }) => rec.failures.push({ job, final }) };

  app = await bootApp({
    options: {
      redisUrl: redisUrl(),
      prefix,
      telemetry: { metrics, errors: { report: (_error, context) => rec.reports.push(context) } },
    },
    queues: [work],
    providers: [WorkWorker],
  });

  return { queue: app.get<JobQueue<Jobs>>(queueToken(work)), rec };
}

describeRedis('retry, backoff and the final-attempt hook on a real Redis', () => {
  it('retries with backoff until the job succeeds, and never reports the absorbed failures', async () => {
    const { queue, rec } = await boot();
    const { id } = await queue.add('flaky', { failTimes: 2 }, { dedupe: dedupe.none() });

    await waitFor(async () => (await queue.bull.getJob(id))?.finishedOn !== undefined);

    expect(rec.attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);

    // expo('100ms') with jitter 0.5: retry n waits between half and all of 100ms * 2^(n-1).
    const [a1, a2, a3] = rec.attempts.map((a) => a.at);

    expect((a2 ?? 0) - (a1 ?? 0)).toBeGreaterThanOrEqual(45);
    expect((a3 ?? 0) - (a2 ?? 0)).toBeGreaterThanOrEqual(95);

    expect(rec.failures).toEqual([
      { job: 'flaky', final: false },
      { job: 'flaky', final: false },
    ]);

    expect(rec.reports).toEqual([]);
    expect(rec.finals).toEqual([]);
    expect(await (await queue.bull.getJob(id))?.getState()).toBe('completed');
  });

  it('calls the final-attempt hook and the reporter exactly once, on the last attempt', async () => {
    const { queue, rec } = await boot();
    const { id } = await queue.add('doomed', { reason: 'down' }, { dedupe: dedupe.none() });

    await waitFor(async () => (await (await queue.bull.getJob(id))?.getState()) === 'failed');
    await waitFor(() => rec.finals.length === 1);

    expect(rec.attempts).toHaveLength(3);
    expect(rec.finals).toEqual([{ name: 'doomed', attempt: 3 }]);

    expect(rec.reports).toEqual([
      expect.objectContaining({
        kind: 'job',
        queue: 'work',
        job: 'doomed',
        attempt: 3,
        maxAttempts: 3,
      }),
    ]);

    expect(rec.failures.map((f) => f.final)).toEqual([false, false, true]);
  });

  it('fails a fatal error at once, without spending the remaining attempts', async () => {
    const { queue, rec } = await boot();
    const { id } = await queue.add('doomed', { reason: 'fatal' }, { dedupe: dedupe.none() });

    await waitFor(async () => (await (await queue.bull.getJob(id))?.getState()) === 'failed');
    await waitFor(() => rec.finals.length === 1);

    expect(rec.attempts).toHaveLength(1);
    expect(rec.finals).toEqual([{ name: 'doomed', attempt: 1 }]);
    expect(rec.failures).toEqual([{ job: 'doomed', final: true }]);
  });
});
