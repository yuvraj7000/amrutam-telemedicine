import type Redis from 'ioredis';

import { redis as defaultRedis } from './redis.js';

type Loader<T> = () => Promise<T>;

export class CacheService {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  public constructor(private readonly client: Redis = defaultRedis) {}

  public async getOrLoad<T>(key: string, ttlSeconds: number, loader: Loader<T>): Promise<T> {
    const cached = await this.read<T>(key);
    if (cached.found) return cached.value as T;

    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = this.loadWithLock(key, ttlSeconds, loader).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async loadWithLock<T>(key: string, ttlSeconds: number, loader: Loader<T>): Promise<T> {
    const lockKey = `lock:${key}`;
    const token = `${process.pid}:${Math.random()}`;
    let locked = false;
    try {
      locked = (await this.client.set(lockKey, token, 'PX', 5000, 'NX')) === 'OK';
    } catch {
      return loader();
    }

    if (!locked) {
      const deadline = Date.now() + 200;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const cached = await this.read<T>(key);
        if (cached.found) return cached.value as T;
      }
      return loader();
    }

    try {
      const cached = await this.read<T>(key);
      if (cached.found) return cached.value as T;
      const value = await loader();
      const jitter = 0.9 + Math.random() * 0.2;
      try {
        await this.client.set(key, JSON.stringify(value), 'EX', Math.max(1, Math.round(ttlSeconds * jitter)));
      } catch {
        // Redis is an optimization; the loaded value remains usable.
      }
      return value;
    } finally {
      try {
        const current = await this.client.get(lockKey);
        if (current === token) await this.client.del(lockKey);
      } catch {
        // Redis failure is intentionally fail-open.
      }
    }
  }

  private async read<T>(key: string): Promise<{ found: boolean; value?: T }> {
    try {
      const value = await this.client.get(key);
      return value === null ? { found: false } : { found: true, value: JSON.parse(value) as T };
    } catch {
      return { found: false };
    }
  }
}
