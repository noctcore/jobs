import { Inject, SetMetadata } from '@nestjs/common';

import type { Duration } from './duration';
import type { QueueDefinition } from './policy';

/**
 * The three decorators: `@Worker(queue)` on a class that extends `JobHost`,
 * `@Sweep(name, schedule)` on a method of any provider, and
 * `@InjectQueue(queue)` on a constructor parameter.
 */

export const WORKER_METADATA = 'noctcore.jobs:worker';
export const SWEEP_METADATA = 'noctcore.jobs:sweep';

/** The DI token of a queue's `JobQueue`. */
export function queueToken(definition: Pick<QueueDefinition, 'name'>): string {
  return `noctcore.jobs:queue:${definition.name}`;
}

/** Marks a `JobHost` subclass as the worker of `queue`. One worker class per queue. */
export function Worker(queue: QueueDefinition<object>): ClassDecorator {
  return SetMetadata(WORKER_METADATA, queue);
}

/** Injects the `JobQueue` of `queue`. The queue must be registered with `JobsModule.forFeature`. */
export function InjectQueue(queue: QueueDefinition<object>): ParameterDecorator {
  return Inject(queueToken(queue));
}

/**
 * When a sweep runs. A cron needs its time zone spelled out: a cron read in the
 * host's zone moves when the container image or the server changes, and
 * shifts by an hour twice a year where the zone has daylight saving time.
 */
export type SweepSchedule =
  | { readonly cron: string; readonly tz: string; readonly every?: never }
  | { readonly every: Duration; readonly cron?: never; readonly tz?: never };

/** What a sweep method receives. */
export interface SweepContext {
  readonly name: string;
  /** When this tick was due. */
  readonly scheduledAt: Date;
  /** The id of the BullMQ job that carried the tick. */
  readonly jobId: string;
}

/** A sweep as recorded on its method. */
export interface SweepMetadata {
  readonly name: string;
  readonly schedule: SweepSchedule;
}

/**
 * Runs the method on a schedule, once per tick across every replica.
 *
 * ```ts
 * @Sweep('token-cleanup', { cron: '0 * * * *', tz: 'UTC' })
 * async cleanup(ctx: SweepContext) { ... }
 * ```
 *
 * The name is the scheduler's id: renaming a sweep removes the old scheduler
 * at the next boot. A failure is counted, reported and logged by the runtime;
 * the method does not need its own try/catch, and the next tick is the retry.
 */
export function Sweep(name: string, schedule: SweepSchedule): MethodDecorator {
  return SetMetadata(SWEEP_METADATA, { name, schedule } satisfies SweepMetadata);
}
