import type { PrismaClient } from '@prisma/client';
import type { WorkerHealthRecorder } from '../../services/workers/worker-health';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import {
  enqueueScheduledRuns,
  processPendingRuns,
  type AutomationEngineDependencies,
  type ProcessRunsResult,
  type ScheduledRunsResult,
} from './automation.engine';

/**
 * Automation worker.
 *
 * The worker runs inside the API process and polls the durable
 * `AutomationRun` table. PostgreSQL is the source of truth: a restart does not
 * lose queued runs, and the claim in `processPendingRuns` prevents two
 * instances from executing the same run.
 *
 * Scheduled triggers are materialised into normal queued runs, so they share
 * the same retry, idempotency and history behaviour as event triggers.
 */

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const SCHEDULE_INTERVAL_MS = 5 * 60_000;

export interface AutomationWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<{ runs: ProcessRunsResult; scheduled: ScheduledRunsResult }>;
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

  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let running = false;
  let lastScheduleAt: Date | null = null;

  async function runOnce(): Promise<{
    runs: ProcessRunsResult;
    scheduled: ScheduledRunsResult;
  }> {
    const currentTime = now();
    let scheduled: ScheduledRunsResult = { queued: 0 };

    if (!lastScheduleAt || currentTime.getTime() - lastScheduleAt.getTime() >= scheduleIntervalMs) {
      lastScheduleAt = currentTime;
      scheduled = await enqueueScheduledRuns(engine, currentTime);
      if (scheduled.queued > 0) {
        log.info('automation_scheduled_runs_queued', { ...scheduled });
      }
    }

    const runs = await processPendingRuns(engine);
    if (runs.claimed > 0) {
      log.info('automation_run_pass_complete', { ...runs });
    }

    return { runs, scheduled };
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    running = true;
    deps.health?.passStarted();
    try {
      await runOnce();
      deps.health?.succeeded();
    } catch (error) {
      log.error('automation_run_pass_failed', { error });
      deps.health?.failed(error);
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
      deps.health?.started();
      timer = setTimeout(() => void tick(), 0);
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      while (running) await new Promise((resolve) => setTimeout(resolve, 25));
      deps.health?.stopped();
    },
    runOnce,
  };
}
