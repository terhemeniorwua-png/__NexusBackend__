import { createClient, type RedisClientType } from 'redis';
import type { AppConfig } from '../config/env';
import { logger } from '../utils/logger';
import { withTimeout } from '../utils/timeout';

let redisClient: RedisClientType | null = null;
let configuredUrl: string | null = null;

function createRedisClient(url: string): RedisClientType {
  const client = createClient({
    url,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: (retries) => {
        if (retries >= 5) {
          return new Error('Redis reconnect attempts exhausted');
        }

        return Math.min(100 * 2 ** retries, 1_000);
      },
    },
  });

  client.on('error', (error) => {
    logger.warn('redis_error', { error });
  });

  client.on('reconnecting', () => {
    logger.warn('redis_reconnecting');
  });

  client.on('ready', () => {
    logger.info('redis_ready');
  });

  return client;
}

export function getRedisClient(redisUrl?: string): RedisClientType {
  const url = redisUrl ?? configuredUrl;

  if (!url) {
    throw new Error('Redis URL has not been configured');
  }

  if (!redisClient || url !== configuredUrl) {
    if (redisClient) {
      redisClient.destroy();
    }

    configuredUrl = url;
    redisClient = createRedisClient(url);
  }

  return redisClient;
}

export async function connectRedis(config: Pick<AppConfig, 'redisUrl'>): Promise<void> {
  const client = getRedisClient(config.redisUrl);

  if (!client.isOpen) {
    await client.connect();
  }
}

export async function checkRedis(timeoutMs: number): Promise<void> {
  const client = getRedisClient();

  if (!client.isOpen) {
    await withTimeout(client.connect(), timeoutMs, 'Redis health check timed out');
  }

  await withTimeout(client.ping(), timeoutMs, 'Redis health check timed out');
}

export async function disconnectRedis(): Promise<void> {
  const client = redisClient;
  redisClient = null;
  configuredUrl = null;

  if (!client) {
    return;
  }

  if (client.isOpen) {
    try {
      await client.quit();
    } catch {
      client.destroy();
    }
  }
}
