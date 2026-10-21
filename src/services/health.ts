import type { AppConfig } from '../config/env';
import { checkDatabase } from '../db/prisma';
import { checkRedis } from '../db/redis';

export interface DependencyStatus {
  status: 'up' | 'down';
  latencyMs: number;
}

export interface ReadinessStatus {
  status: 'ready' | 'not_ready';
  dependencies: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
}

export type ReadinessProbe = () => Promise<ReadinessStatus>;

async function runDependencyCheck(check: () => Promise<void>): Promise<DependencyStatus> {
  const startedAt = performance.now();

  try {
    await check();
    return {
      status: 'up',
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    };
  } catch {
    return {
      status: 'down',
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
    };
  }
}

export function createReadinessProbe(
  config: Pick<AppConfig, 'dbHealthTimeoutMs' | 'redisHealthTimeoutMs'>,
): ReadinessProbe {
  return async () => {
    const [database, redis] = await Promise.all([
      runDependencyCheck(() => checkDatabase(config.dbHealthTimeoutMs)),
      runDependencyCheck(() => checkRedis(config.redisHealthTimeoutMs)),
    ]);

    const ready = database.status === 'up' && redis.status === 'up';

    return {
      status: ready ? 'ready' : 'not_ready',
      dependencies: { database, redis },
    };
  };
}
