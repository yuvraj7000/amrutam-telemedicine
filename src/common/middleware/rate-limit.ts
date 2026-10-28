import rateLimit, {
  type Options as ExpressRateLimitOptions,
  type Store,
  type ValueDeterminingMiddleware,
} from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { RedisStore, type RedisReply } from 'rate-limit-redis';

import { redis } from '../cache/redis.js';
import { ERROR_CODES } from '../errors/index.js';
import { logger } from '../observability/logger.js';
import { rateLimited } from '../observability/metrics.js';

export type RateLimitOptions = {
  windowMs: number;
  limit: number;
  prefix: string;
  keyGenerator?: ValueDeterminingMiddleware<string>;
  useRedis?: boolean;
};

function redisReply(value: unknown): RedisReply {
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === 'boolean' || typeof item === 'number' || typeof item === 'string',
    )
  ) {
    return value;
  }
  throw new Error('Redis returned an unsupported rate-limit response');
}

function resilientStore(prefix: string, useRedis: boolean): Store {
  const remote = useRedis
    ? new RedisStore({
        prefix: `${prefix}:`,
        sendCommand: (command, ...args) => redis.call(command, ...args).then(redisReply),
      })
    : undefined;
  const local = new Map<string, { totalHits: number; resetTime: Date }>();
  let windowMs = 60_000;
  let localFallbackActive = false;
  let localFallbackUntil = 0;
  const pruneLocal = (): void => {
    const now = Date.now();
    for (const [key, entry] of local) {
      if (entry.resetTime.getTime() <= now) local.delete(key);
    }
  };
  const localIncrement = (key: string) => {
    pruneLocal();
    const now = Date.now();
    const current = local.get(key);
    if (current && current.resetTime.getTime() > now) {
      current.totalHits += 1;
      return { totalHits: current.totalHits, resetTime: current.resetTime };
    }
    if (local.size >= 10_000) {
      const oldest = local.keys().next().value;
      if (oldest !== undefined) local.delete(oldest);
    }
    const entry = { totalHits: 1, resetTime: new Date(now + windowMs) };
    local.set(key, entry);
    return entry;
  };
  const localGet = (key: string) => {
    pruneLocal();
    const entry = local.get(key);
    return entry ? { totalHits: entry.totalHits, resetTime: entry.resetTime } : undefined;
  };
  const localDecrement = (key: string): void => {
    const entry = local.get(key);
    if (entry) entry.totalHits = Math.max(0, entry.totalHits - 1);
  };
  const localReset = (key: string): void => {
    local.delete(key);
  };
  const fallback = <T>(method: string, error: unknown, runLocal: () => T): T => {
    const alreadyActive = localFallbackActive;
    localFallbackActive = true;
    localFallbackUntil = Date.now() + windowMs;
    if (!alreadyActive) {
      logger.warn(
        { err: error, method, prefix },
        'Redis rate-limit store unavailable; using local counters',
      );
    }
    return runLocal();
  };
  const recovered = (): void => {
    localFallbackActive = false;
    localFallbackUntil = 0;
  };
  const useLocalFallback = (): boolean => Date.now() < localFallbackUntil;

  return {
    localKeys: true,
    init(options: ExpressRateLimitOptions) {
      windowMs = options.windowMs;
      remote?.init(options);
    },
    async increment(key) {
      if (!useRedis) return localIncrement(key);
      if (useLocalFallback()) return localIncrement(key);
      try {
        const result = await remote?.increment(key);
        recovered();
        if (!result) throw new Error('Redis rate-limit store returned no increment result');
        return result;
      } catch (error) {
        return fallback('increment', error, () => localIncrement(key));
      }
    },
    async get(key) {
      if (!useRedis) return localGet(key);
      if (useLocalFallback()) return localGet(key);
      try {
        const result = await remote?.get(key);
        recovered();
        return result;
      } catch (error) {
        return fallback('get', error, () => localGet(key));
      }
    },
    async decrement(key) {
      if (!useRedis) return localDecrement(key);
      if (useLocalFallback()) return localDecrement(key);
      try {
        await remote?.decrement(key);
        recovered();
      } catch (error) {
        await fallback('decrement', error, () => localDecrement(key));
      }
    },
    async resetKey(key) {
      if (!useRedis) return localReset(key);
      if (useLocalFallback()) return localReset(key);
      try {
        await remote?.resetKey(key);
        recovered();
      } catch (error) {
        await fallback('resetKey', error, () => localReset(key));
      }
    },
  };
}

export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const useRedis = options.useRedis ?? process.env.NODE_ENV !== 'test';
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    keyGenerator: options.keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    passOnStoreError: false,
    store: resilientStore(options.prefix, useRedis),
    handler: (req, res) => {
      const retryAfter = Math.max(1, Math.ceil(options.windowMs / 1000));
      rateLimited.inc({ route: req.route?.path ?? req.path });
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).type('application/problem+json').json({
        type: 'https://api.amrutam.example/errors/rate-limited',
        title: 'Too Many Requests',
        status: 429,
        code: ERROR_CODES.RATE_LIMITED,
        detail: 'Too many requests. Try again later.',
        requestId: res.locals.requestId,
      });
    },
  });
}

export function ipRateLimiter(windowMs: number, limit: number, prefix = 'rl:ip'): RequestHandler {
  return createRateLimiter({ windowMs, limit, prefix });
}

export function accountRateLimiter(
  windowMs: number,
  limit: number,
  prefix: string,
  keyGenerator: ValueDeterminingMiddleware<string>,
): RequestHandler {
  return createRateLimiter({ windowMs, limit, prefix, keyGenerator });
}
