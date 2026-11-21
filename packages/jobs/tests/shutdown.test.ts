import { EventEmitter } from 'node:events';

import type { INestApplicationContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { installGracefulShutdown, shutdownGracefully } from '../src/shutdown';

function fakeApp(
  steps: string[],
  behaviour: { close?: () => Promise<void> } = {},
): INestApplicationContext {
  const runtime = {
    drain: async () => {
      steps.push('drain');

      return { drained: ['mail'], abandoned: [] };
    },
  };

  return {
    get: () => runtime,
    close:
      behaviour.close ??
      (async () => {
        steps.push('close');
      }),
  } as unknown as INestApplicationContext;
}

const quiet = { log: vi.fn(), error: vi.fn() };

describe('shutdownGracefully', () => {
  it('drains, then closes the app, then flushes', async () => {
    const steps: string[] = [];

    const report = await shutdownGracefully(fakeApp(steps), {
      logger: quiet,
      flush: async () => {
        steps.push('flush');
      },
    });

    expect(steps).toEqual(['drain', 'close', 'flush']);

    expect(report).toEqual({
      drain: { drained: ['mail'], abandoned: [] },
      closed: true,
      timedOut: false,
    });
  });

  it('reports a close that hangs past the deadline, and still flushes', async () => {
    const steps: string[] = [];
    const app = fakeApp(steps, { close: () => new Promise(() => undefined) });

    const report = await shutdownGracefully(app, {
      logger: quiet,
      deadlineMs: 30,
      flush: async () => {
        steps.push('flush');
      },
    });

    expect(report.timedOut).toBe(true);
    expect(report.closed).toBe(false);
    expect(steps).toEqual(['drain', 'flush']);
  });
});

describe('installGracefulShutdown', () => {
  it('re-raises the signal after a clean shutdown and ignores a second one', async () => {
    const steps: string[] = [];
    const target = new EventEmitter();
    const raise = vi.fn();
    const exit = vi.fn();

    installGracefulShutdown(fakeApp(steps), {
      target: target as never,
      raise,
      exit,
      logger: quiet,
    });

    target.emit('SIGTERM', 'SIGTERM');
    target.emit('SIGTERM', 'SIGTERM');

    await vi.waitFor(() => expect(raise).toHaveBeenCalledWith('SIGTERM'));
    expect(steps).toEqual(['drain', 'close']);
    expect(exit).not.toHaveBeenCalled();
    expect(target.listenerCount('SIGTERM')).toBe(0);
  });

  it('exits non-zero when the app fails to close', async () => {
    const target = new EventEmitter();
    const exit = vi.fn();

    const app = fakeApp([], {
      close: () => Promise.reject(new Error('db hook threw')),
    });

    installGracefulShutdown(app, { target: target as never, raise: vi.fn(), exit, logger: quiet });
    target.emit('SIGINT', 'SIGINT');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('returns an uninstall function', () => {
    const target = new EventEmitter();

    const uninstall = installGracefulShutdown(fakeApp([]), {
      target: target as never,
      logger: quiet,
    });

    expect(target.listenerCount('SIGTERM')).toBe(1);
    uninstall();
    expect(target.listenerCount('SIGTERM')).toBe(0);
  });
});
