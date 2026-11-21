import { describe, expect, it, vi } from 'vitest';

import {
  closeRedisClient,
  producerConnectionOptions,
  workerConnectionOptions,
  type ClosableRedis,
} from '../src/connections';

const base = { host: 'cache.example.com', port: 6380, password: 'p', db: 2 };

describe('connection policies', () => {
  it('makes producers fail fast and keeps the whole URL', () => {
    expect(producerConnectionOptions(base, 1_500)).toEqual({
      ...base,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 1_500,
      keepAlive: 30_000,
    });
  });

  it('gives workers the never-give-up policy BullMQ requires', () => {
    expect(workerConnectionOptions(base)).toEqual({
      ...base,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
      keepAlive: 30_000,
    });
  });
});

function client(
  status: string,
  quit: () => Promise<unknown>,
): ClosableRedis & { disconnect: ReturnType<typeof vi.fn> } {
  return { status, quit, disconnect: vi.fn() } as never;
}

describe('closeRedisClient', () => {
  it('quits a ready client', async () => {
    const c = client('ready', () => Promise.resolve('OK'));

    await expect(closeRedisClient(c, 100)).resolves.toBe('quit');
    expect(c.disconnect).not.toHaveBeenCalled();
  });

  it('drops a client whose QUIT never returns, within the bound', async () => {
    const c = client('ready', () => new Promise(() => undefined));

    await expect(closeRedisClient(c, 20)).resolves.toBe('dropped');
    expect(c.disconnect).toHaveBeenCalledOnce();
  });

  it('drops a reconnecting client and disconnects one that never connected', async () => {
    await expect(closeRedisClient(client('reconnecting', vi.fn()), 20)).resolves.toBe('dropped');
    await expect(closeRedisClient(client('wait', vi.fn()), 20)).resolves.toBe('not-connected');

    await expect(
      closeRedisClient(
        client('ready', () => Promise.reject(new Error('x'))),
        20,
      ),
    ).resolves.toBe('dropped');
  });
});
