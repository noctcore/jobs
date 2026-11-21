import { describe, expect, it } from 'vitest';

import {
  openTelemetryTracing,
  prometheusMetrics,
  sentryReporter,
  type OpenTelemetryApiLike,
  type PromClientLike,
} from '../src/telemetry';

interface Recorded {
  readonly name: string;
  readonly calls: unknown[][];
  readonly config: Record<string, unknown>;
}

function fakeProm(): { prom: PromClientLike; metrics: Recorded[] } {
  const metrics: Recorded[] = [];

  class Metric {
    readonly calls: unknown[][] = [];

    constructor(readonly config: { name: string }) {
      metrics.push({ name: config.name, calls: this.calls, config: { ...config } });
    }

    inc(...args: unknown[]): void {
      this.calls.push(['inc', ...args]);
    }

    set(...args: unknown[]): void {
      this.calls.push(['set', ...args]);
    }

    observe(...args: unknown[]): void {
      this.calls.push(['observe', ...args]);
    }
  }

  return { prom: { Counter: Metric, Gauge: Metric, Histogram: Metric }, metrics };
}

describe('prometheusMetrics', () => {
  it('registers four metrics under the prefix and records with string labels', () => {
    const { prom, metrics } = fakeProm();
    const m = prometheusMetrics(prom, { prefix: 'app_', registers: ['r'] });

    expect(metrics.map((x) => x.name)).toEqual([
      'app_job_duration_seconds',
      'app_job_failures_total',
      'app_sweep_failures_total',
      'app_sweep_last_success_timestamp_seconds',
    ]);

    expect(metrics[0]?.config['registers']).toEqual(['r']);

    m.jobAttempt?.({ queue: 'q', job: 'j', ok: false }, 1.5);
    m.jobFailed?.({ queue: 'q', job: 'j', final: true });
    m.sweepFailed?.('s');
    m.sweepSucceeded?.('s', new Date(10_000));

    expect(metrics[0]?.calls).toEqual([['observe', { queue: 'q', job: 'j', ok: 'false' }, 1.5]]);
    expect(metrics[1]?.calls).toEqual([['inc', { queue: 'q', job: 'j', final: 'true' }]]);
    expect(metrics[2]?.calls).toEqual([['inc', { sweep: 's' }]]);
    expect(metrics[3]?.calls).toEqual([['set', { sweep: 's' }, 10]]);
  });
});

describe('openTelemetryTracing', () => {
  it('injects the active context and runs each attempt in a consumer span on the extracted parent', async () => {
    const events: unknown[] = [];

    const api: OpenTelemetryApiLike = {
      context: { active: () => 'ACTIVE' },
      propagation: {
        inject: (context, carrier) => {
          carrier['traceparent'] = `from-${String(context)}`;
        },
        extract: (context, carrier) => `extracted(${String(context)},${carrier['traceparent']})`,
      },
      trace: {
        getTracer: () => ({
          startActiveSpan: (name, options, context, fn) => {
            events.push({ name, options, context });

            return fn({
              recordException: (e) => events.push(['exception', e]),
              setStatus: (s) => events.push(['status', s]),
              addEvent: (e) => events.push(['event', e]),
              end: () => events.push('end'),
            }) as never;
          },
        }),
      },
    };

    const tracing = openTelemetryTracing(api);
    const carrier: Record<string, string> = {};

    tracing.inject(carrier);
    expect(carrier).toEqual({ traceparent: 'from-ACTIVE' });

    await expect(
      tracing.runInSpan('jobs.process q', { a: 1 }, { traceparent: 'tp' }, async (span) => {
        span.setError('bad');

        return 'done';
      }),
    ).resolves.toBe('done');

    expect(events[0]).toEqual({
      name: 'jobs.process q',
      options: { attributes: { a: 1 }, kind: 4 },
      context: 'extracted(ACTIVE,tp)',
    });

    expect(events).toContainEqual(['status', { code: 2, message: 'bad' }]);
    expect(events.at(-1)).toBe('end');
  });
});

describe('sentryReporter', () => {
  it('tags job and sweep failures', () => {
    const captured: unknown[][] = [];
    const reporter = sentryReporter({ captureException: (...args) => captured.push(args) });
    const error = new Error('x');

    reporter.report(error, {
      kind: 'job',
      queue: 'q',
      job: 'j',
      jobId: '1',
      attempt: 3,
      maxAttempts: 3,
      context: { requestId: 'r' },
    });

    reporter.report(error, { kind: 'sweep', sweep: 's', jobId: '2' });

    expect(captured).toEqual([
      [
        error,
        {
          tags: { 'jobs.kind': 'job', 'jobs.queue': 'q', 'jobs.job': 'j' },
          extra: { jobId: '1', attempt: 3, maxAttempts: 3, requestId: 'r' },
        },
      ],
      [error, { tags: { 'jobs.kind': 'sweep', 'jobs.sweep': 's' }, extra: { jobId: '2' } }],
    ]);
  });
});
