import type { AutomationTrigger, Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import { enqueueWebhookEventSafely } from '../webhooks/webhook.events';
import { createAutomationRunQueue } from './automation.queue';

/**
 * Automation event registration.
 *
 * Application services publish a domain event here. The publisher does not
 * execute an automation synchronously: it only writes a queued run per matching
 * automation and dispatches run IDs to the Redis-backed job queue. The worker
 * in `automation.worker.ts` consumes the queue (with DB polling fallback),
 * which keeps request latency predictable and makes failures retryable.
 *
 * Idempotency is enforced by the `(automationId, eventKey)` unique index. A
 * replayed HTTP request or a duplicate domain event therefore cannot create a
 * second run for the same automation and event.
 */

export const MAX_AUTOMATIONS_PER_EVENT = 50;

export type AutomationDbClient = PrismaClient | Prisma.TransactionClient;

export interface AutomationEventInput {
  workspaceId: string;
  trigger: AutomationTrigger;
  /** Stable identifier of the domain event, unique per automation. */
  eventKey: string;
  payload: Record<string, unknown>;
}

export async function enqueueAutomationRuns(
  event: AutomationEventInput,
  client: AutomationDbClient = getPrismaClient(),
  log: Logger = defaultLogger,
): Promise<number> {
  const automations = await client.automation.findMany({
    where: {
      workspaceId: event.workspaceId,
      trigger: event.trigger,
      enabled: true,
      deletedAt: null,
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_AUTOMATIONS_PER_EVENT,
    select: { id: true },
  });

  if (automations.length === 0) {
    return 0;
  }

  const result = await client.automationRun.createMany({
    data: automations.map((automation) => ({
      automationId: automation.id,
      eventKey: event.eventKey,
      payload: event.payload as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
  });

  if (result.count > 0) {
    // Dispatch newly created/claimable runs to the Redis job queue.
    try {
      const runs = await client.automationRun.findMany({
        where: {
          automationId: { in: automations.map((a) => a.id) },
          eventKey: event.eventKey,
          status: 'PENDING',
        },
        select: { id: true },
      });
      if (runs.length > 0) {
        await createAutomationRunQueue({ logger: log }).enqueueMany(runs.map((r) => r.id));
      }
    } catch (error) {
      // Queue dispatch is best-effort; DB polling fallback will pick up runs.
      log.warn('automation_queue_dispatch_failed', {
        workspaceId: event.workspaceId,
        trigger: event.trigger,
        eventKey: event.eventKey,
        error,
      });
    }

    log.debug('automation_runs_enqueued', {
      workspaceId: event.workspaceId,
      trigger: event.trigger,
      eventKey: event.eventKey,
      queued: result.count,
    });
  }

  return result.count;
}

/**
 * Publish an event without letting an automation failure break the business
 * operation that produced it. Core Nexus features must keep working even when
 * automation storage or execution is unavailable.
 */
export async function enqueueAutomationRunsSafely(
  event: AutomationEventInput,
  client: AutomationDbClient = getPrismaClient(),
  log: Logger = defaultLogger,
): Promise<number> {
  let runs = 0;
  try {
    runs = await enqueueAutomationRuns(event, client, log);
  } catch (error) {
    log.error('automation_enqueue_failed', {
      workspaceId: event.workspaceId,
      trigger: event.trigger,
      eventKey: event.eventKey,
      error,
    });
  }

  // Mirror the same domain event into workspace webhook subscriptions. The
  // helper catches its own failures, so webhooks can never break automation or
  // the business operation that produced the event.
  await enqueueWebhookEventSafely(
    { workspaceId: event.workspaceId, trigger: event.trigger, payload: event.payload },
    client,
    log,
  );

  return runs;
}
