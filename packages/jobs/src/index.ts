/**
 * @noctcore/jobs: BullMQ for NestJS with the safe choice made the default.
 * Each export's module says which trap it exists for.
 */
export { JobsModule } from './jobs.module';
export { JOBS_OPTIONS, type JobsModuleOptions, type JobsModuleAsyncOptions } from './jobs.options';
export {
  JobsRuntime,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_SWEEPS_QUEUE,
  type DrainResult,
} from './jobs.runtime';
export {
  defineQueue,
  expo,
  fixed,
  paceFrom,
  DEFAULT_JITTER,
  type Backoff,
  type BackoffOptions,
  type JobMap,
  type JobsOf,
  type Pace,
  type PaceFactory,
  type QueueDefinition,
  type QueuePolicy,
  type ResolvedPolicy,
  type Retention,
  type RetentionPolicy,
  type RetryAttempts,
  type RetryingPolicy,
  type SingleAttemptPolicy,
} from './policy';
export { dedupe, dedupeId, type Dedupe, type DedupeKey } from './dedupe';
export { EnqueueUnavailableError, JobQueue, type AddOptions, type AddResult } from './job-queue';
export { QueuePause } from './queue-pause';
export {
  JobHost,
  UnrecoverableError,
  fatal,
  isFinalAttempt,
  isQueuePauseSignal,
  type FailureKind,
  type JobOf,
  type JobRun,
} from './job-host';
export {
  InjectQueue,
  Sweep,
  Worker,
  queueToken,
  type SweepContext,
  type SweepSchedule,
} from './decorators';
export { ENVELOPE_KEY, type JobContextHook } from './job-context';
export {
  installGracefulShutdown,
  shutdownGracefully,
  DEFAULT_SHUTDOWN_DEADLINE_MS,
  SHUTDOWN_SIGNALS,
  type GracefulShutdownOptions,
  type ShutdownReport,
} from './shutdown';
export { parseRedisUrl, redactRedisUrl } from './redis-url';
export {
  DEFAULT_PRODUCER_COMMAND_TIMEOUT_MS,
  producerConnectionOptions,
  workerConnectionOptions,
} from './connections';
export {
  prometheusMetrics,
  openTelemetryTracing,
  sentryReporter,
  DEFAULT_DURATION_BUCKETS,
  type ErrorReporter,
  type FailureContext,
  type JobLabels,
  type JobSpan,
  type JobsMetrics,
  type JobsTelemetry,
  type JobsTracing,
  type OpenTelemetryApiLike,
  type PromClientLike,
  type PrometheusMetricsOptions,
  type SentryLike,
} from './telemetry';
export type { Duration, DurationUnit } from './duration';
