import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner, ModuleRef, Reflector } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import {
  Queue,
  Worker as BullWorker,
  type Job,
  type RedisOptions as BullRedisOptions,
} from 'bullmq';
import type { Redis, RedisOptions } from 'ioredis';

import {
  DEFAULT_PRODUCER_COMMAND_TIMEOUT_MS,
  closeRedisClient,
  createProducerConnection,
  workerConnectionOptions,
  type RedisCloseOutcome,
} from './connections';
import {
  SWEEP_METADATA,
  WORKER_METADATA,
  type SweepContext,
  type SweepMetadata,
} from './decorators';
import { now } from './clock';
import { toMilliseconds } from './duration';
import { HOST_BINDING, JobHost } from './job-host';
import { JobQueue } from './job-queue';
import { runJob } from './job-runner';
import { JOBS_OPTIONS, type JobsModuleOptions } from './jobs.options';
import {
  assertName,
  defineQueue,
  isPaceFactory,
  toLimiter,
  type JobMap,
  type Pace,
  type QueueDefinition,
} from './policy';
import { parseRedisUrl, redactRedisUrl } from './redis-url';

/**
 * The process-wide part of the package: the producer connection, one
 * `JobQueue` per queue name, the workers and the sweep schedulers.
 *
 * Workers and schedulers start in `onApplicationBootstrap`, after every
 * provider exists, so a pace read from `ConfigService` is available and no
 * job runs against a half-built app. Stopping is split in two on purpose:
 * `drain()` stops taking work and waits (bounded) for running jobs, and
 * `close()` then closes the queues and the producer connection. The graceful
 * shutdown helper calls `drain()` BEFORE `app.close()`, so a job never runs
 * against a database client another module already closed.
 */

/** The default time `drain()` waits for running jobs before it abandons them. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 20_000;

/** The default name of the queue that carries sweep ticks. */
export const DEFAULT_SWEEPS_QUEUE = 'jobs-sweeps';

/** ioredis statuses that mean the producer has lost Redis. */
const DOWN_STATUSES = new Set(['reconnecting', 'close', 'end']);

/** How long boot waits for the sweep schedulers before it moves on. */
const SCHEDULE_AT_BOOT_TIMEOUT_MS = 5_000;

/** How long one Redis QUIT may take at shutdown. */
const QUIT_TIMEOUT_MS = 2_000;

/** What `drain()` reports. */
export interface DrainResult {
  /** Queues whose worker finished its running jobs in time. */
  readonly drained: readonly string[];
  /** Queues whose worker was closed with jobs still running; those jobs return as stalled. */
  readonly abandoned: readonly string[];
}

interface DiscoveredSweep {
  readonly metadata: SweepMetadata;
  readonly run: (context: SweepContext) => Promise<unknown>;
  readonly owner: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Injectable()
export class JobsRuntime implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger('Jobs');
  private readonly baseConnection: RedisOptions;
  private readonly producer: Redis;
  private readonly commandTimeoutMs: number;
  private readonly queues = new Map<string, JobQueue<object>>();
  private readonly workers = new Map<string, BullWorker>();
  private readonly limiterMax = new Map<string, number>();
  private sweepNames: readonly string[] = [];
  private draining: Promise<DrainResult> | undefined;
  private closing: Promise<void> | undefined;
  private connectionDown = false;
  private sweepsScheduled: Promise<void> = Promise.resolve();

  constructor(
    @Inject(JOBS_OPTIONS) private readonly options: JobsModuleOptions,
    // Every dependency is named with @Inject: the build does not emit decorator
    // metadata, so nothing here may rely on the parameter types.
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {
    this.baseConnection = parseRedisUrl(options.redisUrl);

    this.commandTimeoutMs =
      options.producer?.commandTimeoutMs ?? DEFAULT_PRODUCER_COMMAND_TIMEOUT_MS;

    this.producer = createProducerConnection(this.baseConnection, this.commandTimeoutMs);

    // One line per outage, not one per reconnect attempt.
    this.producer.on('error', (error: Error) => {
      if (this.connectionDown) return;

      this.connectionDown = true;

      this.logger.warn('Producer connection to Redis lost; enqueues fail until it is back', {
        redis: redactRedisUrl(options.redisUrl),
        error: error.message,
      });
    });

    this.producer.on('ready', () => {
      if (!this.connectionDown) return;

      this.connectionDown = false;
      this.logger.log('Producer connection to Redis is back');
    });
  }

  /** The shared producer client. Exposed for health checks; never send blocking commands on it. */
  get producerConnection(): Redis {
    return this.producer;
  }

  /** The `JobQueue` of `definition`, created on first use. One policy per queue name. */
  queue<Jobs extends object>(definition: QueueDefinition<Jobs>): JobQueue<Jobs> {
    const existing = this.queues.get(definition.name);

    if (existing !== undefined) {
      if (existing.definition !== definition) {
        throw new Error(
          `queue "${definition.name}" is defined twice; export one defineQueue() and import it everywhere.`,
        );
      }

      return existing as JobQueue<Jobs>;
    }

    const bull = new Queue(definition.name, {
      connection: this.producer,
      defaultJobOptions: definition.policy.jobOptions,
      ...(this.options.prefix !== undefined ? { prefix: this.options.prefix } : {}),
    });

    bull.on('error', (error: Error) => {
      this.logger.warn('Queue error', { queue: definition.name, error: error.message });
    });

    const queue = new JobQueue(definition, bull, {
      context: this.options.context,
      tracing: this.options.telemetry?.tracing,
      limiterMax: () => this.limiterMax.get(definition.name) ?? 1,
      // Down means an outage is known; a first connect still in progress is
      // left to the timer, so an enqueue right after boot is not refused.
      isConnected: () => !DOWN_STATUSES.has(this.producer.status),
      timeoutMs: this.commandTimeoutMs,
    });

    this.queues.set(definition.name, queue);

    return queue;
  }

  async onApplicationBootstrap(): Promise<void> {
    const runWorkers = this.options.workers ?? true;

    if (runWorkers) {
      for (const wrapper of this.discovery.getProviders()) this.startWorkerFor(wrapper);
    }

    await this.scheduleSweeps(runWorkers);
  }

  /** Nest's own shutdown hooks, for apps that do not use the shutdown helper. */
  async onModuleDestroy(): Promise<void> {
    await this.drain();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  /**
   * Stops every worker from taking new jobs and waits up to `timeoutMs` for the
   * running ones. A worker still busy after that is closed anyway: its jobs'
   * locks lapse and another worker picks them up as stalled. Idempotent.
   */
  drain(timeoutMs?: number): Promise<DrainResult> {
    this.draining ??= this.drainWorkers(
      timeoutMs ?? this.options.shutdown?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
    );

    return this.draining;
  }

  /** Drains, then closes every queue and the producer connection, in that order. Idempotent. */
  close(): Promise<void> {
    this.closing ??= this.closeAll();

    return this.closing;
  }

  private async drainWorkers(timeoutMs: number): Promise<DrainResult> {
    const outcomes = await Promise.all(
      [...this.workers].map(async ([name, worker]) => {
        let timer: NodeJS.Timeout | undefined;

        const timedOut = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
          timer.unref();
        });

        // pause() stops fetching and resolves when the running jobs finish.
        const finished = worker.pause().then(
          () => 'drained' as const,
          () => 'drained' as const,
        );

        const outcome = await Promise.race([finished, timedOut]);

        clearTimeout(timer);
        await worker.close(outcome === 'timeout');

        return [name, outcome] as const;
      }),
    );

    const result: DrainResult = {
      drained: outcomes.filter(([, outcome]) => outcome === 'drained').map(([name]) => name),
      abandoned: outcomes.filter(([, outcome]) => outcome === 'timeout').map(([name]) => name),
    };

    if (result.abandoned.length > 0) {
      this.logger.warn('Workers closed with jobs still running; they will return as stalled', {
        ...result,
      });
    } else if (result.drained.length > 0) {
      this.logger.log('Workers drained', { ...result });
    }

    return result;
  }

  private async closeAll(): Promise<void> {
    await this.drain();

    await Promise.all(
      [...this.queues.values()].map((queue) =>
        queue.bull.close().catch((error: unknown) => {
          this.logger.warn('Queue close failed', { queue: queue.name, error: errorMessage(error) });
        }),
      ),
    );

    const outcome: RedisCloseOutcome = await closeRedisClient(this.producer, QUIT_TIMEOUT_MS);

    this.logger.log('Jobs connections closed', { producer: outcome });
  }

  private resolveLimiter(
    definition: QueueDefinition<object>,
  ): { max: number; duration: number } | undefined {
    const pace = definition.policy.pace;

    if (pace === undefined) return undefined;

    let resolved: Pace;

    if (!isPaceFactory(pace)) {
      resolved = pace;
    } else {
      const dependencies: unknown[] = pace.inject.map((token) =>
        this.moduleRef.get<unknown>(token, { strict: false }),
      );

      resolved = pace.useFactory(...(dependencies as never[]));
    }

    const limiter = toLimiter(resolved, definition.name);

    this.limiterMax.set(definition.name, limiter.max);

    return limiter;
  }

  private startWorkerFor(wrapper: InstanceWrapper): void {
    const metatype: unknown = wrapper.metatype;
    const instance: unknown = wrapper.instance;

    if (typeof metatype !== 'function') return;

    const definition = this.reflector.get<QueueDefinition<object> | undefined>(
      WORKER_METADATA,
      metatype,
    );

    if (definition === undefined) return;

    if (!wrapper.isDependencyTreeStatic() || !(instance instanceof JobHost)) {
      throw new Error(
        `@Worker class ${metatype.name} must extend JobHost and be a singleton (no request scope).`,
      );
    }

    if (this.workers.has(definition.name)) {
      throw new Error(`queue "${definition.name}" has two @Worker classes; give it one.`);
    }

    const queue = this.queue(definition);
    const limiter = this.resolveLimiter(definition);
    const host = instance as JobHost;

    host[HOST_BINDING] = { pauseFor: (ms) => queue.pauseFor(ms) };

    const deps = {
      telemetry: this.options.telemetry ?? {},
      context: this.options.context,
      logger: new Logger(metatype.name),
    };

    this.startWorker(definition.name, (job) => runJob(host, job, deps), {
      concurrency: definition.policy.concurrency,
      limiter,
    });
  }

  private startWorker(
    name: string,
    processor: (job: Job) => Promise<unknown>,
    settings: { concurrency: number; limiter?: { max: number; duration: number } | undefined },
  ): void {
    const worker = new BullWorker(name, processor, {
      // ioredis and BullMQ describe the same options with slightly different
      // types (BullMQ's retryStrategy return type); the values are ioredis's.
      connection: workerConnectionOptions(this.baseConnection) as BullRedisOptions,
      concurrency: settings.concurrency,
      ...(settings.limiter !== undefined ? { limiter: settings.limiter } : {}),
      ...(this.options.prefix !== undefined ? { prefix: this.options.prefix } : {}),
    });

    // A Worker emits 'error' for connection trouble; an EventEmitter with no
    // listener for 'error' throws it and takes the process down.
    worker.on('error', (error: Error) => {
      this.logger.warn('Worker error', { queue: name, error: error.message });
    });

    this.workers.set(name, worker);
  }

  private discoverSweeps(): DiscoveredSweep[] {
    const found: DiscoveredSweep[] = [];

    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;

      if (instance === null || typeof instance !== 'object') continue;

      const prototype: unknown = Object.getPrototypeOf(instance);

      if (prototype === null || typeof prototype !== 'object') continue;

      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const target: unknown = (instance as Record<string, unknown>)[method];

        if (typeof target !== 'function') continue;

        const metadata = this.reflector.get<SweepMetadata | undefined>(
          SWEEP_METADATA,
          target as () => unknown,
        );

        if (metadata === undefined) continue;

        if (!wrapper.isDependencyTreeStatic()) {
          throw new Error(`@Sweep "${metadata.name}" is on a request-scoped provider.`);
        }

        const fn = target as (context: SweepContext) => unknown;

        found.push({
          metadata,
          run: (context) => Promise.resolve().then(() => fn.call(instance, context)),
          owner: `${instance.constructor.name}.${method}`,
        });
      }
    }

    return found;
  }

  private repeatOptions(
    metadata: SweepMetadata,
  ): { pattern: string; tz: string } | { every: number } {
    const { schedule, name } = metadata;

    if (schedule.every !== undefined) {
      return { every: toMilliseconds(schedule.every, `sweep "${name}" every`) };
    }

    if (schedule.cron.trim() === '' || schedule.tz.trim() === '') {
      throw new TypeError(`sweep "${name}" needs both a cron pattern and a time zone.`);
    }

    return { pattern: schedule.cron, tz: schedule.tz };
  }

  /**
   * Upserts one BullMQ job scheduler per sweep and removes every other
   * scheduler on the sweeps queue.
   *
   * A job scheduler produces ONE job per tick, under an id derived from the
   * scheduler id and the tick's time, so however many replicas upsert it, one
   * worker runs each tick. The reconcile is what makes renames safe: a
   * scheduler keeps firing until it is removed, so a renamed or deleted sweep
   * whose old scheduler stayed in Redis would run (or fail as unknown) forever.
   * The sweeps queue belongs to this app alone for that reason.
   */
  private async scheduleSweeps(runWorkers: boolean): Promise<void> {
    const sweeps = this.discoverSweeps();
    const settings = this.options.sweeps ?? {};
    const queueName = settings.queue ?? DEFAULT_SWEEPS_QUEUE;
    const byName = new Map<string, DiscoveredSweep>();

    for (const sweep of sweeps) {
      assertName(sweep.metadata.name, 'sweep name');
      this.repeatOptions(sweep.metadata);

      const other = byName.get(sweep.metadata.name);

      if (other !== undefined) {
        throw new Error(
          `sweep "${sweep.metadata.name}" is declared twice (${other.owner} and ${sweep.owner}).`,
        );
      }

      byName.set(sweep.metadata.name, sweep);
    }

    this.sweepNames = [...byName.keys()];

    if (sweeps.length === 0 && settings.reconcile === false) {
      this.sweepsScheduled = Promise.resolve();

      return;
    }

    const definition: QueueDefinition<JobMap> = defineQueue<JobMap>(queueName, {
      attempts: 'once',
      keep: { completed: { age: '1d', count: 1_000 }, failed: { age: '14d', count: 1_000 } },
      concurrency: settings.concurrency ?? 1,
    });

    const queue = this.queue(definition);

    if (runWorkers && sweeps.length > 0) {
      this.startWorker(queueName, (job) => this.runSweep(byName, job), {
        concurrency: definition.policy.concurrency,
      });
    }

    this.sweepsScheduled = this.applySchedulersUntilDone(queue, byName);

    // Wait for the schedulers at boot so a healthy start is deterministic, but
    // never hold the app hostage to Redis: past the bound they are applied in
    // the background as soon as Redis answers.
    let timer: NodeJS.Timeout | undefined;

    const bound = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SCHEDULE_AT_BOOT_TIMEOUT_MS);
      timer.unref();
    });

    const outcome = await Promise.race([this.sweepsScheduled.then(() => 'done' as const), bound]);

    clearTimeout(timer);

    if (outcome === 'timeout') {
      this.logger.warn('Redis did not answer at boot; sweeps will be scheduled once it does', {
        queue: queueName,
      });
    }
  }

  /** Upserts and reconciles, retrying with backoff until it works or the runtime closes. */
  private async applySchedulersUntilDone(
    queue: JobQueue<JobMap>,
    sweeps: ReadonlyMap<string, DiscoveredSweep>,
  ): Promise<void> {
    for (let attempt = 0; this.closing === undefined; attempt += 1) {
      try {
        await this.applySchedulers(queue, sweeps);

        return;
      } catch (error) {
        if (this.closing !== undefined) return;

        const waitMs = Math.min(1_000 * 2 ** attempt, 30_000);

        this.logger.warn('Scheduling sweeps failed; retrying', {
          queue: queue.name,
          retryInMs: waitMs,
          error: errorMessage(error),
        });

        await new Promise<void>((resolve) => setTimeout(resolve, waitMs).unref());
      }
    }
  }

  private async applySchedulers(
    queue: JobQueue<JobMap>,
    sweeps: ReadonlyMap<string, DiscoveredSweep>,
  ): Promise<void> {
    for (const sweep of sweeps.values()) {
      await queue.bull.upsertJobScheduler(sweep.metadata.name, this.repeatOptions(sweep.metadata), {
        name: sweep.metadata.name,
        data: {},
      });
    }

    let removed: string[] = [];

    if (this.options.sweeps?.reconcile !== false) {
      const schedulers = await queue.bull.getJobSchedulers(0, -1);

      removed = schedulers.map((scheduler) => scheduler.key).filter((key) => !sweeps.has(key));

      for (const key of removed) await queue.bull.removeJobScheduler(key);
    }

    if (sweeps.size > 0 || removed.length > 0) {
      this.logger.log('Sweeps scheduled', { queue: queue.name, sweeps: this.sweepNames, removed });
    }
  }

  /** Resolves once the sweep schedulers are in Redis and stale ones are removed. */
  whenSweepsScheduled(): Promise<void> {
    return this.sweepsScheduled;
  }

  private async runSweep(sweeps: ReadonlyMap<string, DiscoveredSweep>, job: Job): Promise<unknown> {
    const sweep = sweeps.get(job.name);
    const jobId = job.id ?? 'unknown';

    if (sweep === undefined) {
      // A tick from a scheduler another version of the app still declares.
      this.logger.warn('Skipped a tick of a sweep this app does not declare', {
        sweep: job.name,
        jobId,
      });

      return { skipped: true };
    }

    const name = sweep.metadata.name;
    const { metrics, errors, tracing } = this.options.telemetry ?? {};

    const context: SweepContext = {
      name,
      scheduledAt: new Date(job.timestamp + (job.opts.delay ?? 0)),
      jobId,
    };

    const tick = async (): Promise<unknown> => {
      try {
        const result = await sweep.run(context);

        metrics?.sweepSucceeded?.(name, now());

        return result;
      } catch (error) {
        metrics?.sweepFailed?.(name);

        this.logger.error('Sweep failed; the next tick runs as scheduled', {
          sweep: name,
          jobId,
          error: errorMessage(error),
        });

        try {
          errors?.report(error, { kind: 'sweep', sweep: name, jobId });
          await this.options.sweeps?.onError?.(name, error);
        } catch (hookError) {
          this.logger.warn('Sweep error hook threw; ignored', {
            sweep: name,
            error: errorMessage(hookError),
          });
        }

        throw error;
      }
    };

    if (tracing === undefined) return tick();

    return tracing.runInSpan(`jobs.sweep ${name}`, { 'jobs.sweep': name }, {}, tick);
  }

  /** The sweeps scheduled at boot, by name. */
  get scheduledSweeps(): readonly string[] {
    return this.sweepNames;
  }
}
