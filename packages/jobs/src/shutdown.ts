import { Logger, type INestApplicationContext } from '@nestjs/common';

import { JobsRuntime, type DrainResult } from './jobs.runtime';

/**
 * The answer to SIGTERM for an app that runs workers.
 *
 * ORDER:
 *
 * 1. Drain the workers: stop taking jobs and wait (bounded) for the running
 *    ones. This comes BEFORE `app.close()`, because Nest runs the other
 *    modules' destroy hooks in an order no provider controls, and a job that
 *    is still running when the database module disconnects fails half done.
 * 2. `app.close()`: every Nest hook, the HTTP server, and the jobs runtime's
 *    own `onApplicationShutdown`, which closes the queues and then the
 *    producer connection (a bounded QUIT).
 * 3. Flush telemetry (the app's spans and events, the last jobs included).
 * 4. Leave by re-raising the signal, so the orchestrator sees the signal's
 *    exit code, as it would from Nest's own `enableShutdownHooks()`.
 *
 * A deadline bounds the whole sequence below the orchestrator's grace period:
 * past it the process flushes and exits non-zero instead of being SIGKILLed
 * mid-flush. Do not also call `app.enableShutdownHooks()`: two handlers would
 * race to end the process.
 */

/** The signals a container runtime and a terminal send to stop a process. */
export const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/** The exit code when the shutdown failed or ran out of time. */
export const SHUTDOWN_FAILED_EXIT_CODE = 1;

/** The default deadline: under the 30 s grace period most orchestrators give. */
export const DEFAULT_SHUTDOWN_DEADLINE_MS = 25_000;

type SignalTarget = Pick<NodeJS.Process, 'on' | 'removeListener'>;

export interface GracefulShutdownOptions {
  /** Signals to handle. Defaults to SIGTERM and SIGINT. */
  readonly signals?: readonly NodeJS.Signals[];
  /** How long to wait for running jobs. Defaults to the module's `shutdown.drainTimeoutMs`. */
  readonly drainTimeoutMs?: number;
  /** Bound on the whole sequence. Defaults to 25000 ms. Keep it above the drain timeout. */
  readonly deadlineMs?: number;
  /** Flushes telemetry; bounded by the deadline, never fails the shutdown. */
  readonly flush?: () => Promise<void>;
  /** Defaults to Nest's Logger. */
  readonly logger?: Pick<Logger, 'log' | 'error'>;
  /** Defaults to `process.kill(process.pid, signal)`. */
  readonly raise?: (signal: NodeJS.Signals) => void;
  /** Defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
  /** Defaults to `process`. */
  readonly target?: SignalTarget;
}

/** What one run of the sequence did. */
export interface ShutdownReport {
  readonly drain: DrainResult | undefined;
  readonly closed: boolean;
  readonly timedOut: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the shutdown sequence once, without touching signals or the process.
 * `installGracefulShutdown` calls it; tests and custom runners can too.
 */
export async function shutdownGracefully(
  app: INestApplicationContext,
  options: Pick<GracefulShutdownOptions, 'drainTimeoutMs' | 'flush' | 'logger' | 'deadlineMs'> = {},
): Promise<ShutdownReport> {
  const logger = options.logger ?? new Logger('Shutdown');
  let drain: DrainResult | undefined;
  let closed = false;

  const sequence = async (): Promise<void> => {
    const runtime = app.get(JobsRuntime, { strict: false });

    drain = await runtime.drain(options.drainTimeoutMs);

    try {
      await app.close();
      closed = true;
      logger.log('Application closed');
    } catch (error) {
      logger.error('Application close failed', { error: errorMessage(error) });
    }
  };

  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(
      () => resolve('timeout'),
      options.deadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS,
    );

    timer.unref();
  });

  const outcome = await Promise.race([sequence().then(() => 'done' as const), deadline]);

  clearTimeout(timer);

  const timedOut = outcome === 'timeout';

  if (timedOut) logger.error('Shutdown deadline reached before the application closed');

  if (options.flush !== undefined) {
    try {
      await options.flush();
    } catch (error) {
      logger.error('Telemetry flush failed', { error: errorMessage(error) });
    }
  }

  return { drain, closed: closed && !timedOut, timedOut };
}

/**
 * Handles SIGTERM and SIGINT with `shutdownGracefully`, then re-raises the
 * signal (or exits non-zero when the shutdown failed). A second signal while
 * the first is being handled is ignored. Returns a function that uninstalls
 * the handlers.
 */
export function installGracefulShutdown(
  app: INestApplicationContext,
  options: GracefulShutdownOptions = {},
): () => void {
  const target = options.target ?? process;
  const signals = options.signals ?? SHUTDOWN_SIGNALS;
  const logger = options.logger ?? new Logger('Shutdown');
  const raise = options.raise ?? ((signal: NodeJS.Signals) => process.kill(process.pid, signal));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;

  const uninstall = (): void => {
    for (const signal of signals) target.removeListener(signal, onSignal);
  };

  function onSignal(signal: NodeJS.Signals): void {
    if (started) {
      logger.log('Shutdown already in progress', { signal });

      return;
    }

    started = true;
    logger.log('Shutdown started', { signal });

    shutdownGracefully(app, { ...options, logger })
      .then((report) => {
        uninstall();

        if (report.closed) raise(signal);
        else exit(SHUTDOWN_FAILED_EXIT_CODE);
      })
      .catch((error: unknown) => {
        logger.error('Shutdown failed', { signal, error: errorMessage(error) });
        uninstall();
        exit(SHUTDOWN_FAILED_EXIT_CODE);
      });
  }

  for (const signal of signals) target.on(signal, onSignal);

  return uninstall;
}
