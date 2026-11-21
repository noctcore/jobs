import type { INestApplicationContext } from '@nestjs/common';
import { Redis } from 'ioredis';
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
  REDIS_AUTH_URL,
  bootApp,
  describeRedis,
  dropPrefix,
  uniquePrefix,
  waitFor,
} from '../support/redis';

type Jobs = { ping: { n: number } };

const pings = defineQueue<Jobs>('pings', {
  attempts: 'once',
  keep: { completed: '1h', failed: '7d' },
  concurrency: 1,
});

let app: INestApplicationContext | undefined;
let prefix = '';

function authUrl(): string {
  if (REDIS_AUTH_URL === undefined) throw new Error('REDIS_AUTH_URL is not set');

  return REDIS_AUTH_URL;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  await dropPrefix(authUrl(), prefix);
});

describeRedis('a password, a username and a db index in the URL', () => {
  it('reach the producer and the worker connections', async () => {
    prefix = uniquePrefix();

    const handled: number[] = [];

    @Worker(pings)
    class PingWorker extends JobHost<typeof pings> {
      async handle(job: JobOf<Jobs>): Promise<void> {
        handled.push(job.data.n);
      }
    }

    app = await bootApp({
      options: { redisUrl: authUrl(), prefix },
      queues: [pings],
      providers: [PingWorker],
    });

    const queue = app.get<JobQueue<Jobs>>(queueToken(pings));

    await queue.add('ping', { n: 1 }, { dedupe: dedupe.none() });
    await waitFor(() => handled.length === 1);
    expect(handled).toEqual([1]);

    // The keys landed in the db the URL names, not db 0.
    const url = new URL(authUrl());
    const db = Number(url.pathname.slice(1));
    const probe = new Redis(authUrl());

    try {
      expect(db).toBeGreaterThan(0);
      expect((await probe.keys(`${prefix}:pings:*`)).length).toBeGreaterThan(0);
      await probe.select(0);
      expect(await probe.keys(`${prefix}:pings:*`)).toEqual([]);
    } finally {
      probe.disconnect();
    }
  });

  it('fails loudly without the password instead of wedging silently', async () => {
    const url = new URL(authUrl());

    url.password = '';
    url.username = '';

    prefix = uniquePrefix();

    app = await bootApp({
      options: { redisUrl: url.toString(), prefix, workers: false },
      queues: [pings],
    });

    const queue = app.get<JobQueue<Jobs>>(queueToken(pings));

    await expect(queue.add('ping', { n: 1 }, { dedupe: dedupe.none() })).rejects.toThrow();
  });
});
