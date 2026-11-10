import type { PrismaClient } from '@prisma/client';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import {
  createWebhookService,
  type ProcessWebhookDeliveriesResult,
  type WebhookDeliveryDependencies,
} from './webhook.service';

/**
 * Outbound webhook worker (Phase 19).
 *
 * Delivery rows live in PostgreSQL. The worker claims due rows, sends them and
 * applies bounded retries, so a process restart never drops an event.
 */

const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface WebhookWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<ProcessWebhookDeliveriesResult>;
}

export interface WebhookWorkerDependencies {
  prisma: PrismaClient;
  service?: ReturnType<typeof createWebhookService>;
  delivery?: WebhookDeliveryDependencies;
  logger?: Logger;
  pollIntervalMs?: number;
  now?: () => Date;
}

export function createWebhookWorker(deps: WebhookWorkerDependencies): WebhookWorker {
  const log = deps.logger ?? defaultLogger;
  const service = deps.service ?? createWebhookService(deps.prisma, deps.delivery);
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = deps.now ?? (() => new Date());

  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let running = false;

  async function runOnce(): Promise<ProcessWebhookDeliveriesResult> {
    const result = await service.processDeliveries({ ...deps.delivery, now });
    if (result.claimed > 0) {
      log.info('webhook_delivery_pass_complete', { ...result });
    }
    return result;
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    running = true;
    try {
      await runOnce();
    } catch (error) {
      log.error('webhook_delivery_pass_failed', { error });
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
