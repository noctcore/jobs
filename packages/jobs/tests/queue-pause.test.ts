import { describe, expect, it } from 'vitest';

import { QueuePause } from '../src/queue-pause';

function fakeQueue(initialTtl = 0): {
  queue: { getRateLimitTtl(max?: number): Promise<number>; rateLimit(ms: number): Promise<void> };
  writes: number[];
  asked: (number | undefined)[];
} {
  let ttl = initialTtl;
  const writes: number[] = [];
  const asked: (number | undefined)[] = [];

  return {
    writes,
    asked,
    queue: {
      getRateLimitTtl: async (max) => {
        asked.push(max);
        await Promise.resolve();

        return ttl;
      },
      rateLimit: async (ms) => {
        await Promise.resolve();
        writes.push(ms);
        ttl = ms;
      },
    },
  };
}

describe('QueuePause', () => {
  it('extends a shorter pause and keeps a longer one', async () => {
    const fake = fakeQueue(5_000);
    const pause = new QueuePause(fake.queue, () => 10);

    await expect(pause.forAtLeast(1_000)).resolves.toBe(5_000);
    await expect(pause.forAtLeast(60_000)).resolves.toBe(60_000);
    expect(fake.writes).toEqual([60_000]);
    expect(fake.asked).toEqual([10, 10]);
  });

  it('takes turns, so a short pause decided concurrently never cuts a long one', async () => {
    const fake = fakeQueue(0);
    const pause = new QueuePause(fake.queue, () => 1);

    const results = await Promise.all([pause.forAtLeast(900_000), pause.forAtLeast(1_000)]);

    expect(results).toEqual([900_000, 900_000]);
    expect(fake.writes).toEqual([900_000]);
  });

  it('refuses a pause under a millisecond and keeps taking turns after a failure', async () => {
    const pause = new QueuePause(
      {
        getRateLimitTtl: () => Promise.reject(new Error('redis down')),
        rateLimit: () => Promise.resolve(),
      },
      () => 1,
    );

    await expect(pause.forAtLeast(0)).rejects.toThrow(RangeError);
    await expect(pause.forAtLeast(10)).rejects.toThrow('redis down');
    await expect(pause.forAtLeast(10)).rejects.toThrow('redis down');
  });
});
