import type { InjectionToken, ModuleMetadata } from '@nestjs/common';

import type { JobContextHook } from './job-context';
import type { JobsTelemetry } from './telemetry';

/** The DI token of the module options. */
export const JOBS_OPTIONS = Symbol('noctcore.jobs:options');

/** Options of `JobsModule.forRoot`. */
export interface JobsModuleOptions {
  /**
   * The full Redis URL: `redis://user:password@host:port/db`, or `rediss://`
   * for TLS. Every connection is built from all of it.
   */
  readonly redisUrl: string;
  /** BullMQ's key prefix. Defaults to BullMQ's own (`bull`). */
  readonly prefix?: string;
  /**
   * Run workers and the sweep worker in this process. Defaults to true. Set it
   * false on replicas that only enqueue.
   */
  readonly workers?: boolean;
  readonly producer?: {
    /**
     * Bound on one Redis command and on one whole `add()`, in milliseconds.
     * Defaults to 3000. While an outage is known, `add()` refuses at once.
     */
    readonly commandTimeoutMs?: number;
  };
  readonly telemetry?: JobsTelemetry;
  /** Carries the app's request context (ids, tenant) from producer to worker. */
  readonly context?: JobContextHook;
  readonly sweeps?: {
    /** The queue that carries sweep ticks. Defaults to `jobs-sweeps`; one per app. */
    readonly queue?: string;
    /** Sweeps one process runs at once. Defaults to 1. */
    readonly concurrency?: number;
    /** Remove schedulers no sweep declares at boot. Defaults to true. */
    readonly reconcile?: boolean;
    /** Called after a sweep fails (after the metric and the error report). */
    readonly onError?: (sweep: string, error: unknown) => void | Promise<void>;
  };
  readonly shutdown?: {
    /**
     * How long draining waits for running jobs. Defaults to 20000 ms, which
     * leaves room for the rest of the shutdown inside the 25 s deadline of
     * `installGracefulShutdown` and a 30 s container stop grace period.
     */
    readonly drainTimeoutMs?: number;
  };
}

/** Options of `JobsModule.forRootAsync`. */
export interface JobsModuleAsyncOptions {
  readonly imports?: ModuleMetadata['imports'];
  readonly inject?: InjectionToken[];
  readonly useFactory: (...dependencies: never[]) => JobsModuleOptions | Promise<JobsModuleOptions>;
}
