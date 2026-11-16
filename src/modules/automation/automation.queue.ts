import type { RedisClientType } from 'redis';
import { getRedisClient } from '../../db/redis';
import { logger as defaultLogger, type Logger } from '../../utils/logger';

const DEFAULT_QUEUE_KEY = 'automation:runs';

export interface AutomationRunQueue {
  enqueue(runId: string): Promise<void>;
  enqueueMany(runIds: string[]): Promise<void>;
  dequeue(timeoutSeconds: number): Promise<string | null>;
  key: string;
}

export function createAutomationRunQueue(options: {
  redis?: RedisClientType;
  redisUrl?: string;
  namespace?: string;
  logger?: Logger;
} = {}): AutomationRunQueue {
  const log = options.logger ?? defaultLogger;
  const key = `${options.namespace ?? 'nexus'}:${DEFAULT_QUEUE_KEY}`;

  function client(): RedisClientType | null {
    try {
      return (options.redis ?? getRedisClient(options.redisUrl)) as RedisClientType;
    } catch {
      return null;
    }
  }

  return {
    key,
    async enqueue(runId: string): Promise<void> {
      const redis = client();
      if (!redis || !runId) return;
      try {
        await redis.lPush(key, runId);
      } catch (error) {
        log.warn('automation_queue_enqueue_failed', { error, runId });
      }
    },
    async enqueueMany(runIds: string[]): Promise<void> {
      const redis = client();
      if (!redis || runIds.length === 0) return;
      try {
        // lPush accepts multiple; push in chunks
        const chunkSize = 200;
        for (let i = 0; i < runIds.length; i += chunkSize) {
          const chunk = runIds.slice(i, i + chunkSize);
          if (chunk.length) await redis.lPush(key, chunk);
        }
      } catch (error) {
        log.warn('automation_queue_enqueue_many_failed', { error, count: runIds.length });
      }
    },
    async dequeue(timeoutSeconds: number): Promise<string | null> {
      const redis = client();
      if (!redis) return null;
      try {
        // node-redis v4: brPop returns { key, element } or null
        const result = await (redis as unknown as { brPop: (k: string, t: number) => Promise<string | { element: string } | null> }).brPop(key, timeoutSeconds);
        if (!result) return null;
        if (typeof result === 'string') return result;
        if (typeof result === 'object' && result && 'element' in result) return (result as { element: string }).element;
        return null;
      } catch (error) {
        log.warn('automation_queue_dequeue_failed', { error });
        return null;
      }
    },
  };
}
