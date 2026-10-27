import Redis from 'ioredis';

import { env } from '../../config/env.js';

export function createRedisClient(url = env.REDIS_URL): Redis {
  return new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
}

export const redis = createRedisClient();

export async function checkRedis(): Promise<void> {
  await redis.ping();
}

export async function closeRedis(): Promise<void> {
  if (redis.status !== 'end') await redis.quit();
}
