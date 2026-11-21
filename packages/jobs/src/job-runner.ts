import type { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';

import { isFinalAttempt, isQueuePauseSignal, type JobHost, type JobRun } from './job-host';
import { openJobData, type JobContextHook } from './job-context';
import type { JobsTelemetry, JobSpan } from './telemetry';

/**
 * Runs one attempt of one job through its host: the envelope is opened, the
 * producer's context re-entered, the attempt wrapped in a span, and the outcome
 * recorded. Lives apart from the Nest wiring so it can be tested with a plain
 * object standing in for a BullMQ job.
 */

export interface RunDeps {
  readonly telemetry: JobsTelemetry;
  readonly context: JobContextHook | undefined;
  readonly logger: Pick<Logger, 'warn' | 'error'>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toFatal(error: unknown): UnrecoverableError {
  const fatalError = new UnrecoverableError(errorMessage(error));

  Object.defineProperty(fatalError, 'cause', { value: error, enumerable: false });

  return fatalError;
}

/** Runs `fn` safely: a hook that throws is logged, never allowed to change the outcome. */
async function guarded(
  logger: RunDeps['logger'],
  what: string,
  fn: () => unknown,
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.warn('A failure hook threw; ignored', {
      ...fields,
      hook: what,
      error: errorMessage(error),
    });
  }
}

export async function runJob(host: JobHost, job: Job, deps: RunDeps): Promise<unknown> {
  const opened = openJobData(job.data);
  const jobId = job.id ?? 'unknown';
  const fields = { queue: job.queueName, job: job.name, jobId };

  if (opened.dropped) {
    deps.logger.warn('Dropped a malformed job context envelope; the job runs without it', fields);
  }

  const run: JobRun = {
    name: job.name,
    data: opened.data,
    id: jobId,
    queue: job.queueName,
    attempt: job.attemptsMade + 1,
    maxAttempts: job.opts.attempts ?? 1,
    context: opened.ctx,
    raw: job,
  };

  const { metrics, errors, tracing } = deps.telemetry;
  const labels = { queue: job.queueName, job: job.name };

  const attempt = async (span: JobSpan | undefined): Promise<unknown> => {
    const started = performance.now();
    let ok = false;

    try {
      const handle = (): Promise<unknown> => host.handle(run as never);

      const result =
        deps.context !== undefined && Object.keys(opened.ctx).length > 0
          ? await deps.context.run(opened.ctx, handle)
          : await handle();

      ok = true;

      return result;
    } catch (thrown) {
      if (isQueuePauseSignal(thrown)) {
        // The handler paused the queue and handed the job back: no attempt was
        // used and nothing failed, so it is not counted, reported or logged.
        span?.addEvent('jobs.queue_paused');

        throw thrown;
      }

      const error =
        !(thrown instanceof UnrecoverableError) && host.classify?.(thrown) === 'fatal'
          ? toFatal(thrown)
          : thrown;

      const final = isFinalAttempt(job, error);

      span?.recordException(error);
      span?.setError(errorMessage(error));
      metrics?.jobFailed?.({ ...labels, final });

      deps.logger.error(final ? 'Job failed for good' : 'Job attempt failed; it will be retried', {
        ...fields,
        attempt: run.attempt,
        maxAttempts: run.maxAttempts,
        error: errorMessage(error),
      });

      if (final) {
        await guarded(
          deps.logger,
          'ErrorReporter.report',
          () =>
            errors?.report(error, {
              kind: 'job',
              ...labels,
              jobId,
              attempt: run.attempt,
              maxAttempts: run.maxAttempts,
              context: opened.ctx,
            }),
          fields,
        );

        await guarded(
          deps.logger,
          'onFinalFailure',
          () => host.onFinalFailure?.(run as never, error),
          fields,
        );
      }

      throw error;
    } finally {
      metrics?.jobAttempt?.({ ...labels, ok }, (performance.now() - started) / 1_000);
    }
  };

  if (tracing === undefined) return attempt(undefined);

  return tracing.runInSpan(
    `jobs.process ${job.queueName}`,
    {
      'messaging.system': 'bullmq',
      'messaging.destination.name': job.queueName,
      'messaging.bullmq.job.name': job.name,
      'messaging.message.id': jobId,
      'messaging.bullmq.job.attempt': run.attempt,
    },
    opened.trace,
    attempt,
  );
}
