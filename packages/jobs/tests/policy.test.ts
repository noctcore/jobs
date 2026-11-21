import { describe, expect, expectTypeOf, it } from 'vitest';

import { defineQueue, expo, fixed, paceFrom, type JobQueue, type JobsOf } from '../src';

/**
 * The policy's safety is in its type: every unsafe policy below carries a
 * `@ts-expect-error`, so `bun run typecheck` fails the day one of them starts
 * compiling. Each is also run, to prove the runtime check behind the type
 * (for JavaScript callers and values that bypass the types).
 */

const keep = { completed: '1h', failed: '7d' } as const;

describe('defineQueue: safe policies', () => {
  it('turns a policy into BullMQ job options with the right units', () => {
    const queue = defineQueue('mail', {
      attempts: 5,
      backoff: expo('2s'),
      keep: { completed: { age: '1h', count: 100 }, failed: '7d' },
      concurrency: 5,
    });

    expect(queue.policy.jobOptions).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000, jitter: 0.5 },
      // Retention ages are SECONDS in BullMQ; backoff delays are milliseconds.
      removeOnComplete: { age: 3_600, count: 100 },
      removeOnFail: { age: 604_800 },
    });

    expect(queue.policy.concurrency).toBe(5);
  });

  it('accepts an explicit single attempt', () => {
    const queue = defineQueue('charge', { attempts: 'once', keep, concurrency: 1 });

    expect(queue.policy.jobOptions.attempts).toBe(1);
    expect(queue.policy.jobOptions.backoff).toBeUndefined();
  });

  it('accepts a fixed backoff with custom jitter and a static or injected pace', () => {
    expect(
      defineQueue('a', {
        attempts: 3,
        backoff: fixed('500ms', { jitter: 1 }),
        keep,
        concurrency: 2,
        pace: { max: 10, per: '1s' },
      }).policy.jobOptions.backoff,
    ).toEqual({ type: 'fixed', delay: 500, jitter: 1 });

    const fromConfig = paceFrom({
      inject: ['CONFIG'],
      useFactory: (config: { rate: number }) => ({ max: config.rate, per: '1s' }),
    });

    expect(
      defineQueue('b', { attempts: 'once', keep, concurrency: 1, pace: fromConfig }).policy.pace,
    ).toBe(fromConfig);
  });

  it('types job names and payloads', () => {
    type MailJobs = { verify: { userId: string }; digest: { day: string } };
    const mail = defineQueue<MailJobs>('mail-typed', { attempts: 'once', keep, concurrency: 1 });

    expect(mail.name).toBe('mail-typed');
    expectTypeOf<JobsOf<typeof mail>>().toEqualTypeOf<MailJobs>();
    expectTypeOf<JobQueue<MailJobs>['add']>().parameter(0).toEqualTypeOf<'verify' | 'digest'>();

    const typedAdd = (queue: JobQueue<MailJobs>): void => {
      void queue.add('verify', { userId: 'u1' }, { dedupe: { kind: 'none' } as never });
      // @ts-expect-error unknown job name
      void queue.add('welcome', { userId: 'u1' }, { dedupe: { kind: 'none' } as never });
      // @ts-expect-error payload of the wrong job
      void queue.add('verify', { day: 'monday' }, { dedupe: { kind: 'none' } as never });
      // @ts-expect-error dedupe is required
      void queue.add('verify', { userId: 'u1' }, {});
      // @ts-expect-error a caller-built jobId is not an option
      void queue.add('verify', { userId: 'u1' }, { dedupe: { kind: 'none' } as never, jobId: 'x' });
    };

    expect(typedAdd).toBeTypeOf('function');
  });
});

describe('defineQueue: unsafe policies do not compile and are refused at runtime', () => {
  it('refuses one attempt unless it is spelled "once"', () => {
    // @ts-expect-error attempts: 1 is BullMQ's silent default; say 'once'
    expect(() => defineQueue('q', { attempts: 1, keep, concurrency: 1 })).toThrow(/attempts/u);
  });

  it('refuses retries without a backoff', () => {
    // @ts-expect-error retries need a backoff
    expect(() => defineQueue('q', { attempts: 3, keep, concurrency: 1 })).toThrow();
  });

  it('refuses a hand-written backoff without jitter', () => {
    expect(() =>
      defineQueue('q', {
        attempts: 3,
        // @ts-expect-error only expo() and fixed() build a backoff
        backoff: { type: 'exponential', delay: 1_000 },
        keep,
        concurrency: 1,
      }),
    ).toThrow();

    expect(() => expo('1s', { jitter: 0 })).toThrow(/jitter/u);
  });

  it('refuses unbounded retention', () => {
    // @ts-expect-error keep is required
    expect(() => defineQueue('q', { attempts: 'once', concurrency: 1 })).toThrow();

    expect(() =>
      defineQueue('q', {
        attempts: 'once',
        // @ts-expect-error false means keep forever in BullMQ
        keep: { completed: false, failed: '7d' },
        concurrency: 1,
      }),
    ).toThrow();

    expect(() =>
      defineQueue('q', {
        attempts: 'once',
        // @ts-expect-error a count alone has no age bound
        keep: { completed: { count: 100 }, failed: '7d' },
        concurrency: 1,
      }),
    ).toThrow();

    expect(() =>
      // @ts-expect-error both sets need a window
      defineQueue('q', { attempts: 'once', keep: { completed: '1h' }, concurrency: 1 }),
    ).toThrow();
  });

  it('refuses more than 20 attempts and a non-literal attempt count', () => {
    expect(() =>
      defineQueue('q', {
        // @ts-expect-error past 20 a job outlives any incident
        attempts: 50,
        backoff: expo('1s'),
        keep,
        concurrency: 1,
      }),
    ).toThrow();

    const fromEnv = Number('3');

    const fromConfig = (): unknown =>
      defineQueue('q', {
        // @ts-expect-error an attempt count must be a literal the reader can see
        attempts: fromEnv,
        backoff: expo('1s'),
        keep,
        concurrency: 1,
      });

    expect(fromConfig).toBeTypeOf('function');
  });

  it('refuses a zero or fractional concurrency and pace, and a bad name', () => {
    expect(() => defineQueue('q', { attempts: 'once', keep, concurrency: 0 })).toThrow(
      /concurrency/u,
    );

    expect(() => defineQueue('q', { attempts: 'once', keep, concurrency: 1.5 })).toThrow(
      /concurrency/u,
    );

    expect(() =>
      defineQueue('q', { attempts: 'once', keep, concurrency: 1, pace: { max: 0, per: '1s' } }),
    ).toThrow(/pace\.max/u);

    expect(() => defineQueue('mail:queue', { attempts: 'once', keep, concurrency: 1 })).toThrow(
      /no colon/u,
    );
  });
});
