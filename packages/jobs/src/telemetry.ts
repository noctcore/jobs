/**
 * Telemetry as three small interfaces the app fills in, so the package has no
 * hard dependency on any vendor SDK.
 *
 * - `JobsMetrics`: per-attempt duration, failures split into retryable and
 *   final, and the two sweep signals (a failure counter and a last-success
 *   timestamp). `prometheusMetrics(promClient)` builds one on prom-client.
 * - `JobsTracing`: carries the producer's trace into the worker and wraps each
 *   attempt in a span. `openTelemetryTracing(api)` builds one on
 *   `@opentelemetry/api`.
 * - `ErrorReporter`: called once per job when it fails for good (never on a
 *   retry a later attempt may absorb) and on every failed sweep.
 *   `sentryReporter(Sentry)` builds one on any Sentry SDK.
 *
 * The adapters take the vendor module as an argument and only describe the
 * parts they call, so installing this package never installs a vendor SDK.
 */

/** Labels of one job attempt. */
export interface JobLabels {
  readonly queue: string;
  readonly job: string;
}

/** Counters and gauges the runtime records. Every method is optional. */
export interface JobsMetrics {
  /** One attempt ended: it returned (`ok`) or threw. */
  jobAttempt?(labels: JobLabels & { readonly ok: boolean }, seconds: number): void;
  /** One attempt threw. `final` means BullMQ is done with the job (it is in the failed set). */
  jobFailed?(labels: JobLabels & { readonly final: boolean }): void;
  /** A sweep tick threw. */
  sweepFailed?(sweep: string): void;
  /** A sweep tick finished. Alert on the time since the last one, not on failures alone. */
  sweepSucceeded?(sweep: string, at: Date): void;
}

/** The span the runtime records an attempt in. */
export interface JobSpan {
  recordException(error: unknown): void;
  setError(message: string): void;
  addEvent(name: string): void;
}

/** Trace propagation from producer to worker. */
export interface JobsTracing {
  /** Writes the active trace context into `carrier` (W3C `traceparent`, `tracestate`). */
  inject(carrier: Record<string, string>): void;
  /** Runs `fn` in a span that continues the trace found in `carrier`. */
  runInSpan<T>(
    name: string,
    attributes: Readonly<Record<string, string | number>>,
    carrier: Readonly<Record<string, string>>,
    fn: (span: JobSpan) => Promise<T>,
  ): Promise<T>;
}

/** Where a failure happened. */
export type FailureContext =
  | {
      readonly kind: 'job';
      readonly queue: string;
      readonly job: string;
      readonly jobId: string;
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly context: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'sweep'; readonly sweep: string; readonly jobId: string };

/** Receives final job failures and sweep failures. */
export interface ErrorReporter {
  report(error: unknown, context: FailureContext): void;
}

/** The telemetry option of `JobsModule.forRoot`. */
export interface JobsTelemetry {
  readonly metrics?: JobsMetrics;
  readonly tracing?: JobsTracing;
  readonly errors?: ErrorReporter;
}

// prom-client, described by the parts the adapter calls.
interface PromMetric {
  inc(labels: Record<string, string>, value?: number): void;
}

interface PromGauge {
  set(labels: Record<string, string>, value: number): void;
}

interface PromHistogram {
  observe(labels: Record<string, string>, value: number): void;
}

interface PromConfig {
  name: string;
  help: string;
  labelNames: string[];
  buckets?: number[];
  registers?: unknown[];
}

/** The parts of the `prom-client` module `prometheusMetrics` uses. */
export interface PromClientLike {
  readonly Counter: new (config: PromConfig) => PromMetric;
  readonly Gauge: new (config: PromConfig) => PromGauge;
  readonly Histogram: new (config: PromConfig) => PromHistogram;
}

/** Options for `prometheusMetrics`. */
export interface PrometheusMetricsOptions {
  /** Prefix of every metric name. Defaults to `jobs_`. */
  readonly prefix?: string;
  /** Registries to register on. Defaults to prom-client's global registry. */
  readonly registers?: unknown[];
  /** Histogram buckets in seconds. Jobs may take minutes, so the default reaches 5 minutes. */
  readonly buckets?: number[];
}

/** The default duration buckets, in seconds. */
export const DEFAULT_DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];

/**
 * `JobsMetrics` on prom-client. Call it once per process: prom-client refuses
 * to register a metric name twice.
 *
 * - `<prefix>job_duration_seconds{queue,job,ok}`: one observation per attempt.
 * - `<prefix>job_failures_total{queue,job,final}`: `final="false"` is a retry
 *   (watch the rate), `final="true"` is a job in the dead-letter set (page).
 * - `<prefix>sweep_failures_total{sweep}`
 * - `<prefix>sweep_last_success_timestamp_seconds{sweep}`: alert on
 *   `time() - max by (sweep) (...)`. `max`, because only the replica that ran
 *   a tick moves its own series.
 */
export function prometheusMetrics(
  prom: PromClientLike,
  options: PrometheusMetricsOptions = {},
): JobsMetrics {
  const prefix = options.prefix ?? 'jobs_';
  const registers = options.registers === undefined ? {} : { registers: options.registers };

  const duration = new prom.Histogram({
    name: `${prefix}job_duration_seconds`,
    help: 'Duration of one job attempt in seconds, by queue, job name and whether it returned (ok)',
    labelNames: ['queue', 'job', 'ok'],
    buckets: options.buckets ?? DEFAULT_DURATION_BUCKETS,
    ...registers,
  });

  const failures = new prom.Counter({
    name: `${prefix}job_failures_total`,
    help: 'Job attempts that threw, by queue, job name and whether it was the final attempt',
    labelNames: ['queue', 'job', 'final'],
    ...registers,
  });

  const sweepFailures = new prom.Counter({
    name: `${prefix}sweep_failures_total`,
    help: 'Sweep ticks that threw, by sweep',
    labelNames: ['sweep'],
    ...registers,
  });

  const sweepLastSuccess = new prom.Gauge({
    name: `${prefix}sweep_last_success_timestamp_seconds`,
    help: 'Unix time in seconds at which each sweep last finished a tick; alert on time() - max by (sweep) (...)',
    labelNames: ['sweep'],
    ...registers,
  });

  return {
    jobAttempt: ({ queue, job, ok }, seconds) =>
      duration.observe({ queue, job, ok: String(ok) }, seconds),
    jobFailed: ({ queue, job, final }) => failures.inc({ queue, job, final: String(final) }),
    sweepFailed: (sweep) => sweepFailures.inc({ sweep }),
    sweepSucceeded: (sweep, at) => sweepLastSuccess.set({ sweep }, at.getTime() / 1_000),
  };
}

// @opentelemetry/api, described by the parts the adapter calls.
interface OtelSpan {
  recordException(exception: Error | string): void;
  setStatus(status: { code: number; message?: string }): void;
  addEvent(name: string): void;
  end(): void;
}

interface OtelTracer {
  startActiveSpan<F extends (span: OtelSpan) => unknown>(
    name: string,
    options: { attributes?: Record<string, string | number>; kind?: number },
    context: unknown,
    fn: F,
  ): ReturnType<F>;
}

/** The parts of the `@opentelemetry/api` module `openTelemetryTracing` uses. */
export interface OpenTelemetryApiLike {
  readonly context: { active(): unknown };
  readonly propagation: {
    inject(context: unknown, carrier: Record<string, string>): void;
    extract(context: unknown, carrier: Record<string, string>): unknown;
  };
  readonly trace: { getTracer(name: string, version?: string): OtelTracer };
}

/** OpenTelemetry's `SpanStatusCode.ERROR` and `SpanKind.CONSUMER`, without importing the enum. */
const OTEL_STATUS_ERROR = 2;
const OTEL_KIND_CONSUMER = 4;

/** `JobsTracing` on `@opentelemetry/api`. */
export function openTelemetryTracing(
  api: OpenTelemetryApiLike,
  options: { readonly tracerName?: string } = {},
): JobsTracing {
  const tracer = api.trace.getTracer(options.tracerName ?? '@noctcore/jobs');

  return {
    inject: (carrier) => api.propagation.inject(api.context.active(), carrier),
    runInSpan: (name, attributes, carrier, fn) => {
      const parent =
        Object.keys(carrier).length > 0
          ? api.propagation.extract(api.context.active(), { ...carrier })
          : api.context.active();

      return tracer.startActiveSpan(
        name,
        { attributes: { ...attributes }, kind: OTEL_KIND_CONSUMER },
        parent,
        async (span) => {
          try {
            return await fn({
              recordException: (error) =>
                span.recordException(error instanceof Error ? error : String(error)),
              setError: (message) => span.setStatus({ code: OTEL_STATUS_ERROR, message }),
              addEvent: (event) => span.addEvent(event),
            });
          } finally {
            span.end();
          }
        },
      );
    },
  };
}

/** The part of a Sentry SDK `sentryReporter` uses. */
export interface SentryLike {
  captureException(
    exception: unknown,
    hint?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ): unknown;
}

/** `ErrorReporter` on a Sentry SDK (`@sentry/node`, `@sentry/nestjs`, ...). */
export function sentryReporter(sentry: SentryLike): ErrorReporter {
  return {
    report: (error, context) => {
      if (context.kind === 'sweep') {
        sentry.captureException(error, {
          tags: { 'jobs.kind': 'sweep', 'jobs.sweep': context.sweep },
          extra: { jobId: context.jobId },
        });

        return;
      }

      sentry.captureException(error, {
        tags: { 'jobs.kind': 'job', 'jobs.queue': context.queue, 'jobs.job': context.job },
        extra: {
          jobId: context.jobId,
          attempt: context.attempt,
          maxAttempts: context.maxAttempts,
          ...context.context,
        },
      });
    },
  };
}
