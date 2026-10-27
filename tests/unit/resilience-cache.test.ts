import type Redis from 'ioredis';

import { CacheService } from '../../src/common/cache/cache.service.js';
import { backoffDelay, retry } from '../../src/common/resilience/retry.js';
import { withTx } from '../../src/common/db/transaction.js';

describe('resilience and cache foundation', () => {
  it('keeps full-jitter delays within the exponential cap', () => {
    expect(backoffDelay(0, 100, 2000, () => 0)).toBe(0);
    expect(backoffDelay(4, 100, 2000, () => 1)).toBe(1600);
    expect(backoffDelay(10, 100, 2000, () => 0.5)).toBe(1000);
  });

  it('retries transient transaction errors but not business errors', async () => {
    let attempts = 0;
    const transactionDatabase = {
      transaction: () => ({
        setIsolationLevel: () => ({
          execute: async (callback: (transaction: object) => Promise<unknown>) => {
            attempts += 1;
            if (attempts === 1) {
              const error = Object.assign(new Error('serialization failure'), { code: '40001' });
              throw error;
            }
            return callback({});
          },
        }),
      }),
    };

    await expect(
      withTx({ retries: 1 }, async () => 'ok', transactionDatabase as never),
    ).resolves.toBe('ok');
    expect(attempts).toBe(2);

    const businessError = new Error('conflict');
    const businessDatabase = {
      transaction: () => ({
        setIsolationLevel: () => ({
          execute: async (callback: (transaction: object) => Promise<unknown>) =>
            callback({}),
        }),
      }),
    };
    await expect(
      withTx({ retries: 3 }, async () => {
        throw businessError;
      }, businessDatabase as never),
    ).rejects.toBe(businessError);
  });

  it('loads one value for parallel cache misses', async () => {
    const values = new Map<string, string>();
    const fakeRedis = {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => {
        if (key.startsWith('lock:') && values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      },
      del: async (key: string) => {
        values.delete(key);
        return 1;
      },
    } as unknown as Redis;
    const service = new CacheService(fakeRedis);
    let loads = 0;
    const loader = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { value: 'loaded' };
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => service.getOrLoad('key', 60, loader)),
    );
    expect(loads).toBe(1);
    expect(results).toHaveLength(10);
    expect(results[0]).toEqual({ value: 'loaded' });
  });

  it('supports retry abort signals', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      retry(async () => 'never', {
        retries: 1,
        baseMs: 1,
        capMs: 1,
        retryOn: () => true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
