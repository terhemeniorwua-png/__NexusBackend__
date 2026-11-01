import type { Store } from 'express-rate-limit';
import { getRedisClient } from '../../db/redis';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';

/**
 * Redis-backed rate-limit counters.
 *
 * The counters are shared by every backend instance that points at the same
 * Redis deployment. The store deliberately has no in-process fallback: when
 * Redis cannot confirm a counter the request is denied, because silently
 * accepting traffic would remove the protection the limiter exists to provide.
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

export interface RateLimitRedisClient {
  readonly isOpen: boolean;
  readonly isReady?: boolean;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  decr(key: string): Promise<number>;
  del(key: string): Promise<number>;
}

export interface RateLimitStoreOptions {
  namespace: string;
  windowMs: number;
  /** Injectable for tests. Production uses the shared Redis client. */
  client?: RateLimitRedisClient;
}

export class RateLimitStoreUnavailableError extends AppError {
  constructor() {
    super(
      503,
      'RATE_LIMIT_UNAVAILABLE',
      'Rate limiting is temporarily unavailable. Please try again later.',
      { expose: true },
    );
    this.name = 'RateLimitStoreUnavailableError';
  }
}

function asRateLimitClient(client: unknown): RateLimitRedisClient {
  return client as RateLimitRedisClient;
}

export function createRateLimitStore({
  namespace,
  windowMs,
  client: injectedClient,
}: RateLimitStoreOptions): Store {
  function getReadyClient(): RateLimitRedisClient {
    const client = injectedClient ?? asRateLimitClient(getRedisClient());

    if (!client.isOpen || client.isReady === false) {
      throw new RateLimitStoreUnavailableError();
    }

    return client;
  }

  function redisKey(key: string): string {
    return `rl:${namespace}:${key}`;
  }

  function reportUnavailable(error: unknown, operation: string): never {
    logger.warn('rate_limit_store_redis_unavailable', {
      namespace,
      operation,
      error,
    });

    throw new RateLimitStoreUnavailableError();
  }

  return {
    // Redis holds the authoritative counter, so keys are shared between
    // instances rather than local to one process.
    localKeys: false,

    increment: async (key: string) => {
      try {
        const client = getReadyClient();
        const reply = await client.eval(INCREMENT_SCRIPT, {
          keys: [redisKey(key)],
          arguments: [String(windowMs)],
        });

        if (!Array.isArray(reply) || reply.length < 2) {
          throw new Error('Unexpected response from the rate-limit store');
        }

        const totalHits = Number(reply[0]);
        const ttlMs = Number(reply[1]);

        if (!Number.isFinite(totalHits) || totalHits < 1) {
          throw new Error('Unexpected hit count from the rate-limit store');
        }

        return {
          totalHits,
          resetTime: new Date(Date.now() + (ttlMs > 0 ? ttlMs : windowMs)),
        };
      } catch (error) {
        if (error instanceof RateLimitStoreUnavailableError) {
          throw error;
        }

        return reportUnavailable(error, 'increment');
      }
    },

    decrement: async (key: string) => {
      try {
        const client = getReadyClient();
        await client.decr(redisKey(key));
      } catch (error) {
        // Decrementing is a best-effort correction for skip options. It must
        // never turn a completed request into an unhandled rejection.
        if (!(error instanceof RateLimitStoreUnavailableError)) {
          logger.warn('rate_limit_store_redis_unavailable', {
            namespace,
            operation: 'decrement',
            error,
          });
        }
      }
    },

    resetKey: async (key: string) => {
      try {
        const client = getReadyClient();
        await client.del(redisKey(key));
      } catch (error) {
        if (!(error instanceof RateLimitStoreUnavailableError)) {
          logger.warn('rate_limit_store_redis_unavailable', {
            namespace,
            operation: 'resetKey',
            error,
          });
        }
      }
    },

    shutdown: () => {
      // The store borrows the application's shared Redis client. The server
      // owns the connection lifecycle and closes it during shutdown.
    },
  };
}
