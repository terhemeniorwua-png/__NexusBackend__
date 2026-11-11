import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import type { WorkerHealthRecorder } from './worker-health';
import { logger as defaultLogger, type Logger } from '../../utils/logger';

/**
 * Audit log retention pruning worker.
 *
 * Audit logs are append-only security records, but they must not grow without
 * bound. This worker deletes `AuditLog` rows older than
 * `config.auditRetentionDays` in bounded batches of
 * `config.auditPruneBatchSize`, so a single pass never holds a long-running
 * transaction or blocks the database.
 *
 * Deletion is irreversible by design: audit retention is a product decision
 * and the batch size keeps each pass short enough to survive a restart.
 */

export interface AuditPruneWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<{ scanned: number; deleted: number }>;
}

const POLL_INTERVAL_MS = 60_000;

export function createAuditPruneWorker(input: {
  prisma: PrismaClient;
  config: AppConfig;
  logger?: Logger;
  now?: () => Date;
  /** Optional liveness recorder for `GET /health/workers`. */
  health?: WorkerHealthRecorder;
}): AuditPruneWorker {
  const log = input.logger ?? defaultLogger;
  const now = input.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let running = false;

  async function runOnce(): Promise<{ scanned: number; deleted: number }> {
    const cutoff = new Date(
      now().getTime() - input.config.auditRetentionDays * 24 * 60 * 60 * 1000,
    );
    let deleted = 0;
    let scanned = 0;

    // Delete in bounded batches until nothing remains older than the cutoff.
    // Prisma does not support batched delete directly, so loop with take.
    while (true) {
      const stale = await input.prisma.auditLog.findMany({
        where: { createdAt: { lt: cutoff } },
        orderBy: { createdAt: 'asc' },
        take: input.config.auditPruneBatchSize,
        select: { id: true },
      });
      scanned += stale.length;
      if (stale.length === 0) break;

      const result = await input.prisma.auditLog.deleteMany({
        where: { id: { in: stale.map((row) => row.id) } },
      });
      deleted += result.count;
      if (result.count < stale.length) break;
    }

    return { scanned, deleted };
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    running = true;
    input.health?.passStarted();
    try {
      const result = await runOnce();
      if (result.scanned || result.deleted) {
        log.info('audit_prune_pass_complete', result);
      }
      input.health?.succeeded();
    } catch (error) {
      log.error('audit_prune_pass_failed', { error });
      input.health?.failed(error);
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
        timer.unref();
      }
    }
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      input.health?.started();
      timer = setTimeout(() => void tick(), 0);
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      while (running) await new Promise((resolve) => setTimeout(resolve, 25));
      input.health?.stopped();
    },
    runOnce,
  };
}
