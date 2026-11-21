// jobs.config.ts
import { AsyncLocalStorage } from 'node:async_hooks';

import type { JobsModuleOptions } from '@noctcore/jobs';

import { telemetry } from './telemetry';

export const als = new AsyncLocalStorage<{ requestId: string }>();

export function jobsOptions(redisUrl: string): JobsModuleOptions {
  return {
    redisUrl,
    telemetry,
    context: {
      // On add(): what to carry. Ids only, never secrets; at most 32 string fields.
      capture: () => ({ requestId: als.getStore()?.requestId ?? '' }),
      // In the worker: re-enter it around handle().
      run: (ctx, fn) => als.run({ requestId: ctx['requestId'] ?? '' }, fn),
    },
  };
}
