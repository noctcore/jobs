import type { InjectionToken } from '@nestjs/common';
import type { JobsOptions, KeepJobs } from 'bullmq';

import { toMilliseconds, toSeconds, type Duration } from './duration';

/**
 * A queue's policy, written once where the queue is defined, with every field
 * BullMQ would otherwise leave to a default made required.
 *
 * The traps it closes, each at compile time:
 *
 * - A queue registered without `defaultJobOptions` gets ONE attempt: the first
 *   transient error (a mail relay hiccup, a deploy) loses the job. Here
 *   `attempts` is required, and a single attempt has to be spelled `'once'`.
 * - More than one attempt with no backoff retries at once against a dependency
 *   that is already failing. Here a retry policy without a backoff does not
 *   type-check.
 * - A backoff without jitter retries every job that failed in the same outage
 *   at the same instant, so the recovering service takes the whole backlog as
 *   one burst on every step. `expo()` and `fixed()` always carry jitter, and a
 *   hand-written backoff object does not type-check.
 * - BullMQ keeps completed and failed jobs forever by default. Payloads stay
 *   in Redis (often with addresses or ids in them) and memory grows without a
 *   bound. Here both retention windows are required and need an age.
 */

declare const backoffBrand: unique symbol;
declare const paceFactoryBrand: unique symbol;

/** Attempt counts a retrying queue may use. Past 20 a job outlives any incident it could wait out. */
export type RetryAttempts =
  2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;

/** A backoff built by `expo()` or `fixed()`. The brand keeps hand-written objects out. */
export interface Backoff {
  readonly [backoffBrand]: true;
  readonly type: 'exponential' | 'fixed';
  readonly delayMs: number;
  readonly jitter: number;
}

/** Options for `expo()` and `fixed()`. */
export interface BackoffOptions {
  /**
   * The fraction of each delay that is randomised, above 0 and at most 1.
   * Defaults to 0.5: a retry waits at least half its step, and the backlog
   * spreads over the other half.
   */
  readonly jitter?: number;
}

/** The default jitter: half of each step is randomised. */
export const DEFAULT_JITTER = 0.5;

function backoff(type: Backoff['type'], delay: Duration, options: BackoffOptions): Backoff {
  const jitter = options.jitter ?? DEFAULT_JITTER;

  if (!(jitter > 0 && jitter <= 1)) {
    throw new RangeError(
      'backoff jitter must be above 0 and at most 1; a backoff without jitter retries a whole outage at once.',
    );
  }

  return { type, delayMs: toMilliseconds(delay, 'backoff delay'), jitter } as Backoff;
}

/** Exponential backoff: attempt n waits about `2^(n-1) * delay`, with jitter. */
export function expo(delay: Duration, options: BackoffOptions = {}): Backoff {
  return backoff('exponential', delay, options);
}

/** Fixed backoff: every retry waits about `delay`, with jitter. */
export function fixed(delay: Duration, options: BackoffOptions = {}): Backoff {
  return backoff('fixed', delay, options);
}

/**
 * How long finished jobs are kept: a duration, or an age with an optional
 * count cap. An age is required because every field of BullMQ's own
 * `KeepJobs` is optional on its own, so "keep forever" would type-check.
 */
export type Retention = Duration | { readonly age: Duration; readonly count?: number };

/** Retention for both finished sets. */
export interface RetentionPolicy {
  readonly completed: Retention;
  /** The failed set is the dead-letter queue: keep it long enough to look at. */
  readonly failed: Retention;
}

/** At most `max` jobs per `per`, counted in Redis across every replica. */
export interface Pace {
  readonly max: number;
  readonly per: Duration;
}

/** A pace that comes from the app's configuration, resolved through Nest DI at boot. */
export interface PaceFactory {
  readonly [paceFactoryBrand]: true;
  readonly inject: readonly InjectionToken[];
  readonly useFactory: (...dependencies: never[]) => Pace;
}

/**
 * A pace read from injected providers (usually `ConfigService`), for limits
 * that belong to a deployment: a provider's plan, a relay's policy.
 */
export function paceFrom<const Tokens extends readonly InjectionToken[]>(source: {
  readonly inject: Tokens;
  readonly useFactory: (...dependencies: never[]) => Pace;
}): PaceFactory {
  return { inject: source.inject, useFactory: source.useFactory } as unknown as PaceFactory;
}

/** Retrying: 2 to 20 attempts, always with a backoff. */
export interface RetryingPolicy {
  readonly attempts: RetryAttempts;
  readonly backoff: Backoff;
}

/**
 * Exactly one attempt, spelled out. For work where a retry is wrong (a
 * non-idempotent call) or pointless (a sweep whose next tick is the retry).
 */
export interface SingleAttemptPolicy {
  readonly attempts: 'once';
  readonly backoff?: never;
}

/** Everything `defineQueue` needs. */
export type QueuePolicy = (RetryingPolicy | SingleAttemptPolicy) & {
  readonly keep: RetentionPolicy;
  /** Jobs one worker process runs at once. A whole number of at least 1. */
  readonly concurrency: number;
  /** Optional rate limit for the queue as a whole. */
  readonly pace?: Pace | PaceFactory;
};

/** A policy turned into what BullMQ reads. */
export interface ResolvedPolicy {
  readonly attempts: number;
  readonly jobOptions: JobsOptions;
  readonly concurrency: number;
  readonly pace: Pace | PaceFactory | undefined;
}

declare const jobsType: unique symbol;

/** The job names of a queue mapped to their payloads. Payloads are plain objects. */
export type JobMap = Record<string, object>;

/** A queue: its name, its policy and (in the type only) its jobs. */
export interface QueueDefinition<Jobs extends object = JobMap> {
  readonly name: string;
  readonly policy: ResolvedPolicy;
  /** Phantom field carrying the job map for type inference. Never set. */
  readonly [jobsType]?: Jobs;
}

/** The job map of a queue definition. */
export type JobsOf<Q> = Q extends QueueDefinition<infer Jobs> ? Jobs : never;

const NAME = /^[A-Za-z0-9][\w.-]{0,99}$/u;

/** Checks a queue, job or sweep name: letters, digits, `.`, `_` and `-`, no colon. */
export function assertName(name: string, what: string): void {
  if (!NAME.test(name)) {
    throw new TypeError(
      `${what} "${name}" must be 1 to 100 letters, digits, ".", "_" or "-" (no colon: BullMQ uses ":" in its keys).`,
    );
  }
}

function keepJobs(retention: Retention, what: string): KeepJobs {
  if (typeof retention === 'number' || typeof retention === 'string') {
    return { age: toSeconds(retention, what) };
  }

  const keep: KeepJobs = { age: toSeconds(retention.age, what) };

  if (retention.count !== undefined) {
    if (!Number.isSafeInteger(retention.count) || retention.count < 1) {
      throw new RangeError(`${what}: count must be a whole number of at least 1.`);
    }

    keep.count = retention.count;
  }

  return keep;
}

function isPaceFactory(pace: Pace | PaceFactory): pace is PaceFactory {
  return 'useFactory' in pace;
}

/** Checks a static pace and converts it to BullMQ's limiter. */
export function toLimiter(pace: Pace, queue: string): { max: number; duration: number } {
  if (!Number.isSafeInteger(pace.max) || pace.max < 1) {
    throw new RangeError(`queue "${queue}": pace.max must be a whole number of at least 1.`);
  }

  return { max: pace.max, duration: toMilliseconds(pace.per, `queue "${queue}" pace.per`) };
}

/** Validates a policy and converts it to BullMQ job options. */
export function resolvePolicy(name: string, policy: QueuePolicy): ResolvedPolicy {
  const what = `queue "${name}"`;

  if (!Number.isSafeInteger(policy.concurrency) || policy.concurrency < 1) {
    throw new RangeError(`${what}: concurrency must be a whole number of at least 1.`);
  }

  const jobOptions: JobsOptions = {
    removeOnComplete: keepJobs(policy.keep.completed, `${what} keep.completed`),
    removeOnFail: keepJobs(policy.keep.failed, `${what} keep.failed`),
  };

  let attempts = 1;

  if (policy.attempts === 'once') {
    jobOptions.attempts = 1;
  } else {
    if (!Number.isSafeInteger(policy.attempts) || policy.attempts < 2 || policy.attempts > 20) {
      throw new RangeError(`${what}: attempts must be "once" or a whole number from 2 to 20.`);
    }

    const { backoff: chosen } = policy as { backoff?: Partial<Backoff> };

    if (
      chosen === undefined ||
      (chosen.type !== 'exponential' && chosen.type !== 'fixed') ||
      !Number.isSafeInteger(chosen.delayMs) ||
      !(typeof chosen.jitter === 'number' && chosen.jitter > 0 && chosen.jitter <= 1)
    ) {
      throw new TypeError(`${what}: a retrying queue needs a backoff built by expo() or fixed().`);
    }

    attempts = policy.attempts;
    jobOptions.attempts = policy.attempts;

    jobOptions.backoff = {
      type: policy.backoff.type,
      delay: policy.backoff.delayMs,
      jitter: policy.backoff.jitter,
    };
  }

  if (policy.pace !== undefined && !isPaceFactory(policy.pace)) toLimiter(policy.pace, name);

  return { attempts, jobOptions, concurrency: policy.concurrency, pace: policy.pace };
}

/**
 * Defines a queue: its name, its typed jobs and its policy.
 *
 * ```ts
 * type MailJobs = { verify: { userId: string }; digest: { day: string } };
 *
 * export const mail = defineQueue<MailJobs>('email-delivery', {
 *   attempts: 5,
 *   backoff: expo('2s'),
 *   keep: { completed: '1h', failed: '7d' },
 *   concurrency: 5,
 * });
 * ```
 */
export function defineQueue<Jobs extends Record<keyof Jobs, object>>(
  name: string,
  policy: QueuePolicy,
): QueueDefinition<Jobs> {
  assertName(name, 'queue name');

  return { name, policy: resolvePolicy(name, policy) };
}

export { isPaceFactory };
