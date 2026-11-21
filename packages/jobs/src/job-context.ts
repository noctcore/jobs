import type { JobsTracing } from './telemetry';

/**
 * The job context envelope: what a producer knew (a request id, a user id, a
 * tenant, the trace) carried across the queue into the worker.
 *
 * Without it a worker's logs carry no correlation with the request that
 * caused them, and its spans start a new trace. The envelope is stamped by
 * `add()` itself, so no producer has to remember a wrapper, and it travels in
 * the job data under one reserved key the worker strips before the handler
 * sees the payload.
 *
 * What goes in it is the app's choice, through a `JobContextHook` (usually
 * reading and re-entering an AsyncLocalStorage). Tenant ids and similar scope
 * keys belong there: this package never interprets them.
 *
 * Coming back off the queue the envelope is parsed, not trusted: anything with
 * Redis write access, a replay from a queue UI or an older producer can put
 * anything there. A malformed envelope is dropped whole (a partly trusted
 * context is worse than none) and the job runs without one.
 */

/** The reserved key in job data that holds the envelope. */
export const ENVELOPE_KEY = '_jobs';

/** The app's hook for carrying its own context across the queue. */
export interface JobContextHook {
  /** Called in the producer: the string fields to carry (ids only, never secrets). */
  capture(): Readonly<Record<string, string>> | undefined;
  /** Called in the worker: run `fn` with the captured fields re-entered. */
  run<T>(context: Readonly<Record<string, string>>, fn: () => T): T;
}

/** The envelope as stored in job data. */
export interface JobEnvelope {
  readonly v: 1;
  readonly ctx?: Readonly<Record<string, string>>;
  readonly trace?: Readonly<Record<string, string>>;
}

const MAX_FIELDS = 32;
const MAX_KEY = 64;
const MAX_VALUE = 512;
const TRACE_KEYS = new Set(['traceparent', 'tracestate', 'baggage']);

function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const entries = Object.entries(value);

  return (
    entries.length <= MAX_FIELDS &&
    entries.every(
      ([key, field]) =>
        key.length > 0 &&
        key.length <= MAX_KEY &&
        typeof field === 'string' &&
        field.length <= MAX_VALUE,
    )
  );
}

/** Builds the envelope in the producer, or undefined when there is nothing to carry. */
export function captureEnvelope(
  hook: JobContextHook | undefined,
  tracing: JobsTracing | undefined,
): JobEnvelope | undefined {
  const captured = hook?.capture();
  const ctx = captured !== undefined && isStringMap(captured) ? { ...captured } : undefined;

  if (captured !== undefined && ctx === undefined) {
    throw new TypeError(
      `JobContextHook.capture() must return at most ${MAX_FIELDS} string fields of at most ${MAX_VALUE} characters.`,
    );
  }

  const carrier: Record<string, string> = {};

  tracing?.inject(carrier);

  const trace = Object.fromEntries(Object.entries(carrier).filter(([key]) => TRACE_KEYS.has(key)));
  const hasCtx = ctx !== undefined && Object.keys(ctx).length > 0;
  const hasTrace = Object.keys(trace).length > 0;

  if (!hasCtx && !hasTrace) return undefined;

  return { v: 1, ...(hasCtx ? { ctx } : {}), ...(hasTrace ? { trace } : {}) };
}

/** The result of reading job data in the worker. */
export interface OpenedJobData {
  /** The payload with the envelope removed. */
  readonly data: unknown;
  readonly ctx: Readonly<Record<string, string>>;
  readonly trace: Readonly<Record<string, string>>;
  /** True when an envelope was present but malformed, and was dropped. */
  readonly dropped: boolean;
}

/** Splits job data into the payload and a validated envelope. */
export function openJobData(raw: unknown): OpenedJobData {
  if (typeof raw !== 'object' || raw === null || !(ENVELOPE_KEY in raw)) {
    return { data: raw, ctx: {}, trace: {}, dropped: false };
  }

  const { [ENVELOPE_KEY]: envelope, ...data } = raw as Record<string, unknown>;

  if (typeof envelope !== 'object' || envelope === null) {
    return { data, ctx: {}, trace: {}, dropped: true };
  }

  const { v, ctx = {}, trace = {}, ...rest } = envelope as Record<string, unknown>;
  const valid = v === 1 && Object.keys(rest).length === 0 && isStringMap(ctx) && isStringMap(trace);

  if (!valid) return { data, ctx: {}, trace: {}, dropped: true };

  const traceOnly = Object.fromEntries(
    Object.entries(trace).filter(([key]) => TRACE_KEYS.has(key)),
  );

  return { data, ctx, trace: traceOnly, dropped: false };
}
