import type { Store } from 'express-rate-limit';
import { getRedisClient } from '../../db/redis';
import { logger } from '../../utils/logger';

/**
 * Rate-limit counters.
 *
 * Redis is the primary store so limits are shared across backend instances.
 * When Redis is unavailable the counter falls back to an in-process map so a
 * cache outage degrades limit precision instead of taking authentication
 * offline.
 *
 * Key convention: `rl:{namespace}:{client-key}` with a millisecond TTL.
 */

const INCREMENT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
`;

interface MemoryEntry {
  hits: number;
  resetAt: number;
}

export interface RateLimitStoreOptions {
  namespace: string;
  windowMs: number;
}

export function createRateLimitStore({ namespace, windowMs }: RateLimitStoreOptions): Store {
  const memory = new Map<string, MemoryEntry>();

  function pruneMemory(now: number): void {
    if (memory.size < 1_000) {
      return;
    }

    for (const [key, entry] of memory) {
      if (entry.resetAt <= now) {
        memory.delete(key);
      }
    }
  }

  return {
    // Redis holds the authoritative counter, so keys are shared between
    // instances rather than local to one process.
    localKeys: false,

    increment: async (key: string) => {
      const redisKey = `rl:${namespace}:${key}`;
      const now = Date.now();

      try {
        const client = getRedisClient();

        if (client.isOpen) {
          const reply = (await client.eval(INCREMENT_SCRIPT, {
            keys: [redisKey],
            arguments: [String(windowMs)],
          })) as [number, number];

          const totalHits = Number(reply[0]);
          const ttlMs = Number(reply[1]);

          return {
            totalHits,
            resetTime: new Date(now + (ttlMs > 0 ? ttlMs : windowMs)),
          };
        }
      } catch (error) {
        logger.warn('rate_limit_store_redis_unavailable', { error, namespace });
      }

      pruneMemory(now);

      const existing = memory.get(key);

      if (!existing || existing.resetAt <= now) {
        memory.set(key, { hits: 1, resetAt: now + windowMs });
        return { totalHits: 1, resetTime: new Date(now + windowMs) };
      }

      existing.hits += 1;
      memory.set(key, existing);

      return { totalHits: existing.hits, resetTime: new Date(existing.resetAt) };
    },

    decrement: async (key: string) => {
      const existing = memory.get(key);

      if (existing) {
        existing.hits = Math.max(0, existing.hits - 1);
      }

      try {
        const client = getRedisClient();

        if (client.isOpen) {
          await client.decr(`rl:${namespace}:${key}`);
        }
      } catch {
        // The in-memory counter above is the fallback path.
      }
    },

    resetKey: async (key: string) => {
      memory.delete(key);

      try {
        const client = getRedisClient();

        if (client.isOpen) {
          await client.del(`rl:${namespace}:${key}`);
        }
      } catch {
        // Nothing else to do; the counter will expire on its own.
      }
    },

    resetAll: async () => {
      memory.clear();
    },

    shutdown: () => {
      memory.clear();
    },
  };
}
