import { getRedisClient } from '../../db/redis';
import { logger as defaultLogger, type Logger } from '../../utils/logger';

/**
 * Redis-backed read-through cache.
 *
 * PostgreSQL remains the source of truth. Redis only stores derived values
 * (aggregations, rendered indexes, expensive lookups) that can always be
 * recomputed, so a cache outage must never fail a request. Every operation
 * therefore degrades to a cache miss instead of throwing.
 *
 * Key convention: `{namespace}:{key}` (`CACHE_NAMESPACE`). Invalidation uses
 * SCAN instead of KEYS so a large Redis deployment is never blocked by a
 * single prefix invalidation.
 */

export interface CacheRedisClient {
  readonly isOpen: boolean;
  readonly isReady?: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
  scan(
    cursor: string,
    options: { MATCH: string; COUNT: number },
  ): Promise<{ cursor: string; keys: string[] }>;
}

export interface CacheServiceOptions {
  /** Prefix shared by every key this deployment writes. */
  namespace: string;
  /** TTL used when a caller does not provide one. */
  defaultTtlSeconds: number;
  /** Injectable for tests. Production uses the shared Redis client. */
  client?: CacheRedisClient;
  logger?: Logger;
}

export interface SetOptions {
  ttlSeconds?: number;
}

export interface CacheService {
  readonly namespace: string;
  isAvailable(): boolean;
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options?: SetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  /** Removes every key under `prefix`, e.g. `workspace:{id}:`. */
  deletePrefix(prefix: string): Promise<number>;
  /** Read-through helper. Concurrent callers in one process share one load. */
  getOrSet<T>(key: string, loader: () => Promise<T>, options?: SetOptions): Promise<T>;
}

const SCAN_BATCH_SIZE = 250;
const SCAN_MAX_ITERATIONS = 1_000;

interface ScanPage {
  cursor: string;
  keys: string[];
}

export function createCacheService({
  namespace,
  defaultTtlSeconds,
  client: injectedClient,
  logger: defaultLoggerInstance,
}: CacheServiceOptions): CacheService {
  const log = defaultLoggerInstance ?? defaultLogger;
  const inFlight = new Map<string, Promise<unknown>>();

  function redisKey(key: string): string {
    return `${namespace}:${key}`;
  }

  function getClient(): CacheRedisClient | null {
    let client: CacheRedisClient | undefined = injectedClient;

    if (!client) {
      try {
        // The shared client is absent until the server connects to Redis and
        // in tests that never configure Redis. Both are normal cache misses.
        client = getRedisClient() as unknown as CacheRedisClient;
      } catch {
        return null;
      }
    }

    if (!client.isOpen || client.isReady === false) {
      return null;
    }

    return client;
  }

  function warn(operation: string, key: string, error: unknown): void {
    log.warn('cache_unavailable', { operation, key, error });
  }

  async function get<T>(key: string): Promise<T | null> {
    const client = getClient();

    if (!client) {
      return null;
    }

    const fullKey = redisKey(key);

    try {
      const raw = await client.get(fullKey);

      if (raw === null) {
        return null;
      }

      return JSON.parse(raw) as T;
    } catch (error) {
      warn('get', fullKey, error);
      return null;
    }
  }

  async function set<T>(key: string, value: T, options: SetOptions = {}): Promise<void> {
    const client = getClient();

    if (!client) {
      return;
    }

    const ttl = options.ttlSeconds ?? defaultTtlSeconds;

    if (!Number.isFinite(ttl) || ttl <= 0) {
      return;
    }

    const fullKey = redisKey(key);

    try {
      await client.set(fullKey, JSON.stringify(value), { EX: Math.ceil(ttl) });
    } catch (error) {
      warn('set', fullKey, error);
    }
  }

  async function remove(key: string): Promise<void> {
    const client = getClient();

    if (!client) {
      return;
    }

    const fullKey = redisKey(key);

    try {
      await client.del(fullKey);
    } catch (error) {
      warn('delete', fullKey, error);
    }
  }

  function collectKeys(page: unknown): ScanPage {
    if (Array.isArray(page)) {
      // Defensive support for a raw `[cursor, keys]` reply shape.
      return { cursor: String(page[0] ?? '0'), keys: (page[1] as string[]) ?? [] };
    }

    const result = page as { cursor?: string | number; keys?: string[] };

    return {
      cursor: String(result?.cursor ?? '0'),
      keys: Array.isArray(result?.keys) ? result.keys : [],
    };
  }

  async function deletePrefix(prefix: string): Promise<number> {
    const client = getClient();

    if (!client) {
      return 0;
    }

    const match = `${redisKey(prefix)}*`;
    let cursor = '0';
    let deleted = 0;
    let iterations = 0;

    try {
      do {
        const page = collectKeys(
          await client.scan(cursor, { MATCH: match, COUNT: SCAN_BATCH_SIZE }),
        );

        cursor = page.cursor;

        if (page.keys.length > 0) {
          deleted += await client.del(page.keys);
        }

        iterations += 1;
      } while (cursor !== '0' && iterations < SCAN_MAX_ITERATIONS);
    } catch (error) {
      warn('deletePrefix', match, error);
    }

    return deleted;
  }

  async function getOrSet<T>(
    key: string,
    loader: () => Promise<T>,
    options: SetOptions = {},
  ): Promise<T> {
    const cached = await get<T>(key);

    if (cached !== null) {
      return cached;
    }

    const existing = inFlight.get(key) as Promise<T> | undefined;

    if (existing) {
      return existing;
    }

    const load = (async () => {
      try {
        const value = await loader();
        await set(key, value, options);
        return value;
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, load);
    return load;
  }

  return {
    namespace,
    isAvailable: () => getClient() !== null,
    get,
    set,
    delete: remove,
    deletePrefix,
    getOrSet,
  };
}

/**
 * Invalidation helpers for the naming convention used by cached modules.
 *
 * A module that stores `workspace:{workspaceId}:...` can invalidate its own
 * slice when a workspace-scoped record changes without knowing every key.
 */
export function workspaceCachePrefix(workspaceId: string): string {
  return `workspace:${workspaceId}:`;
}

export function userCachePrefix(userId: string): string {
  return `user:${userId}:`;
}
