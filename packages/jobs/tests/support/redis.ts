import { randomUUID } from 'node:crypto';

import { Module, type DynamicModule, type Provider, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Redis } from 'ioredis';
import { describe } from 'vitest';

import { JobsModule, type JobsModuleOptions, type QueueDefinition } from '../../src';

/**
 * Shared setup for the integration suites: the Redis URLs, a unique key prefix
 * per test so suites never see each other's jobs, and a way to boot a Nest app
 * context with the jobs module.
 */

export const REDIS_URL = process.env['REDIS_URL'];
export const REDIS_AUTH_URL = process.env['REDIS_AUTH_URL'];
const REQUIRE = process.env['JOBS_REQUIRE_SERVICES'] === '1';

if (REQUIRE && (REDIS_URL === undefined || REDIS_AUTH_URL === undefined)) {
  throw new Error('JOBS_REQUIRE_SERVICES=1 but REDIS_URL or REDIS_AUTH_URL is not set.');
}

/** `describe` that skips locally when Redis is not configured. */
export function describeRedis(name: string, suite: () => void): void {
  (REDIS_URL === undefined ? describe.skip : describe)(name, suite);
}

/** The plain Redis URL; only call inside `describeRedis`. */
export function redisUrl(): string {
  if (REDIS_URL === undefined) throw new Error('REDIS_URL is not set');

  return REDIS_URL;
}

export function uniquePrefix(): string {
  return `t${randomUUID().slice(0, 8)}`;
}

/** Deletes every key under `prefix`. */
export async function dropPrefix(url: string, prefix: string): Promise<void> {
  const client = new Redis(url);

  try {
    let cursor = '0';

    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 1000);

      cursor = next;

      if (keys.length > 0) await client.del(...keys);
    } while (cursor !== '0');
  } finally {
    client.disconnect();
  }
}

export interface AppSpec {
  readonly options: JobsModuleOptions;
  readonly queues?: readonly QueueDefinition<object>[];
  readonly providers?: readonly (Provider | Type)[];
}

/** Boots an application context with the jobs module and the given providers. */
export async function bootApp(spec: AppSpec): Promise<INestApplicationContext> {
  const imports: DynamicModule[] = [
    JobsModule.forRoot(spec.options),
    JobsModule.forFeature(spec.queues ?? []),
  ];

  @Module({ imports, providers: [...(spec.providers ?? [])] })
  class TestAppModule {}

  return NestFactory.createApplicationContext(TestAppModule, { logger: false });
}

/** Resolves once `predicate` is true, polling every 20 ms, or rejects after `timeoutMs`. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const started = performance.now();

  while (!(await predicate())) {
    if (performance.now() - started > timeoutMs) throw new Error('waitFor timed out');

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
