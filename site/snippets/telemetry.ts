// telemetry.ts
import * as otel from '@opentelemetry/api';
import {
  openTelemetryTracing,
  prometheusMetrics,
  sentryReporter,
  type JobsTelemetry,
  type PromClientLike,
} from '@noctcore/jobs';
import * as Sentry from '@sentry/node';
import * as promClient from 'prom-client';

export const telemetry: JobsTelemetry = {
  // jobs_job_duration_seconds, jobs_job_failures_total, jobs_sweep_failures_total,
  // jobs_sweep_last_success_timestamp_seconds
  // In 0.1.0, PromClientLike types `registers` more loosely than prom-client 15
  // does, so the module needs a cast to compile. The adapter itself works.
  metrics: prometheusMetrics(promClient as unknown as PromClientLike),
  tracing: openTelemetryTracing(otel),
  errors: sentryReporter(Sentry),
};

export async function flushTelemetry(): Promise<void> {
  await Sentry.flush(2_000);
}
