import type { PrismaClient } from '@prisma/client';
import type { BillingService } from './billing.service';
import { logger as defaultLogger, type Logger } from '../../utils/logger';

const BATCH_SIZE = 25;
const POLL_INTERVAL_MS = 30_000;
const STALE_PROCESSING_MS = 5 * 60_000;
const MAX_ATTEMPTS = 10;
const RECONCILIATION_INTERVAL_MS = 10 * 60_000;

export interface BillingSeatSyncWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<{ claimed: number; completed: number; retried: number }>;
}

export function createBillingSeatSyncWorker(input: {
  prisma: PrismaClient;
  service: BillingService;
  logger?: Logger;
  now?: () => Date;
}): BillingSeatSyncWorker {
  const log = input.logger ?? defaultLogger;
  const now = input.now ?? (() => new Date());
  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let running = false;
  let lastReconciliationAt: Date | null = null;

  async function runOnce() {
    const currentTime = now();
    const rows = await input.prisma.billingSeatSync.findMany({
      where: {
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: currentTime } },
          {
            status: 'PROCESSING',
            updatedAt: { lte: new Date(currentTime.getTime() - STALE_PROCESSING_MS) },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, workspaceId: true, status: true, updatedAt: true, attempts: true },
    });
    let claimed = 0;
    let completed = 0;
    let retried = 0;

    for (const row of rows) {
      const claim = await input.prisma.billingSeatSync.updateMany({
        where:
          row.status === 'PENDING'
            ? { id: row.id, status: 'PENDING', nextAttemptAt: { lte: currentTime } }
            : { id: row.id, status: 'PROCESSING', updatedAt: row.updatedAt },
        data: { status: 'PROCESSING', attempts: { increment: 1 } },
      });
      if (claim.count !== 1) continue;
      claimed += 1;
      try {
        await input.service.synchronizeSeatReduction({
          workspaceId: row.workspaceId,
          syncId: row.id,
        });
        await input.prisma.billingSeatSync.updateMany({
          where: { id: row.id, status: 'PROCESSING' },
          data: { status: 'COMPLETED', lastError: null },
        });
        completed += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        const requiresReconciliation = attempts >= MAX_ATTEMPTS;
        const safeMessage =
          error instanceof Error ? error.message.slice(0, 300) : 'Billing seat sync failed';
        await input.prisma.billingSeatSync.updateMany({
          where: { id: row.id, status: 'PROCESSING' },
          data: {
            status: requiresReconciliation ? 'RECONCILIATION_REQUIRED' : 'PENDING',
            nextAttemptAt: new Date(
              currentTime.getTime() + Math.min(attempts * 60_000, 15 * 60_000),
            ),
            lastError: safeMessage,
          },
        });
        retried += 1;
        log.error('billing_seat_sync_failed', {
          workspaceId: row.workspaceId,
          attempts,
          requiresReconciliation,
          error: safeMessage,
        });
      }
    }
    const cancellationRows = await input.prisma.billingCancellation.findMany({
      where: {
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: currentTime } },
          {
            status: 'PROCESSING',
            updatedAt: { lte: new Date(currentTime.getTime() - STALE_PROCESSING_MS) },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, workspaceId: true, status: true, updatedAt: true, attempts: true },
    });
    for (const row of cancellationRows) {
      const claim = await input.prisma.billingCancellation.updateMany({
        where:
          row.status === 'PENDING'
            ? { id: row.id, status: 'PENDING', nextAttemptAt: { lte: currentTime } }
            : { id: row.id, status: 'PROCESSING', updatedAt: row.updatedAt },
        data: { status: 'PROCESSING', attempts: { increment: 1 } },
      });
      if (claim.count !== 1) continue;
      claimed += 1;
      try {
        await input.service.synchronizeDeletionCancellation({ workspaceId: row.workspaceId });
        await input.prisma.billingCancellation.updateMany({
          where: { id: row.id, status: 'PROCESSING' },
          data: { status: 'COMPLETED', lastError: null },
        });
        completed += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        const requiresReconciliation = attempts >= MAX_ATTEMPTS;
        const safeMessage =
          error instanceof Error ? error.message.slice(0, 300) : 'Billing cancellation failed';
        await input.prisma.billingCancellation.updateMany({
          where: { id: row.id, status: 'PROCESSING' },
          data: {
            status: requiresReconciliation ? 'RECONCILIATION_REQUIRED' : 'PENDING',
            nextAttemptAt: new Date(
              currentTime.getTime() + Math.min(attempts * 60_000, 15 * 60_000),
            ),
            lastError: safeMessage,
          },
        });
        retried += 1;
        log.error('billing_deletion_cancellation_failed', {
          workspaceId: row.workspaceId,
          attempts,
          requiresReconciliation,
          error: safeMessage,
        });
      }
    }
    if (
      !lastReconciliationAt ||
      currentTime.getTime() - lastReconciliationAt.getTime() >= RECONCILIATION_INTERVAL_MS
    ) {
      lastReconciliationAt = currentTime;
      const result = await input.service.reconcileProviderState();
      if (result.mismatches || result.repairedCheckouts) {
        log.info('billing_provider_reconciliation_complete', result);
      }
    }
    return { claimed, completed, retried };
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    running = true;
    try {
      const result = await runOnce();
      if (result.claimed) log.info('billing_seat_sync_pass_complete', result);
    } catch (error) {
      log.error('billing_seat_sync_pass_failed', { error });
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
