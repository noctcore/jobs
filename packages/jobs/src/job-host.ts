import { Logger } from '@nestjs/common';
import { RATE_LIMIT_ERROR, UnrecoverableError, Worker as BullWorker, type Job } from 'bullmq';

import type { JobsOf, QueueDefinition } from './policy';

/**
 * The base class of every worker (`@Worker(queue) class X extends JobHost<typeof queue>`).
 *
 * The runtime wraps each attempt of `handle()` in the job's context and a
 * span, records its duration and failures, and decides once whether a failure
 * is final, so the metric, the error report and `onFinalFailure` always agree
 * on it. A retry that a later attempt may absorb is logged and counted, never
 * reported: a transient failure must not page anyone.
 */

/** One job as a handler sees it. `data` has the envelope removed. */
export interface JobRun<Name extends string = string, Data = unknown> {
  readonly name: Name;
  readonly data: Data;
  readonly id: string;
  readonly queue: string;
  /** This attempt, counting from 1. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** The fields the producer's `JobContextHook` captured. */
  readonly context: Readonly<Record<string, string>>;
  /** The BullMQ job, for what this view does not carry (progress, logs). */
  readonly raw: Job;
}

/** The union of a queue's jobs, discriminated by `name`. */
export type JobOf<Jobs> = {
  [Name in keyof Jobs & string]: JobRun<Name, Jobs[Name]>;
}[keyof Jobs & string];

/** How a failure should be treated. */
export type FailureKind = 'retry' | 'fatal';

/** Whether `error` is BullMQ's "put this job back, the queue is paused" signal. */
export function isQueuePauseSignal(error: unknown): boolean {
  return error instanceof Error && error.message === RATE_LIMIT_ERROR;
}

/**
 * Whether the failure `error` caused is final for `job`: the running attempt is
 * the last one BullMQ will make (`attemptsMade` counts finished attempts, so
 * the running one is `attemptsMade + 1`, the same arithmetic BullMQ uses), or
 * the error is an `UnrecoverableError`. A queue pause is never final: it uses
 * no attempt.
 */
export function isFinalAttempt(job: Pick<Job, 'attemptsMade' | 'opts'>, error: unknown): boolean {
  if (isQueuePauseSignal(error)) return false;

  return error instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/**
 * Throw this (or `fatal(message)`) from a handler when retrying can never
 * help: an invalid payload, a record that no longer exists. BullMQ moves the
 * job straight to the failed set without spending its remaining attempts.
 */
export { UnrecoverableError };

/** An `UnrecoverableError` with `cause`, for `throw fatal('...', { cause })`. */
export function fatal(message: string, options?: { cause?: unknown }): UnrecoverableError {
  const error = new UnrecoverableError(message);

  if (options?.cause !== undefined) {
    Object.defineProperty(error, 'cause', { value: options.cause, enumerable: false });
  }

  return error;
}

/** What the runtime attaches to a host when it starts its worker. */
export interface HostBinding {
  readonly pauseFor: (ms: number) => Promise<number>;
}

export const HOST_BINDING = Symbol('noctcore.jobs.host-binding');

export abstract class JobHost<Q extends QueueDefinition<object> = QueueDefinition> {
  /** A logger named after the concrete worker class. */
  protected readonly logger = new Logger(this.constructor.name);

  /** @internal Set by the runtime when the worker starts. */
  [HOST_BINDING]?: HostBinding;

  /** Runs one attempt of one job. Return a value to store it as the job's result. */
  abstract handle(job: JobOf<JobsOf<Q>>): Promise<unknown>;

  /**
   * Called once when a job fails for good (its last attempt threw, or the
   * error was fatal). The place for a per-queue alert or a compensating write.
   * An error thrown here is logged and does not change the job's outcome.
   */
  onFinalFailure?(job: JobOf<JobsOf<Q>>, error: unknown): void | Promise<void>;

  /**
   * Classifies an error a handler threw. Return `'fatal'` for errors no retry
   * can fix, and the job fails at once instead of spending its attempts.
   * Without this, only `UnrecoverableError` is fatal.
   */
  classify?(error: unknown): FailureKind;

  /**
   * Pauses the whole queue for at least `ms` and returns the error that hands
   * this job back without spending an attempt: `throw await this.pauseQueue(ms)`.
   * For a downstream that said "not now" (a 429 from a provider). Bound how
   * often one job is handed back (`job.raw.attemptsStarted`), or a job its
   * downstream always refuses pauses everything behind it for good.
   */
  protected async pauseQueue(ms: number): Promise<Error> {
    const binding = this[HOST_BINDING];

    if (binding === undefined) {
      throw new Error('pauseQueue() was called before the worker started.');
    }

    await binding.pauseFor(ms);

    return BullWorker.RateLimitError();
  }
}
