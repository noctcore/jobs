import type { INestApplicationContext } from '@nestjs/common';
import { afterEach, expect, it } from 'vitest';

import { dedupe, defineQueue, queueToken, type JobQueue } from '../../src';
import { bootApp, describeRedis, dropPrefix, redisUrl, uniquePrefix } from '../support/redis';
import { startProxy } from '../support/tcp-proxy';

type Jobs = { send: { to: string } };

const mail = defineQueue<Jobs>('mail', {
  attempts: 'once',
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

async function timed<T>(promise: Promise<T>): Promise<{ ms: number; error: unknown }> {
  const started = Date.now();

  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );

  return { ms: Date.now() - started, error };
}

describeRedis('enqueue during a Redis outage', () => {
  it('rejects at once when Redis goes away mid-run, instead of hanging the caller', async () => {
    prefix = uniquePrefix();

    const proxy = await startProxy(new URL(redisUrl()));

    app = await bootApp({
      options: { redisUrl: proxy.url, prefix, workers: false },
      queues: [mail],
    });

    const queue = app.get<JobQueue<Jobs>>(queueToken(mail));

    await expect(queue.add('send', { to: 'a' }, { dedupe: dedupe.none() })).resolves.toHaveProperty(
      'id',
    );

    await proxy.cut();

    const { ms, error } = await timed(queue.add('send', { to: 'b' }, { dedupe: dedupe.none() }));

    expect(error).toBeInstanceOf(Error);
    // The producer budget is a 3 s command timeout; an offline queue would hang for good.
    expect(ms).toBeLessThan(3_500);
  });

  it('rejects quickly when Redis is unreachable from the start', async () => {
    prefix = uniquePrefix();

    app = await bootApp({
      options: {
        redisUrl: 'redis://127.0.0.1:1',
        prefix,
        workers: false,
        producer: { commandTimeoutMs: 500 },
      },
      queues: [mail],
    });

    const queue = app.get<JobQueue<Jobs>>(queueToken(mail));
    const { ms, error } = await timed(queue.add('send', { to: 'a' }, { dedupe: dedupe.none() }));

    expect(error).toBeInstanceOf(Error);
    expect(ms).toBeLessThan(3_500);
  });
});
