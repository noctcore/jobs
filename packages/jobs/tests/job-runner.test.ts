import { RATE_LIMIT_ERROR, UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { JobHost, isFinalAttempt, type JobOf, type JobRun } from '../src/job-host';
import { ENVELOPE_KEY } from '../src/job-context';
import { runJob, type RunDeps } from '../src/job-runner';
import type { QueueDefinition } from '../src/policy';
import type { FailureContext, JobsMetrics } from '../src/telemetry';

type Jobs = { send: { to: string } };

type MailQueue = QueueDefinition<Jobs>;

function fakeJob(
  overrides: { attemptsMade?: number; attempts?: number; data?: unknown } = {},
): Job {
  return {
    id: '7',
    name: 'send',
    queueName: 'mail',
    data: overrides.data ?? { to: 'someone' },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 3 },
  } as unknown as Job;
}

class Host extends JobHost<MailQueue> {
  readonly seen: JobRun[] = [];
  readonly finals: { job: JobRun; error: unknown }[] = [];

  constructor(private readonly behaviour: (job: JobOf<Jobs>) => Promise<unknown>) {
    super();
  }

  handle(job: JobOf<Jobs>): Promise<unknown> {
    this.seen.push(job);

    return this.behaviour(job);
  }

  override onFinalFailure(job: JobOf<Jobs>, error: unknown): void {
    this.finals.push({ job, error });
  }
}

function deps(extra: Partial<RunDeps> = {}): RunDeps & {
  metrics: Required<JobsMetrics>;
  reports: { error: unknown; context: FailureContext }[];
} {
  const reports: { error: unknown; context: FailureContext }[] = [];

  const metrics = {
    jobAttempt: vi.fn(),
    jobFailed: vi.fn(),
    sweepFailed: vi.fn(),
    sweepSucceeded: vi.fn(),
  };

  return {
    telemetry: {
      metrics,
      errors: { report: (error, context) => reports.push({ error, context }) },
    },
    context: undefined,
    logger: { warn: vi.fn(), error: vi.fn() },
    metrics,
    reports,
    ...extra,
  };
}

describe('isFinalAttempt', () => {
  it('counts the running attempt the way BullMQ does', () => {
    expect(isFinalAttempt({ attemptsMade: 0, opts: { attempts: 3 } }, new Error('x'))).toBe(false);
    expect(isFinalAttempt({ attemptsMade: 2, opts: { attempts: 3 } }, new Error('x'))).toBe(true);
    expect(isFinalAttempt({ attemptsMade: 0, opts: {} }, new Error('x'))).toBe(true);
  });

  it('treats UnrecoverableError as final and a queue pause as never final', () => {
    expect(
      isFinalAttempt({ attemptsMade: 0, opts: { attempts: 3 } }, new UnrecoverableError('x')),
    ).toBe(true);

    expect(
      isFinalAttempt({ attemptsMade: 2, opts: { attempts: 3 } }, new Error(RATE_LIMIT_ERROR)),
    ).toBe(false);
  });
});

describe('runJob', () => {
  it('hands the handler a typed view with the envelope stripped and records the attempt', async () => {
    const host = new Host(async () => 'sent');
    const d = deps();
    const job = fakeJob({ data: { to: 'x', [ENVELOPE_KEY]: { v: 1, ctx: { requestId: 'r-1' } } } });

    await expect(runJob(host, job, d)).resolves.toBe('sent');

    expect(host.seen[0]).toMatchObject({
      name: 'send',
      data: { to: 'x' },
      attempt: 1,
      maxAttempts: 3,
      context: { requestId: 'r-1' },
    });

    expect(d.metrics.jobAttempt).toHaveBeenCalledWith(
      { queue: 'mail', job: 'send', ok: true },
      expect.any(Number),
    );

    expect(d.metrics.jobFailed).not.toHaveBeenCalled();
  });

  it('re-enters the producer context through the hook', async () => {
    let seen: string | undefined;
    const store = { current: undefined as Readonly<Record<string, string>> | undefined };

    const host = new Host(async () => {
      seen = store.current?.['requestId'];
    });

    const d = deps({
      context: {
        capture: () => undefined,
        run: (context, fn) => {
          store.current = context;

          try {
            return fn();
          } finally {
            store.current = undefined;
          }
        },
      },
    });

    await runJob(
      host,
      fakeJob({ data: { to: 'x', [ENVELOPE_KEY]: { v: 1, ctx: { requestId: 'r-9' } } } }),
      d,
    );

    expect(seen).toBe('r-9');
  });

  it('on a retryable failure: counts it as not final, reports nothing, calls no final hook', async () => {
    const host = new Host(async () => {
      throw new Error('relay down');
    });

    const d = deps();

    await expect(runJob(host, fakeJob({ attemptsMade: 0 }), d)).rejects.toThrow('relay down');
    expect(d.metrics.jobFailed).toHaveBeenCalledWith({ queue: 'mail', job: 'send', final: false });
    expect(d.reports).toHaveLength(0);
    expect(host.finals).toHaveLength(0);
  });

  it('on the final attempt: reports once and calls onFinalFailure once', async () => {
    const host = new Host(async () => {
      throw new Error('relay down');
    });

    const d = deps();

    await expect(runJob(host, fakeJob({ attemptsMade: 2 }), d)).rejects.toThrow('relay down');
    expect(d.metrics.jobFailed).toHaveBeenCalledWith({ queue: 'mail', job: 'send', final: true });
    expect(d.reports).toHaveLength(1);

    expect(d.reports[0]?.context).toMatchObject({
      kind: 'job',
      queue: 'mail',
      attempt: 3,
      maxAttempts: 3,
    });

    expect(host.finals).toHaveLength(1);
  });

  it('turns an error the host classifies as fatal into an UnrecoverableError', async () => {
    class Classifying extends Host {
      override classify(): 'fatal' {
        return 'fatal';
      }
    }

    const host = new Classifying(async () => {
      throw new Error('no such user');
    });

    const d = deps();

    const error: unknown = await runJob(host, fakeJob({ attemptsMade: 0 }), d).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe('no such user');
    expect(host.finals).toHaveLength(1);
  });

  it('lets a queue pause through without counting it as a failure', async () => {
    const host = new Host(async () => {
      throw new Error(RATE_LIMIT_ERROR);
    });

    const d = deps();

    await expect(runJob(host, fakeJob({ attemptsMade: 2 }), d)).rejects.toThrow(RATE_LIMIT_ERROR);
    expect(d.metrics.jobFailed).not.toHaveBeenCalled();
    expect(d.reports).toHaveLength(0);
    expect(host.finals).toHaveLength(0);
  });

  it('never lets a throwing reporter or final hook change the outcome', async () => {
    class Throwing extends Host {
      override onFinalFailure(): void {
        throw new Error('hook broke');
      }
    }

    const host = new Throwing(async () => {
      throw new Error('relay down');
    });

    const d = deps({
      telemetry: {
        errors: {
          report: () => {
            throw new Error('reporter broke');
          },
        },
      },
    });

    await expect(runJob(host, fakeJob({ attemptsMade: 2 }), d)).rejects.toThrow('relay down');
    expect(d.logger.warn).toHaveBeenCalledTimes(2);
  });

  it('wraps the attempt in a span that continues the producer trace', async () => {
    const calls: { name: string; carrier: Readonly<Record<string, string>> }[] = [];

    const host = new Host(async () => {
      throw new Error('boom');
    });

    const span = { recordException: vi.fn(), setError: vi.fn(), addEvent: vi.fn() };

    const d = deps({
      telemetry: {
        tracing: {
          inject: () => undefined,
          runInSpan: (name, _attributes, carrier, fn) => {
            calls.push({ name, carrier });

            return fn(span);
          },
        },
      },
    });

    const job = fakeJob({
      data: { to: 'x', [ENVELOPE_KEY]: { v: 1, trace: { traceparent: 'tp' } } },
    });

    await expect(runJob(host, job, d)).rejects.toThrow('boom');
    expect(calls).toEqual([{ name: 'jobs.process mail', carrier: { traceparent: 'tp' } }]);
    expect(span.recordException).toHaveBeenCalledOnce();
    expect(span.setError).toHaveBeenCalledWith('boom');
  });

  it('warns about a malformed envelope and still runs the job', async () => {
    const host = new Host(async () => 'ok');
    const d = deps();

    await runJob(host, fakeJob({ data: { to: 'x', [ENVELOPE_KEY]: 'tampered' } }), d);
    expect(d.logger.warn).toHaveBeenCalledOnce();
    expect(host.seen[0]?.context).toEqual({});
  });
});
