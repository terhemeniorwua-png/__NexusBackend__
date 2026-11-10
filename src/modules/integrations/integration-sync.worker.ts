import type { PrismaClient } from '@prisma/client';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import { createIntegrationService, type ProcessSyncJobsResult } from './integration.service';

/**
 * Integration sync worker (Phase 19).
 *
 * PostgreSQL is the durable queue. The worker only claims due
 * `IntegrationSyncJob` rows, so a restart never loses queued work and two API
 * instances cannot process the same job. Provider failures use bounded
 * exponential backoff in `processSyncJobs`.
 */

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export interface IntegrationSyncWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<ProcessSyncJobsResult>;
}

export interface IntegrationSyncWorkerDependencies {
  prisma: PrismaClient;
  service?: ReturnType<typeof createIntegrationService>;
  logger?: Logger;
  pollIntervalMs?: number;
  now?: () => Date;
}

export function createIntegrationSyncWorker(
  deps: IntegrationSyncWorkerDependencies,
): IntegrationSyncWorker {
  const log = deps.logger ?? defaultLogger;
  const service = deps.service ?? createIntegrationService(deps.prisma);
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = deps.now ?? (() => new Date());

  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let running = false;

  async function runOnce(): Promise<ProcessSyncJobsResult> {
    const result = await service.processSyncJobs({ now: now() });
    if (result.claimed > 0) {
      log.info('integration_sync_pass_complete', { ...result });
    }
    return result;
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    running = true;
    try {
      await runOnce();
    } catch (error) {
      log.error('integration_sync_pass_failed', { error });
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(() => void tick(), pollIntervalMs);
        timer.unref();
      }
    }
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      timer = setTimeout(() => void tick(), 0);
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      while (running) await new Promise((resolve) => setTimeout(resolve, 25));
    },
    runOnce,
  };
}
