import type { PrismaClient } from '@prisma/client';
import type { WorkerHealthRecorder } from '../../services/workers/worker-health';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import {
  enqueueScheduledRuns,
  processAutomationRunById,
  processPendingRuns,
  type AutomationEngineDependencies,
  type ProcessRunsResult,
  type ScheduledRunsResult,
} from './automation.engine';
import { createAutomationRunQueue } from './automation.queue';
import { enqueueAutomationRunsSafely } from './automation.events';
import os from 'node:os';

/**
 * Automation worker.
 *
 * Executes automation runs via a Redis Streams-backed background job queue
 * (primary) with durable PostgreSQL run history/retries and a DB polling
 * fallback.
 *
 * - Producers persist `AutomationRun` rows (idempotent by automationId+eventKey)
 *   and dispatch run IDs onto the Redis Stream
 *   `<namespace>:stream:automation:runs` (consumer group
 *   `automation-workers`).
 * - This worker reads entries via XREADGROUP using a stable consumer name
 *   (`hostname:pid`) on a dedicated blocking connection, and ACKs an entry
 *   only after its run completes.  Failed entries stay in the PEL and are
 *   reclaimed (XAUTOCLAIM) for retry; entries that exceed the delivery limit
 *   (5) are moved to the dead-letter stream
 *   `<namespace>:stream:automation:runs:dead`.
 * - A periodic DB polling pass picks up missed queue messages, delayed
 *   retries, and stale recovery.
 * - Scheduled triggers and due-date-passed triggers are materialized into
 *   queued runs on a schedule.
 * - On startup any residual items in the legacy Redis list
 *   `<namespace>:automation:runs` are drained into the stream once.
 */

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const SCHEDULE_INTERVAL_MS = 5 * 60_000;
const STREAM_BLOCK_MS = 5_000;
const STREAM_BATCH_SIZE = 10;
const RECLAIM_INTERVAL_MS = 30_000;
const RECLAIM_IDLE_MS = 60_000;
const RECLAIM_COUNT = 50;

export interface AutomationWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<{ runs: ProcessRunsResult; scheduled: ScheduledRunsResult; dueDateQueued: number }>;
}

export interface AutomationWorkerDependencies {
  prisma: PrismaClient;
  engine?: Omit<AutomationEngineDependencies, 'prisma'>;
  logger?: Logger;
  pollIntervalMs?: number;
  scheduleIntervalMs?: number;
  now?: () => Date;
  /** Optional liveness recorder for `GET /health/workers`. */
  health?: WorkerHealthRecorder;
  /** Stream read block time (ms). Default 5 000. */
  streamBlockMs?: number;
  /** Entries read per XREADGROUP. Default 10. */
  streamBatchSize?: number;
  /** Reclaim pass interval (ms). Default 30 000. */
  reclaimIntervalMs?: number;
  /** Idle time before a pending entry is reclaimed (ms). Default 60 000. */
  reclaimIdleMs?: number;
  /** Deliveries before an entry is dead-lettered. Default 5. */
  maxDeliveries?: number;
  /** Explicit consumer name override (tests). */
  consumerName?: string;
  /** Redis URL for the queue (tests). Never read from process.env here. */
  redisUrl?: string;
}

function emptyResult(): ProcessRunsResult {
  return { claimed: 0, succeeded: 0, retried: 0, failed: 0, skipped: 0 };
}

export function createAutomationWorker(deps: AutomationWorkerDependencies): AutomationWorker {
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? deps.engine?.now ?? (() => new Date());
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const scheduleIntervalMs = deps.scheduleIntervalMs ?? SCHEDULE_INTERVAL_MS;
  const streamBlockMs = deps.streamBlockMs ?? STREAM_BLOCK_MS;
  const streamBatchSize = deps.streamBatchSize ?? STREAM_BATCH_SIZE;
  const reclaimIntervalMs = deps.reclaimIntervalMs ?? RECLAIM_INTERVAL_MS;
  const reclaimIdleMs = deps.reclaimIdleMs ?? RECLAIM_IDLE_MS;
  const maxDeliveries = deps.maxDeliveries ?? 5;
  const consumerName = deps.consumerName ?? `${os.hostname()}:${process.pid}`;

  const engine: AutomationEngineDependencies = {
    ...deps.engine,
    prisma: deps.prisma,
    logger: deps.engine?.logger ?? log,
    now,
  };
  const queue = createAutomationRunQueue({
    logger: log,
    maxDeliveries,
    ...(deps.redisUrl ? { redisUrl: deps.redisUrl } : {}),
  });

  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let running = false;
  let lastScheduleAt = 0;
  let lastMaintenanceAt = 0;
  let lastReclaimAt = 0;
  let legacyMigrated = false;
  // Rotating cursor over overdue tasks. Without it, a workspace with more than
  // one page of overdue work would repeatedly scan the same oldest 200 tasks
  // and starve the rest.
  let dueDateCursor: string | null = null;

  async function enqueueDueDatePassed(currentTime: Date): Promise<number> {
    // Find tasks whose due date has passed and are not in a terminal state.
    // Event keys include the due timestamp, so a due date that is moved and
    // passes again produces a new event while repeated scans are idempotent.
    try {
      const dueTasks = await deps.prisma.task.findMany({
        where: {
          dueDate: { lte: currentTime },
          deletedAt: null,
          archivedAt: null,
          completedAt: null,
          status: { not: 'APPROVED' },
          project: { deletedAt: null, workspace: { deletedAt: null } },
        },
        select: {
          id: true,
          projectId: true,
          status: true,
          priority: true,
          dueDate: true,
          assignees: { select: { userId: true } },
          project: { select: { workspaceId: true } },
        },
        ...(dueDateCursor ? { cursor: { id: dueDateCursor }, skip: 1 } : {}),
        take: 200,
        orderBy: { id: 'asc' },
      });

      if (dueTasks.length < 200) dueDateCursor = null;
      else dueDateCursor = dueTasks[dueTasks.length - 1]?.id ?? null;

      let queued = 0;
      for (const task of dueTasks) {
        const dueIso = task.dueDate ? task.dueDate.toISOString() : 'none';
        const eventKey = `task.due_date_passed:${task.id}:${dueIso}`;
        queued += await enqueueAutomationRunsSafely(
          {
            workspaceId: task.project.workspaceId,
            trigger: 'EVENT_TASK_DUE_DATE_PASSED' as never,
            eventKey,
            payload: {
              eventKey,
              workspaceId: task.project.workspaceId,
              projectId: task.projectId,
              taskId: task.id,
              status: task.status,
              priority: task.priority,
              dueDate: task.dueDate?.toISOString() ?? null,
              assigneeIds: task.assignees.map((a) => a.userId).join(','),
            },
          },
          deps.prisma,
          log,
        );
      }
      return queued;
    } catch (error) {
      // A cursor that no longer resolves (task deleted mid-cycle) must not
      // wedge every future pass.
      dueDateCursor = null;
      log.warn('automation_due_date_scan_failed', { error });
      return 0;
    }
  }

  async function runMaintenance(currentTime: Date): Promise<{ scheduled: ScheduledRunsResult; dueDateQueued: number; runs: ProcessRunsResult }> {
    let scheduled: ScheduledRunsResult = { queued: 0 };
    let dueDateQueued = 0;

    if (currentTime.getTime() - lastScheduleAt >= scheduleIntervalMs) {
      lastScheduleAt = currentTime.getTime();
      try {
        scheduled = await enqueueScheduledRuns(engine, currentTime);
      } catch (error) {
        log.error('automation_schedule_enqueue_failed', { error });
      }
      dueDateQueued = await enqueueDueDatePassed(currentTime);
      if (scheduled.queued > 0 || dueDateQueued > 0) {
        log.info('automation_scheduled_or_due_enqueued', { ...scheduled, dueDateQueued });
      }
    }

    let runs = emptyResult();
    if (currentTime.getTime() - lastMaintenanceAt >= pollIntervalMs) {
      lastMaintenanceAt = currentTime.getTime();
      try {
        runs = await processPendingRuns(engine);
        if (runs.claimed > 0) {
          log.info('automation_db_poll_pass_complete', { ...runs });
        }
      } catch (error) {
        log.error('automation_db_poll_failed', { error });
      }
    }

    return { scheduled, dueDateQueued, runs };
  }

  async function runOnce(): Promise<{ runs: ProcessRunsResult; scheduled: ScheduledRunsResult; dueDateQueued: number }> {
    const currentTime = now();
    const maintenance = await runMaintenance(currentTime);
    // Also drain any immediately due queued work from the stream once
    // (non-blocking; the loop handles the blocking path).
    const entries = await queue.consume(consumerName, { count: streamBatchSize });
    for (const entry of entries) {
      await handleEntry(entry);
    }
    return maintenance;
  }

  /**
   * Process one stream entry: ACK on success, leave pending on failure.
   * Entries past the delivery limit are dead-lettered instead of retried.
   */
  async function handleEntry(entry: { id: string; runId: string; deliveries: number }): Promise<void> {
    if (!entry.runId) {
      // Malformed entry — discard it so it cannot wedge the PEL.
      await queue.ackEntries([entry.id]);
      log.warn('automation_stream_malformed_entry', { id: entry.id });
      return;
    }

    if (entry.deliveries >= maxDeliveries) {
      await queue.deadLetter(entry, `exceeded ${maxDeliveries} deliveries`);
      return;
    }

    try {
      const result = await processAutomationRunById(engine, entry.runId);
      if (result.claimed > 0) {
        log.debug('automation_run_processed_from_stream', {
          runId: entry.runId,
          entryId: entry.id,
          ...result,
        });
      }
      // ACK only after the run completed (processed or already claimed
      // elsewhere; the DB claim makes double-processing harmless).
      await queue.ackEntries([entry.id]);
    } catch (error) {
      // Leave the entry pending: the reclaim pass will retry it.
      log.error('automation_queue_run_failed', { runId: entry.runId, entryId: entry.id, error });
    }
  }

  /** Periodic reclaim so crashed workers' entries are retried by live ones. */
  async function maybeReclaim(): Promise<void> {
    const t = Date.now();
    if (t - lastReclaimAt < reclaimIntervalMs) return;
    lastReclaimAt = t;
    try {
      const reclaimed = await queue.reclaimStale(consumerName, reclaimIdleMs, RECLAIM_COUNT);
      if (reclaimed.length > 0) {
        log.info('automation_stream_entries_reclaimed', { count: reclaimed.length });
        for (const entry of reclaimed) {
          await handleEntry(entry);
        }
      }
    } catch (error) {
      log.warn('automation_stream_reclaim_failed', { error });
    }
  }

  async function loop(): Promise<void> {
    // Ensure the consumer group exists before reading.
    await queue.ensureGroup();

    // One-time legacy list migration (idempotent).
    if (!legacyMigrated) {
      legacyMigrated = true;
      try {
        const drained = await queue.migrateLegacyList();
        if (drained > 0) {
          log.info('automation_legacy_list_migration_complete', { drained });
        }
      } catch (error) {
        log.warn('automation_legacy_list_migration_failed', { error });
      }
    }

    let emptyStreak = 0;
    while (!stopped) {
      running = true;
      deps.health?.passStarted();
      try {
        const currentTime = now();
        const maintenance = await runMaintenance(currentTime);
        void maintenance;

        await maybeReclaim();

        // Consume from the Redis Stream (primary execution path).
        const entries = await queue.consume(consumerName, {
          count: streamBatchSize,
          blockMs: streamBlockMs,
        });

        if (entries.length === 0) {
          // When Redis is unavailable `consume` returns immediately with an
          // empty array; back off so the loop retries instead of spinning.
          emptyStreak = Math.min(emptyStreak + 1, 5);
          await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** emptyStreak, 4_000)));
        } else {
          emptyStreak = 0;
          for (const entry of entries) {
            if (stopped) break;
            await handleEntry(entry);
          }
        }

        deps.health?.succeeded();
      } catch (error) {
        log.error('automation_worker_loop_failed', { error });
        deps.health?.failed(error);
        // avoid hot loop on persistent failure
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } finally {
        running = false;
      }
    }
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      deps.health?.started();
      // Kick off maintenance immediately, then enter the stream-consuming loop.
      timer = setTimeout(() => void loop(), 0);
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      // allow the in-flight blocking read and any in-flight run to finish
      const deadline = Date.now() + streamBlockMs + 30_000;
      while (running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      // Close the dedicated blocking-read connection.
      await queue.stop();
      deps.health?.stopped();
    },
    runOnce,
  };
}
