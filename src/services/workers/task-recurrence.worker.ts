import type { PrismaClient } from '@prisma/client';
import type { WorkerHealthRecorder } from './worker-health';
import type { Logger } from '../../utils/logger';
import { logger as defaultLogger } from '../../utils/logger';
import { createTaskAdvancedService } from '../../modules/tasks/task-advanced.service';

const DEFAULT_POLL_INTERVAL_MS = 60_000;

export interface TaskRecurrenceWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(currentTime?: Date): Promise<{ processed: number; generated: number; skipped: number }>;
}

export interface TaskRecurrenceWorkerDeps {
  prisma: PrismaClient;
  logger?: Logger;
  pollIntervalMs?: number;
  now?: () => Date;
  health?: WorkerHealthRecorder;
}

export function createTaskRecurrenceWorker(deps: TaskRecurrenceWorkerDeps): TaskRecurrenceWorker {
  const log = deps.logger ?? defaultLogger;
  const nowFn = deps.now ?? (() => new Date());
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const service = createTaskAdvancedService(deps.prisma);

  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let running = false;

  async function runOnce(currentTime?: Date): Promise<{ processed: number; generated: number; skipped: number }> {
    const now = currentTime ?? nowFn();
    return service.processDueRecurrences(now);
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    running = true;
    deps.health?.passStarted();
    try {
      const result = await runOnce();
      if (result.generated || result.processed) {
        log.info('task_recurrence_pass_complete', result);
      }
      deps.health?.succeeded();
    } catch (error) {
      log.error('task_recurrence_pass_failed', { error });
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
