import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { queueToken } from './decorators';
import { JOBS_OPTIONS, type JobsModuleAsyncOptions, type JobsModuleOptions } from './jobs.options';
import { JobsRuntime } from './jobs.runtime';
import type { QueueDefinition } from './policy';

/**
 * `JobsModule.forRoot(...)` once in the root module, `JobsModule.forFeature([queue])`
 * in each module that enqueues or works a queue.
 *
 * The root module is global: it owns the producer connection and the runtime
 * that starts workers and sweeps. `forFeature` only provides the `JobQueue` of
 * each queue for `@InjectQueue`.
 */
@Module({})
export class JobsModule {
  static forRoot(options: JobsModuleOptions): DynamicModule {
    return JobsModule.root([{ provide: JOBS_OPTIONS, useValue: options }], []);
  }

  static forRootAsync(options: JobsModuleAsyncOptions): DynamicModule {
    return JobsModule.root(
      [
        {
          provide: JOBS_OPTIONS,
          inject: options.inject ?? [],
          useFactory: options.useFactory,
        },
      ],
      options.imports ?? [],
    );
  }

  static forFeature(queues: readonly QueueDefinition<object>[]): DynamicModule {
    const providers: Provider[] = queues.map((definition) => ({
      provide: queueToken(definition),
      inject: [JobsRuntime],
      useFactory: (runtime: JobsRuntime) => runtime.queue(definition),
    }));

    return { module: JobsModule, providers, exports: providers };
  }

  private static root(
    providers: Provider[],
    imports: NonNullable<JobsModuleAsyncOptions['imports']>,
  ): DynamicModule {
    return {
      module: JobsModule,
      global: true,
      imports: [DiscoveryModule, ...imports],
      providers: [...providers, JobsRuntime],
      exports: [JobsRuntime],
    };
  }
}
