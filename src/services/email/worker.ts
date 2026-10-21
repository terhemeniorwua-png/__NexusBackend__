import type { AppConfig } from '../../config/env';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import type { DeliveryPassResult, EmailDeliveryService } from './delivery.service';

/**
 * Email delivery worker.
 *
 * The worker polls the outbox and hands due deliveries to the provider. It
 * runs inside the API process, but the outbox is the coordination point: the
 * claim uses `FOR UPDATE SKIP LOCKED`, so several instances can run the same
 * worker without sending a message twice.
 *
 * Later phases introduce the shared BullMQ infrastructure. The outbox stays
 * the source of truth, so moving the transport to a queue does not change the
 * delivery semantics.
 */
export interface EmailWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<DeliveryPassResult>;
}

export interface EmailWorkerDependencies {
  service: EmailDeliveryService;
  config: AppConfig;
  logger?: Logger;
}

export function createEmailWorker(deps: EmailWorkerDependencies): EmailWorker {
  const log = deps.logger ?? defaultLogger;
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = true;

  async function runOnce(): Promise<DeliveryPassResult> {
    return deps.service.processPending(deps.config.emailWorkerBatchSize);
  }

  async function tick(): Promise<void> {
    if (stopped) {
      return;
    }

    running = true;

    try {
      const result = await runOnce();

      if (result.claimed > 0) {
        log.info('email_worker_pass_complete', {
          claimed: result.claimed,
          sent: result.sent,
          failed: result.failed,
          retried: result.retried,
          suppressed: result.suppressed,
        });
      }
    } catch (error) {
      log.error('email_worker_pass_failed', { error });
    } finally {
      running = false;
      schedule();
    }
  }

  function schedule(): void {
    if (stopped) {
      return;
    }

    timer = setTimeout(() => {
      void tick();
    }, deps.config.emailWorkerPollIntervalMs);

    // The worker must never keep the process alive on its own.
    timer.unref();
  }

  return {
    start(): void {
      if (!stopped) {
        return;
      }

      stopped = false;
      log.info('email_worker_started', {
        pollIntervalMs: deps.config.emailWorkerPollIntervalMs,
        batchSize: deps.config.emailWorkerBatchSize,
      });

      schedule();
    },

    async stop(): Promise<void> {
      stopped = true;

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      // Let a pass that is already running finish.
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      log.info('email_worker_stopped');
    },

    runOnce,
  };
}
