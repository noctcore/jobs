import type { INestApplicationContext } from '@nestjs/common';
import { afterEach, expect, it } from 'vitest';

import {
  JobHost,
  Worker,
  dedupe,
  defineQueue,
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

type Jobs = { notify: { userId: string } };

const keep = { completed: '1h', failed: '7d' } as const;
const notify = defineQueue<Jobs>('notify', { attempts: 'once', keep, concurrency: 1 });

let app: INestApplicationContext | undefined;
let prefix = '';

afterEach(async () => {
  await app?.close();
  app = undefined;
  await dropPrefix(redisUrl(), prefix);
});

async function boot(withWorker: boolean): Promise<{ queue: JobQueue<Jobs>; handled: string[] }> {
  prefix = uniquePrefix();

  const handled: string[] = [];

  @Worker(notify)
  class NotifyWorker extends JobHost<typeof notify> {
    async handle(job: JobOf<Jobs>): Promise<void> {
      handled.push(job.data.userId);
    }
  }

  app = await bootApp({
    options: { redisUrl: redisUrl(), prefix, workers: withWorker },
    queues: [notify],
    providers: [NotifyWorker],
  });

  return { queue: app.get<JobQueue<Jobs>>(queueToken(notify)), handled };
}

describeRedis('dedupe on a real Redis', () => {
  it('window: drops repeats inside the window and enqueues again after it expires', async () => {
    const { queue } = await boot(false);

    const first = await queue.add(
      'notify',
      { userId: 'a' },
      { dedupe: dedupe.window('k1', '400ms') },
    );

    const repeat = await queue.add(
      'notify',
      { userId: 'b' },
      { dedupe: dedupe.window('k1', '400ms') },
    );

    expect(repeat.id).toBe(first.id);
    expect(await queue.bull.getJobCountByTypes('wait')).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 600));

    const after = await queue.add(
      'notify',
      { userId: 'c' },
      { dedupe: dedupe.window('k1', '400ms') },
    );

    expect(after.id).not.toBe(first.id);
    expect(await queue.bull.getJobCountByTypes('wait')).toBe(2);
  });

  it('window: still holds after the first job completed, independent of retention', async () => {
    const { queue, handled } = await boot(true);

    await queue.add('notify', { userId: 'a' }, { dedupe: dedupe.window('k2', '5s') });
    await waitFor(() => handled.length === 1);
    await queue.add('notify', { userId: 'b' }, { dedupe: dedupe.window('k2', '5s') });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(handled).toEqual(['a']);
  });

  it('window: a MANUAL clean or remove of the job releases the key (BullMQ documents this)', async () => {
    const { queue, handled } = await boot(true);

    await queue.add('notify', { userId: 'a' }, { dedupe: dedupe.window('k5', '5s') });
    await waitFor(() => handled.length === 1);
    await queue.bull.clean(0, 100, 'completed');
    await queue.add('notify', { userId: 'b' }, { dedupe: dedupe.window('k5', '5s') });
    await waitFor(() => handled.length === 2);

    expect(handled).toEqual(['a', 'b']);
  });

  it('until: drops repeats while the job is pending and lets the next one in once it settled', async () => {
    const { queue, handled } = await boot(true);

    await queue.bull.pause();

    const first = await queue.add('notify', { userId: 'a' }, { dedupe: dedupe.until('k3') });
    const repeat = await queue.add('notify', { userId: 'b' }, { dedupe: dedupe.until('k3') });

    expect(repeat.id).toBe(first.id);

    await queue.bull.resume();
    await waitFor(() => handled.length === 1);

    const next = await queue.add('notify', { userId: 'c' }, { dedupe: dedupe.until('k3') });

    expect(next.id).not.toBe(first.id);
    await waitFor(() => handled.length === 2);
    expect(handled).toEqual(['a', 'c']);
  });

  it('none: every call is a new job, and releaseDedupe reopens a window on purpose', async () => {
    const { queue } = await boot(false);
    const a = await queue.add('notify', { userId: 'a' }, { dedupe: dedupe.none() });
    const b = await queue.add('notify', { userId: 'a' }, { dedupe: dedupe.none() });

    expect(a.id).not.toBe(b.id);

    const w1 = await queue.add('notify', { userId: 'a' }, { dedupe: dedupe.window('k4', '1h') });

    expect(await queue.releaseDedupe('k4')).toBe(true);

    const w2 = await queue.add('notify', { userId: 'a' }, { dedupe: dedupe.window('k4', '1h') });

    expect(w2.id).not.toBe(w1.id);
  });

  it('stores only the hash of the key and never a caller jobId', async () => {
    const { queue } = await boot(false);

    const added = await queue.add(
      'notify',
      { userId: 'a' },
      { dedupe: dedupe.window(['reset', 'someone@example.com'], '1m') },
    );

    const job = await queue.bull.getJob(added.id);

    expect(job?.opts.deduplication?.id).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(job?.opts)).not.toContain('example.com');
    expect(added.id).toMatch(/^\d+$/u);
  });
});
