import type { INestApplicationContext } from '@nestjs/common';
import { afterEach, expect, it } from 'vitest';

import {
  JobHost,
  JobsRuntime,
  Worker,
  dedupe,
  defineQueue,
  queueToken,
  shutdownGracefully,
  type JobOf,
  type JobQueue,
} from '../../src';
import {
  bootApp,
  describeRedis,
  dropPrefix,
  redisUrl,
  uniquePrefix,
  waitFor,
} from '../support/redis';

type Jobs = { slow: { ms: number } };

const slow = defineQueue<Jobs>('slow', {
  attempts: 'once',
  keep: { completed: '1h', failed: '7d' },
  concurrency: 1,
});

let app: INestApplicationContext | undefined;
let prefix = '';

afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  await dropPrefix(redisUrl(), prefix);
});

const quiet = { log: () => undefined, error: () => undefined };

async function boot(drainTimeoutMs: number): Promise<{
  queue: JobQueue<Jobs>;
  events: string[];
  runtime: JobsRuntime;
}> {
  prefix = uniquePrefix();

  const events: string[] = [];

  @Worker(slow)
  class SlowWorker extends JobHost<typeof slow> {
    async handle(job: JobOf<Jobs>): Promise<void> {
      events.push('started');
      await new Promise((resolve) => setTimeout(resolve, job.data.ms));
      events.push('finished');
    }
  }

  app = await bootApp({
    options: { redisUrl: redisUrl(), prefix, shutdown: { drainTimeoutMs } },
    queues: [slow],
    providers: [SlowWorker],
  });

  return {
    queue: app.get<JobQueue<Jobs>>(queueToken(slow)),
    events,
    runtime: app.get(JobsRuntime),
  };
}

describeRedis('graceful shutdown on a real Redis', () => {
  it('lets the running job finish, then closes the app and the producer connection', async () => {
    const { queue, events, runtime } = await boot(10_000);
    const { id } = await queue.add('slow', { ms: 600 }, { dedupe: dedupe.none() });

    await waitFor(() => events.includes('started'));

    const steps: string[] = [];

    const report = await shutdownGracefully(app as INestApplicationContext, {
      logger: quiet,
      flush: async () => {
        steps.push(`flush after ${events.join(',')}`);
      },
    });

    app = undefined;

    expect(report).toEqual({
      drain: { drained: ['slow'], abandoned: [] },
      closed: true,
      timedOut: false,
    });

    expect(events).toEqual(['started', 'finished']);
    expect(steps).toEqual(['flush after started,finished']);
    // QUIT was acknowledged; the socket then closes on its own.
    await waitFor(() => runtime.producerConnection.status === 'end', 2_000);

    // The job completed in Redis; it did not come back as stalled.
    const probe = await bootApp({
      options: { redisUrl: redisUrl(), prefix, workers: false },
      queues: [slow],
    });

    try {
      const job = await probe.get<JobQueue<Jobs>>(queueToken(slow)).bull.getJob(id);

      expect(await job?.getState()).toBe('completed');
    } finally {
      await probe.close();
    }
  });

  it('abandons a job that outlives the drain timeout instead of hanging the stop', async () => {
    const { queue, events } = await boot(200);

    await queue.add('slow', { ms: 5_000 }, { dedupe: dedupe.none() });
    await waitFor(() => events.includes('started'));

    const started = Date.now();
    const report = await shutdownGracefully(app as INestApplicationContext, { logger: quiet });

    app = undefined;

    expect(report.drain).toEqual({ drained: [], abandoned: ['slow'] });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(events).toEqual(['started']);
  });
});
