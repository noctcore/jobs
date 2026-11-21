import type { Queue } from 'bullmq';

import { dedupeId, dedupeJobOptions, type Dedupe, type DedupeKey } from './dedupe';
import { toMilliseconds, type Duration } from './duration';
import { ENVELOPE_KEY, captureEnvelope, type JobContextHook } from './job-context';
import type { JobMap, QueueDefinition } from './policy';
import { QueuePause } from './queue-pause';
import type { JobsTracing } from './telemetry';

/**
 * The producer side of a queue, as injected with `@InjectQueue(definition)`.
 *
 * `add()` takes no `jobId` and no retry or retention options: the policy
 * decided those when the queue was defined, and a caller-built jobId is the
 * dedupe trap `dedupe` exists to replace. It stamps the job context envelope
 * itself, and it rejects at once while Redis is down (the producer connection
 * fails fast), so the caller decides what an enqueue failure means.
 */

/** Options of one `add()`. `dedupe` is required. */
export interface AddOptions {
  /** `dedupe.window(key, ttl)`, `dedupe.until(key)`, `dedupe.debounce(key, wait)` or `dedupe.none()`. */
  readonly dedupe: Dedupe;
  /** Run the job no earlier than this from now. Not allowed with `dedupe.debounce`, which sets its own. */
  readonly delay?: Duration;
  /** BullMQ priority (1 is highest). Leave it out for normal work: prioritised jobs wait behind unprioritised ones. */
  readonly priority?: number;
}

/** What `add()` resolves to. */
export interface AddResult {
  /** The id of the job that holds the work: a new one, or the existing one a dedupe matched. */
  readonly id: string;
}

/** What the runtime hands a `JobQueue`. */
export interface JobQueueDeps {
  readonly context: JobContextHook | undefined;
  readonly tracing: JobsTracing | undefined;
  readonly limiterMax: () => number;
  /** False while the producer connection is known to be down. */
  readonly isConnected: () => boolean;
  /** Hard bound on one producer call, in milliseconds. */
  readonly timeoutMs: number;
}

/** Thrown by `add()` when Redis cannot take the job right now. */
export class EnqueueUnavailableError extends Error {
  override readonly name = 'EnqueueUnavailableError';
}

export class JobQueue<Jobs extends object = JobMap> {
  /** The one pause of this queue; see `QueuePause`. */
  readonly pause: QueuePause;

  constructor(
    readonly definition: QueueDefinition<Jobs>,
    /** The underlying BullMQ queue, for reads this class does not wrap (counts, getJob). */
    readonly bull: Queue,
    private readonly deps: JobQueueDeps,
  ) {
    this.pause = new QueuePause(bull, deps.limiterMax);
  }

  get name(): string {
    return this.definition.name;
  }

  /** Enqueues one job. Rejects at once while Redis is unreachable. */
  async add<Name extends keyof Jobs & string>(
    name: Name,
    data: Jobs[Name],
    options: AddOptions,
  ): Promise<AddResult> {
    const payload = data as unknown;

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new TypeError(`queue "${this.name}": job data must be a plain object.`);
    }

    if (ENVELOPE_KEY in payload) {
      throw new TypeError(`queue "${this.name}": "${ENVELOPE_KEY}" is reserved in job data.`);
    }

    const fromDedupe = dedupeJobOptions(options.dedupe);

    if (fromDedupe.delay !== undefined && options.delay !== undefined) {
      throw new TypeError('dedupe.debounce sets its own delay; do not pass delay with it.');
    }

    const envelope = captureEnvelope(this.deps.context, this.deps.tracing);
    const stamped = envelope === undefined ? payload : { ...payload, [ENVELOPE_KEY]: envelope };

    const job = await this.guard('add', () =>
      this.bull.add(name, stamped, {
        ...fromDedupe,
        ...(options.delay !== undefined ? { delay: toMilliseconds(options.delay, 'delay') } : {}),
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
      }),
    );

    return { id: job.id ?? '' };
  }

  /**
   * Ends a dedupe window early, so the next `add()` with this key enqueues.
   * For a deliberate restart (an admin re-sending a failed announcement).
   * Resolves to whether a window was open.
   */
  async releaseDedupe(key: DedupeKey): Promise<boolean> {
    const id = dedupeId(key);

    return (await this.guard('releaseDedupe', () => this.bull.removeDeduplicationKey(id))) > 0;
  }

  /**
   * Runs one producer call so that it fails fast. BullMQ waits for the
   * connection's first `ready` without a bound, so with Redis unreachable at
   * boot (or a wrong password) a plain `add()` would hang forever; the status
   * check refuses at once, and the timer bounds anything that slips past it.
   */
  private async guard<T>(what: string, call: () => Promise<T>): Promise<T> {
    if (!this.deps.isConnected()) {
      throw new EnqueueUnavailableError(
        `queue "${this.name}": ${what} refused, the producer is not connected to Redis.`,
      );
    }

    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new EnqueueUnavailableError(
              `queue "${this.name}": ${what} timed out after ${this.deps.timeoutMs} ms.`,
            ),
          ),
        this.deps.timeoutMs,
      );

      timer.unref();
    });

    try {
      return await Promise.race([call(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Stops the queue from handing out jobs for at least `ms`; see `QueuePause`. */
  pauseFor(ms: number): Promise<number> {
    return this.pause.forAtLeast(ms);
  }
}
