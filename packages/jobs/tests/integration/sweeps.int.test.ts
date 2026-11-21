import { Injectable, type INestApplicationContext } from '@nestjs/common';
import { Queue } from 'bullmq';
import { afterEach, expect, it } from 'vitest';

import { JobsRuntime, Sweep, type JobsMetrics, type SweepContext } from '../../src';
import {
  bootApp,
  describeRedis,
  dropPrefix,
  redisUrl,
  uniquePrefix,
  waitFor,
} from '../support/redis';

const apps: INestApplicationContext[] = [];
let prefix = '';

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await dropPrefix(redisUrl(), prefix);
});

interface Tick {
  readonly instance: string;
  readonly jobId: string;
  readonly scheduledAt: number;
}

function sweepProvider(instance: string, ticks: Tick[], failing = false): new () => object {
  @Injectable()
  class Sweeps {
    @Sweep('heartbeat', { every: '500ms' })
    async heartbeat(ctx: SweepContext): Promise<void> {
      ticks.push({ instance, jobId: ctx.jobId, scheduledAt: ctx.scheduledAt.getTime() });

      if (failing) throw new Error('sweep broke');
    }
  }

  return Sweeps;
}

describeRedis('sweeps on a real Redis', () => {
  it('runs each tick exactly once with two app instances running', async () => {
    prefix = uniquePrefix();

    const ticks: Tick[] = [];

    for (const name of ['a', 'b']) {
      apps.push(
        await bootApp({
          options: { redisUrl: redisUrl(), prefix },
          providers: [sweepProvider(name, ticks)],
        }),
      );
    }

    await waitFor(() => ticks.length >= 6, 15_000);

    const ids = ticks.map((t) => t.jobId);
    const slots = ticks.map((t) => t.scheduledAt);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(slots).size).toBe(slots.length);

    // One scheduler in Redis however many replicas upserted it.
    const inspect = new Queue('jobs-sweeps', { connection: urlConnection(), prefix });

    expect((await inspect.getJobSchedulers()).map((s) => s.key)).toEqual(['heartbeat']);
    expect(new Set(ticks.map((t) => t.instance)).size).toBeGreaterThanOrEqual(1);
    await inspect.close();
  });

  it('removes schedulers no sweep declares any more, so a renamed sweep stops firing', async () => {
    prefix = uniquePrefix();

    // A scheduler left behind by an older version of the app.
    const seed = new Queue('jobs-sweeps', { connection: urlConnection(), prefix });

    await seed.upsertJobScheduler('old-name', { every: 500 }, { name: 'old-name', data: {} });
    expect((await seed.getJobSchedulers()).map((s) => s.key)).toEqual(['old-name']);

    const ticks: Tick[] = [];

    apps.push(
      await bootApp({
        options: { redisUrl: redisUrl(), prefix },
        providers: [sweepProvider('a', ticks)],
      }),
    );

    expect((await seed.getJobSchedulers()).map((s) => s.key)).toEqual(['heartbeat']);
    await seed.close();
  });

  it('counts a failed tick, reports it, calls onError, and records success on a good one', async () => {
    prefix = uniquePrefix();

    const ticks: Tick[] = [];
    const events: string[] = [];

    const metrics: JobsMetrics = {
      sweepFailed: (sweep) => events.push(`failed:${sweep}`),
      sweepSucceeded: (sweep) => events.push(`ok:${sweep}`),
    };

    apps.push(
      await bootApp({
        options: {
          redisUrl: redisUrl(),
          prefix,
          telemetry: { metrics, errors: { report: (_e, c) => events.push(`report:${c.kind}`) } },
          sweeps: { onError: (sweep) => void events.push(`hook:${sweep}`) },
        },
        providers: [sweepProvider('a', ticks, true)],
      }),
    );

    await waitFor(() => events.filter((e) => e.startsWith('hook')).length >= 1, 10_000);
    expect(events.slice(0, 3)).toEqual(['failed:heartbeat', 'report:sweep', 'hook:heartbeat']);
    expect(events).not.toContain('ok:heartbeat');
  });

  it('does not start a sweep worker on a replica that only enqueues, but still schedules', async () => {
    prefix = uniquePrefix();

    const ticks: Tick[] = [];

    apps.push(
      await bootApp({
        options: { redisUrl: redisUrl(), prefix, workers: false },
        providers: [sweepProvider('a', ticks)],
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(ticks).toEqual([]);
    expect(apps[0]?.get(JobsRuntime).scheduledSweeps).toEqual(['heartbeat']);
  });
});

function urlConnection(): { host: string; port: number } {
  const url = new URL(redisUrl());

  return { host: url.hostname, port: Number(url.port) };
}
