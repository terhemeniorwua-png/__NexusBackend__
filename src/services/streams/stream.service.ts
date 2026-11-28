/**
 * Redis Streams service.
 *
 * Provides a typed, namespace-aware wrapper around Redis Streams primitives:
 * XADD, XGROUP CREATE, XREADGROUP, XACK, XAUTOCLAIM, and XPENDING.
 *
 * Key naming convention: `<namespace>:stream:<name>` (mirrors the cache and
 * rate-limit namespace style already used throughout the codebase).
 *
 * Blocking reads (readGroup with blockMs) use a dedicated duplicate connection
 * so they cannot stall the shared Redis client used by rate-limiting and
 * caching.
 *
 * Redis unavailability is handled gracefully: every public function logs a
 * warning and returns null / an empty result instead of throwing.  The caller's
 * main business path is never interrupted by a Redis failure.
 */

import type { RedisClientType } from 'redis';
import { getRedisClient } from '../../db/redis';
import { logger as defaultLogger, type Logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StreamMessage {
  id: string;
  fields: Record<string, string>;
  /** Milliseconds the entry has been in the PEL (from XAUTOCLAIM). */
  millisElapsedFromDelivery?: number;
  /** Number of times this entry has been delivered (from XAUTOCLAIM). */
  deliveriesCounter?: number;
}

export interface PendingSummary {
  pending: number;
  firstId: string | null;
  lastId: string | null;
  consumers: Array<{ name: string; deliveriesCounter: number }> | null;
}

export interface ReclaimResult {
  nextId: string;
  messages: StreamMessage[];
  deletedMessages: string[];
}

export interface StreamServiceOptions {
  /**
   * Namespace prefix used to build the full Redis key.
   * Defaults to `'nexus'` (matches the automation queue default).
   */
  namespace?: string;
  /**
   * Optional Redis client.  When omitted the shared singleton from
   * `getRedisClient()` is used.
   */
  redis?: RedisClientType;
  /**
   * Optional Redis URL forwarded to `getRedisClient` when no explicit client
   * is provided.  Never read from process.env directly.
   */
  redisUrl?: string;
  logger?: Logger;
}

export interface StreamService {
  /**
   * Full namespaced stream key: `<namespace>:stream:<name>`.
   * Useful for reference, logging, and constructing dead-letter keys.
   */
  streamKey(name: string): string;

  /**
   * Append a message to the stream using XADD with approximate MAXLEN
   * trimming (default 10 000 entries).
   *
   * @returns The new entry ID, or null when Redis is unavailable.
   */
  addToStream(
    stream: string,
    fields: Record<string, string>,
    options?: { maxLen?: number },
  ): Promise<string | null>;

  /**
   * Create a consumer group if it does not already exist (BUSYGROUP ignored).
   * Uses MKSTREAM so the stream is created when it has never received any
   * messages yet.
   *
   * @returns true when the group was created, false when it already existed or
   *   Redis is unavailable.
   */
  ensureGroup(stream: string, group: string): Promise<boolean>;

  /**
   * Read new entries from a consumer group (XREADGROUP).
   *
   * When `blockMs` is provided the call uses a **dedicated** duplicate
   * connection so the shared client is never blocked.  Pass `blockMs: 0` for
   * an indefinite block.
   *
   * @returns Array of messages, or an empty array when Redis is unavailable.
   */
  readGroup(
    stream: string,
    group: string,
    consumer: string,
    options?: { count?: number; blockMs?: number },
  ): Promise<StreamMessage[]>;

  /**
   * Acknowledge one or more entries (XACK).
   *
   * @returns Number of entries acknowledged, or 0 when Redis is unavailable.
   */
  ack(stream: string, group: string, ids: string | string[]): Promise<number>;

  /**
   * Reclaim PEL entries that have been idle for at least `minIdleMs`
   * milliseconds (XAUTOCLAIM).
   *
   * @returns ReclaimResult with the next cursor ID, the reclaimed messages, and
   *   any deleted message IDs.  Returns an empty result when Redis is
   *   unavailable.
   */
  reclaimStale(
    stream: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    count?: number,
  ): Promise<ReclaimResult>;

  /**
   * Return summary information about the pending entries of a consumer group
   * (XPENDING).
   *
   * @returns PendingSummary, or null when Redis is unavailable.
   */
  pendingSummary(stream: string, group: string): Promise<PendingSummary | null>;

  /**
   * Close the dedicated blocking-read connection (if one was opened) during
   * graceful shutdown.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LEN = 10_000;

export function createStreamService(options: StreamServiceOptions = {}): StreamService {
  const log = options.logger ?? defaultLogger;
  const namespace = options.namespace ?? 'nexus';

  /** Singleton dedicated connection for blocking XREADGROUP calls. */
  let blockingClient: RedisClientType | null = null;
  let blockingClientConnecting = false;

  function sharedClient(): RedisClientType | null {
    try {
      return (options.redis ?? getRedisClient(options.redisUrl)) as RedisClientType;
    } catch (err) {
      log.warn('stream_service_redis_unavailable', { error: err });
      return null;
    }
  }

  /**
   * Return (or lazily create) the dedicated duplicate connection used for
   * blocking XREADGROUP calls.  A blocking read must never use the shared
   * client because it ties up the connection for the entire block duration,
   * which would stall all other commands (rate-limiting, caching, etc.).
   */
  async function getBlockingClient(): Promise<RedisClientType | null> {
    if (blockingClient?.isOpen) return blockingClient;

    if (blockingClientConnecting) {
      // Another call is already connecting; fall back to non-blocking path.
      return null;
    }

    const shared = sharedClient();
    if (!shared) return null;

    try {
      blockingClientConnecting = true;
      const dup = shared.duplicate() as RedisClientType;
      dup.on('error', (err: unknown) => {
        log.warn('stream_blocking_client_error', { error: err });
      });
      await dup.connect();
      blockingClient = dup;
      return blockingClient;
    } catch (err) {
      log.warn('stream_blocking_client_connect_failed', { error: err });
      blockingClient = null;
      return null;
    } finally {
      blockingClientConnecting = false;
    }
  }

  function key(name: string): string {
    return `${namespace}:stream:${name}`;
  }

  /**
   * Convert a raw XREADGROUP reply entry into our public StreamMessage type.
   * The redis@6 client returns messages as objects with an `id` string and a
   * `message` Map (or plain object depending on RESP version/TypeMapping).
   */
  function toStreamMessage(raw: {
    id: string;
    message: Map<string, string> | Record<string, string> | unknown;
    millisElapsedFromDelivery?: number;
    deliveriesCounter?: number;
  }): StreamMessage {
    const fields: Record<string, string> = {};
    const msg = raw.message;
    if (msg instanceof Map) {
      msg.forEach((v, k) => {
        fields[String(k)] = String(v);
      });
    } else if (msg && typeof msg === 'object') {
      for (const [k, v] of Object.entries(msg as Record<string, unknown>)) {
        fields[String(k)] = String(v);
      }
    }
    return {
      id: raw.id,
      fields,
      millisElapsedFromDelivery: raw.millisElapsedFromDelivery,
      deliveriesCounter: raw.deliveriesCounter,
    };
  }

  return {
    streamKey(name: string): string {
      return key(name);
    },

    async addToStream(
      stream: string,
      fields: Record<string, string>,
      options?: { maxLen?: number },
    ): Promise<string | null> {
      const redis = sharedClient();
      if (!redis) return null;

      const maxLen = options?.maxLen ?? DEFAULT_MAX_LEN;
      const streamKey = key(stream);
      try {
        const id = await redis.xAdd(streamKey, '*', fields, {
          TRIM: {
            strategy: 'MAXLEN',
            strategyModifier: '~',
            threshold: maxLen,
          },
        });
        return id;
      } catch (err) {
        log.warn('stream_service_xadd_failed', { stream: streamKey, error: err });
        return null;
      }
    },

    async ensureGroup(stream: string, group: string): Promise<boolean> {
      const redis = sharedClient();
      if (!redis) return false;

      const streamKey = key(stream);
      try {
        await redis.xGroupCreate(streamKey, group, '$', { MKSTREAM: true });
        return true;
      } catch (err: unknown) {
        // BUSYGROUP means the group already exists — that is fine.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('BUSYGROUP')) {
          return false;
        }
        log.warn('stream_service_xgroup_create_failed', { stream: streamKey, group, error: err });
        return false;
      }
    },

    async readGroup(
      stream: string,
      group: string,
      consumer: string,
      options?: { count?: number; blockMs?: number },
    ): Promise<StreamMessage[]> {
      const streamKey = key(stream);
      const count = options?.count ?? 1;
      const blockMs = options?.blockMs;

      // Choose which client to use.
      let redis: RedisClientType | null = null;
      if (blockMs !== undefined) {
        redis = await getBlockingClient();
      } else {
        redis = sharedClient();
      }
      if (!redis) return [];

      try {
        const reply = await redis.xReadGroup(group, consumer, { key: streamKey, id: '>' }, {
          COUNT: count,
          ...(blockMs !== undefined ? { BLOCK: blockMs } : {}),
        });

        if (!reply) return [];

        const messages: StreamMessage[] = [];
        for (const streamEntry of reply) {
          if (!streamEntry?.messages) continue;
          for (const msg of streamEntry.messages) {
            if (msg) messages.push(toStreamMessage(msg as Parameters<typeof toStreamMessage>[0]));
          }
        }
        return messages;
      } catch (err) {
        log.warn('stream_service_xreadgroup_failed', { stream: streamKey, group, consumer, error: err });
        return [];
      }
    },

    async ack(stream: string, group: string, ids: string | string[]): Promise<number> {
      const redis = sharedClient();
      if (!redis) return 0;

      const streamKey = key(stream);
      const idArray = Array.isArray(ids) ? ids : [ids];
      if (idArray.length === 0) return 0;

      try {
        const count = await redis.xAck(streamKey, group, idArray);
        return typeof count === 'number' ? count : Number(count);
      } catch (err) {
        log.warn('stream_service_xack_failed', { stream: streamKey, group, ids: idArray, error: err });
        return 0;
      }
    },

    async reclaimStale(
      stream: string,
      group: string,
      consumer: string,
      minIdleMs: number,
      count = 10,
    ): Promise<ReclaimResult> {
      const redis = sharedClient();
      const empty: ReclaimResult = { nextId: '0-0', messages: [], deletedMessages: [] };
      if (!redis) return empty;

      const streamKey = key(stream);
      try {
        const reply = await redis.xAutoClaim(streamKey, group, consumer, minIdleMs, '0-0', {
          COUNT: count,
        });

        if (!reply) return empty;

        const nextId = String(reply.nextId ?? '0-0');
        const messages = (reply.messages ?? [])
          .filter((m) => m != null)
          .map((m) => toStreamMessage(m as Parameters<typeof toStreamMessage>[0]));
        const deletedMessages = (reply.deletedMessages ?? []).map(String);

        return { nextId, messages, deletedMessages };
      } catch (err) {
        log.warn('stream_service_xautoclaim_failed', {
          stream: streamKey,
          group,
          consumer,
          minIdleMs,
          error: err,
        });
        return empty;
      }
    },

    async pendingSummary(stream: string, group: string): Promise<PendingSummary | null> {
      const redis = sharedClient();
      if (!redis) return null;

      const streamKey = key(stream);
      try {
        const reply = await redis.xPending(streamKey, group);
        if (!reply) return null;

        return {
          pending: typeof reply.pending === 'number' ? reply.pending : Number(reply.pending),
          firstId: reply.firstId ? String(reply.firstId) : null,
          lastId: reply.lastId ? String(reply.lastId) : null,
          consumers: reply.consumers
            ? reply.consumers.map((c) => ({
                name: String(c.name),
                deliveriesCounter: Number(c.deliveriesCounter),
              }))
            : null,
        };
      } catch (err) {
        log.warn('stream_service_xpending_failed', { stream: streamKey, group, error: err });
        return null;
      }
    },

    async close(): Promise<void> {
      const bc = blockingClient;
      blockingClient = null;
      if (!bc) return;
      try {
        if (bc.isOpen) {
          await bc.quit();
        }
      } catch {
        try {
          bc.destroy();
        } catch {
          // ignore
        }
      }
    },
  };
}
