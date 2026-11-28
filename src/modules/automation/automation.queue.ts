/**
 * Automation run queue — Redis Streams implementation.
 *
 * # Migration from Redis List
 *
 * The previous implementation used `LPUSH` / `BRPOP` on the list key
 * `nexus:automation:runs` (default namespace).  That list is now the
 * **legacy list key**.  On first startup the queue drains any residual items
 * from the list into the stream so that in-flight work from a rolling deploy
 * is not lost.  The drain is idempotent: when the list is already empty the
 * operation is a no-op.
 *
 * # Keys (default namespace "nexus")
 *   - Stream:         nexus:stream:automation:runs
 *   - Consumer group:  automation-workers
 *   - Dead-letter:    nexus:stream:automation:runs:dead
 *   - Legacy list:    nexus:automation:runs           (drained on startup)
 *
 * # Retry and dead-letter behaviour
 *   - On processing failure the entry is left in the PEL (un-ACKed).
 *   - `reclaimStale` reclaims entries idle for a while so they are retried
 *     by any live consumer.
 *   - After `maxDeliveries` (default 5) deliveries the entry is moved to the
 *     dead-letter stream and ACK-ed so it no longer blocks the PEL.
 *
 * # Public API
 *   The `enqueue`, `enqueueMany`, `dequeue` and `key` members keep their
 *   original signatures so every caller continues to work without edits.
 *   New members are additive.
 */

import type { RedisClientType } from 'redis';
import { getRedisClient } from '../../db/redis';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import {
  createStreamService,
  type StreamService,
} from '../../services/streams/stream.service';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STREAM_NAME = 'automation:runs';
const DEAD_STREAM_NAME = 'automation:runs:dead';
const CONSUMER_GROUP = 'automation-workers';
const MAX_DELIVERY_COUNT = 5;
const MIGRATE_LEGACY_MAX = 1_000;

/** A stream entry carrying an automation run ID. */
export interface AutomationStreamEntry {
  /** Stream entry ID. */
  id: string;
  /** AutomationRun UUID. */
  runId: string;
  /** Total delivery count (1 for the first delivery). */
  deliveries: number;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface AutomationRunQueue {
  // -- Unchanged, list-era members -----------------------------------------
  enqueue(runId: string): Promise<void>;
  enqueueMany(runIds: string[]): Promise<void>;
  dequeue(timeoutSeconds: number): Promise<string | null>;
  key: string;

  // -- Additive, streams-era members ---------------------------------------
  /** Namespaced stream key, e.g. `nexus:stream:automation:runs`. */
  streamKey: string;
  /** Namespaced dead-letter stream key. */
  deadStreamKey: string;
  /** Old Redis list key kept for the one-time migration drain. */
  legacyListKey: string;

  /** Create the consumer group when missing (BUSYGROUP ignored). */
  ensureGroup(): Promise<boolean>;
  /** Read new entries for `consumer` from the consumer group. */
  consume(
    consumer: string,
    options?: { count?: number; blockMs?: number },
  ): Promise<AutomationStreamEntry[]>;
  /** ACK entries after successful processing. */
  ackEntries(ids: string[]): Promise<number>;
  /**
   * Reclaim entries idle for at least `minIdleMs` (XAUTOCLAIM) and return
   * them with their current delivery counts.
   */
  reclaimStale(
    consumer: string,
    minIdleMs: number,
    count?: number,
  ): Promise<AutomationStreamEntry[]>;
  /** Group pending summary (XPENDING). */
  pendingCount(): Promise<number>;
  /** Move an exhausted entry to the dead-letter stream and ACK it. */
  deadLetter(entry: AutomationStreamEntry, reason: string): Promise<void>;
  /** Drain the legacy list key into the stream once (idempotent). */
  migrateLegacyList(): Promise<number>;
  /** Close the dedicated blocking-read connection. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAutomationRunQueue(options: {
  redis?: RedisClientType;
  redisUrl?: string;
  namespace?: string;
  logger?: Logger;
  /** Delivery limit before dead-lettering (default 5). */
  maxDeliveries?: number;
} = {}): AutomationRunQueue {
  const log = options.logger ?? defaultLogger;
  const namespace = options.namespace ?? 'nexus';
  const maxDeliveries = options.maxDeliveries ?? MAX_DELIVERY_COUNT;

  const svc: StreamService = createStreamService({
    redis: options.redis,
    redisUrl: options.redisUrl,
    namespace,
    logger: log,
  });

  const streamKey = svc.streamKey(STREAM_NAME);
  const deadStreamKey = svc.streamKey(DEAD_STREAM_NAME);
  const legacyListKey = `${namespace}:automation:runs`;

  /** Shared Redis client for non-stream commands (legacy drain, XPENDING range). */
  function getClient(): RedisClientType | null {
    try {
      const client = options.redis ?? getRedisClient(options.redisUrl);
      return (client ?? null) as RedisClientType | null;
    } catch {
      return null;
    }
  }

  type PendingRangeRow = {
    id: string;
    consumer: string;
    millisecondsSinceLastDelivery: number;
    deliveriesCounter: number;
  };

  /** XPENDING RANGE — delivery counters for the ids currently in the PEL. */
  async function deliveryCounts(ids: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (ids.length === 0) return counts;
    const client = getClient();
    if (!client) return counts;
    try {
      const range = await (
        client as unknown as {
          xPendingRange(
            key: string,
            group: string,
            start: string,
            end: string,
            count: number,
          ): Promise<PendingRangeRow[]>;
        }
      ).xPendingRange(streamKey, CONSUMER_GROUP, '-', '+', 200);
      for (const row of range) {
        counts.set(String(row.id), Number(row.deliveriesCounter));
      }
    } catch (err) {
      log.warn('automation_queue_pending_range_failed', { error: err });
    }
    return counts;
  }

  function toEntry(
    msg: { id: string; fields: Record<string, string> },
    deliveries: number,
  ): AutomationStreamEntry {
    return { id: msg.id, runId: msg.fields['runId'] ?? '', deliveries };
  }

  return {
    key: legacyListKey, // unchanged: the historical canonical key
    streamKey,
    deadStreamKey,
    legacyListKey,

    async enqueue(runId: string): Promise<void> {
      if (!runId) return;
      const id = await svc.addToStream(STREAM_NAME, { runId });
      if (id === null) {
        log.warn('automation_queue_enqueue_failed', { runId });
      }
    },

    async enqueueMany(runIds: string[]): Promise<void> {
      if (runIds.length === 0) return;
      let failed = 0;
      for (const runId of runIds) {
        if (!runId) continue;
        const id = await svc.addToStream(STREAM_NAME, { runId });
        if (id === null) failed += 1;
      }
      if (failed > 0) {
        log.warn('automation_queue_enqueue_many_partial', {
          total: runIds.length,
          failed,
        });
      }
    },

    /**
     * Legacy list-era consumer shim.
     *
     * The updated worker no longer uses this; it exists so un-migrated callers
     * keep working.  It reads one new entry, returns its run ID and ACKs
     * immediately (PostgreSQL claiming in `processAutomationRunById` makes
     * duplicate processing harmless).
     */
    async dequeue(timeoutSeconds: number): Promise<string | null> {
      await this.ensureGroup();
      const messages = await svc.readGroup(STREAM_NAME, CONSUMER_GROUP, 'compat-consumer', {
        count: 1,
        blockMs: timeoutSeconds * 1000,
      });
      if (messages.length === 0) return null;
      const msg = messages[0];
      if (!msg) return null;
      const runId = msg.fields['runId'] ?? null;
      if (runId) {
        await svc.ack(STREAM_NAME, CONSUMER_GROUP, msg.id);
      }
      return runId;
    },

    async ensureGroup(): Promise<boolean> {
      return svc.ensureGroup(STREAM_NAME, CONSUMER_GROUP);
    },

    async consume(
      consumer: string,
      options?: { count?: number; blockMs?: number },
    ): Promise<AutomationStreamEntry[]> {
      const messages = await svc.readGroup(STREAM_NAME, CONSUMER_GROUP, consumer, {
        count: options?.count ?? 10,
        blockMs: options?.blockMs,
      });
      // First delivery via '>' always counts as delivery 1.
      return messages.map((m) => toEntry(m, 1));
    },

    async ackEntries(ids: string[]): Promise<number> {
      if (ids.length === 0) return 0;
      return svc.ack(STREAM_NAME, CONSUMER_GROUP, ids);
    },

    async reclaimStale(
      consumer: string,
      minIdleMs: number,
      count = 50,
    ): Promise<AutomationStreamEntry[]> {
      const result = await svc.reclaimStale(STREAM_NAME, CONSUMER_GROUP, consumer, minIdleMs, count);
      if (result.messages.length === 0) return [];

      // After XAUTOCLAIM the entries are owned by `consumer`; look up their
      // (now incremented) delivery counters.
      const counts = await deliveryCounts(result.messages.map((m) => m.id));
      return result.messages.map((m) =>
        toEntry(m, counts.get(m.id) ?? 1),
      );
    },

    async pendingCount(): Promise<number> {
      const summary = await svc.pendingSummary(STREAM_NAME, CONSUMER_GROUP);
      return summary?.pending ?? 0;
    },

    async deadLetter(entry: AutomationStreamEntry, reason: string): Promise<void> {
      try {
        await svc.addToStream(
          DEAD_STREAM_NAME,
          {
            runId: entry.runId,
            originalId: entry.id,
            deliveries: String(entry.deliveries),
            reason: reason.slice(0, 500),
            deadLetteredAt: new Date().toISOString(),
          },
          // Keep the dead stream longer: it is the audit trail for failures.
          { maxLen: 100_000 },
        );
        await svc.ack(STREAM_NAME, CONSUMER_GROUP, entry.id);
        log.warn('automation_run_dead_lettered', {
          entryId: entry.id,
          runId: entry.runId,
          deliveries: entry.deliveries,
          maxDeliveries,
          deadStreamKey,
          reason,
        });
      } catch (err) {
        log.warn('automation_queue_dead_letter_failed', {
          entryId: entry.id,
          runId: entry.runId,
          error: err,
        });
      }
    },

    async migrateLegacyList(): Promise<number> {
      const client = getClient();
      if (!client) return 0;

      let drained = 0;
      try {
        for (let i = 0; i < MIGRATE_LEGACY_MAX; i += 1) {
          const item = await (
            client as unknown as {
              rPop(key: string): Promise<string | null>;
            }
          ).rPop(legacyListKey);
          if (item === null) break;
          const runId = item.trim();
          if (!runId) continue;
          const id = await svc.addToStream(STREAM_NAME, { runId });
          if (id === null) {
            // Could not hand the run to the stream; push it back so it is
            // not lost, then stop.
            await (
              client as unknown as {
                lPush(key: string, value: string): Promise<number>;
              }
            ).lPush(legacyListKey, runId);
            break;
          }
          drained += 1;
        }
        if (drained > 0) {
          log.info('automation_legacy_list_drained', { legacyListKey, drained });
        }
      } catch (err) {
        log.warn('automation_legacy_list_drain_failed', {
          legacyListKey,
          drained,
          error: err,
        });
      }
      return drained;
    },

    async stop(): Promise<void> {
      await svc.close();
    },
  };
}
