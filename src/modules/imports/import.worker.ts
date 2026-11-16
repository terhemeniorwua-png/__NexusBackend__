import type { PrismaClient } from '@prisma/client';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import { createImportService } from './import.service';

const DEFAULT_POLL_INTERVAL_MS = 10_000;

export interface ImportWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<{ processed: number; succeeded: number; failed: number }>;
}

export function createImportWorker(deps: {
  prisma?: PrismaClient;
  logger?: Logger;
  pollIntervalMs?: number;
} = {}): ImportWorker {
  const log = deps.logger ?? defaultLogger;
  const service = createImportService(deps.prisma);
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let running = false;

  async function runOnce() {
    return service.processQueued();
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    running = true;
    try {
      const result = await runOnce();
      if (result.processed > 0) log.info('import_jobs_processed', result);
    } catch (error) {
      log.error('import_worker_failed', { error });
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(() => void tick(), pollIntervalMs);
        timer.unref();
      }
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setTimeout(() => void tick(), 0);
      timer.unref();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      while (running) await new Promise((resolve) => setTimeout(resolve, 25));
    },
    runOnce,
  };
}
