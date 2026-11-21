import type { INestApplicationContext } from '@nestjs/common';
import { afterEach, expect, it } from 'vitest';

import {
  JobHost,
  Worker,
  dedupe,
  defineQueue,
  expo,
  paceFrom,
  queueToken,
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

type Jobs = { call: { n: number } };

const RATE = 'RATE_CONFIG';

const provider = defineQueue<Jobs>('provider', {
  attempts: 2,
  backoff: expo('1s'),
  keep: { completed: '1h', failed: '7d' },
  concurrency: 4,
  pace: paceFrom({
    inject: [RATE],
    useFactory: (rate: { perSecond: number }) => ({ max: rate.perSecond, per: '1s' }),
  }),
});

let app: INestApplicationContext | undefined;
let prefix = '';

afterEach(async () => {
  await app?.close();
  app = undefined;
  await dropPrefix(redisUrl(), prefix);
});

describeRedis('pace and queue pause on a real Redis', () => {
  it('hands a refused job back without spending an attempt, and paces from injected config', async () => {
    prefix = uniquePrefix();

    const runs: { n: number; attempt: number; at: number }[] = [];
    let refused = false;

    @Worker(provider)
    class ProviderWorker extends JobHost<typeof provider> {
      async handle(job: JobOf<Jobs>): Promise<void> {
        runs.push({ n: job.data.n, attempt: job.attempt, at: Date.now() });

        if (job.data.n !== 0 || refused) return;

        refused = true;

        throw await this.pauseQueue(400);
      }
    }

    app = await bootApp({
      options: { redisUrl: redisUrl(), prefix },
      queues: [provider],
      providers: [ProviderWorker, { provide: RATE, useValue: { perSecond: 2 } }],
    });

    const queue = app.get<JobQueue<Jobs>>(queueToken(provider));

    await queue.add('call', { n: 0 }, { dedupe: dedupe.none() });
    await waitFor(() => runs.length === 2, 10_000);

    const [first, second] = runs;

    // Handed back, not failed: the second run is still attempt 1, after the pause.
    expect(first?.attempt).toBe(1);
    expect(second?.attempt).toBe(1);
    expect((second?.at ?? 0) - (first?.at ?? 0)).toBeGreaterThanOrEqual(350);

    // Paced at 2 per second from the injected config: 4 jobs take over a second.
    const before = runs.length;
    const startedAt = Date.now();

    for (let n = 1; n <= 4; n += 1) await queue.add('call', { n }, { dedupe: dedupe.none() });

    await waitFor(() => runs.length === before + 4, 10_000);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
  });
});
