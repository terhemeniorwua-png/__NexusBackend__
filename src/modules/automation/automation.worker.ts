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

/**
 * Automation worker.
 *
 * Executes automation runs via a Redis-backed background job queue (primary)
 * with durable PostgreSQL run history/retries and a DB polling fallback.
 *
 * - Producers persist `AutomationRun` rows (idempotent by automationId+eventKey)
 *   and dispatch run IDs to Redis.
 * - This worker consumes run IDs from Redis and processes them by ID, claiming
 *   each run in PostgreSQL (FOR UPDATE SKIP LOCKED) so concurrent workers do not
 *   double-execute.
 * - A periodic DB polling pass picks up missed queue messages, delayed retries,
 *   and stale recovery.
 * - Scheduled triggers and due-date-passed triggers are materialized into queued
 *   runs on a schedule.
 */

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const SCHEDULE_INTERVAL_MS = 5 * 60_000;
const REDIS_DEQUEUE_TIMEOUT_SECONDS = 5;

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
}

function emptyResult(): ProcessRunsResult {
  return { claimed: 0, succeeded: 0, retried: 0, failed: 0, skipped: 0 };
}

export function createAutomationWorker(deps: AutomationWorkerDependencies): AutomationWorker {
  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? deps.engine?.now ?? (() => new Date());
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const scheduleIntervalMs = deps.scheduleIntervalMs ?? SCHEDULE_INTERVAL_MS;
  const engine: AutomationEngineDependencies = {
    ...deps.engine,
    prisma: deps.prisma,
    logger: deps.engine?.logger ?? log,
    now,
  };
  const queue = createAutomationRunQueue({ logger: log });

  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let running = false;
  let lastScheduleAt = 0;
  let lastMaintenanceAt = 0;
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
    // Also drain any immediately due queued work from Redis once (non-blocking fallback handled by loop)
    return maintenance;
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      running = true;
      deps.health?.passStarted();
      try {
        const currentTime = now();
        const maintenance = await runMaintenance(currentTime);

        // Consume from Redis queue (primary execution path)
        let runId: string | null = null;
        try {
          runId = await queue.dequeue(REDIS_DEQUEUE_TIMEOUT_SECONDS);
        } catch (error) {
          log.warn('automation_queue_consume_error', { error });
        }

        if (runId) {
          try {
            const result = await processAutomationRunById(engine, runId);
            if (result.claimed > 0) {
              log.debug('automation_run_processed_from_queue', { runId, ...result });
            }
            void maintenance; // keep variable used
          } catch (error) {
            log.error('automation_queue_run_failed', { runId, error });
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
      // Kick off maintenance immediately, then enter queue-consuming loop.
      timer = setTimeout(() => void loop(), 0);
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      // allow in-flight dequeue (bounded by BRPOP timeout) to finish
      const deadline = Date.now() + (REDIS_DEQUEUE_TIMEOUT_SECONDS + 2) * 1000;
      while (running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      deps.health?.stopped();
    },
    runOnce,
  };
}
