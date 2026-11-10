import type { AutomationTrigger, Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { logger as defaultLogger, type Logger } from '../../utils/logger';

/**
 * Domain-event bridge for outbound webhooks.
 *
 * The business services already publish automation events after a successful
 * mutation. The same event is mirrored into the durable webhook queue so a
 * workspace webhook receives task and membership events without a second
 * event bus. Queueing is best effort: a webhook failure must never roll back
 * or fail the business operation.
 */

export type WebhookDbClient = PrismaClient | Prisma.TransactionClient;

const TRIGGER_EVENTS: Partial<Record<AutomationTrigger, string>> = {
  EVENT_TASK_CREATED: 'task.created',
  EVENT_TASK_COMPLETED: 'task.completed',
  EVENT_MEMBER_JOINED: 'member.joined',
};

export function webhookEventName(trigger: AutomationTrigger): string | null {
  return TRIGGER_EVENTS[trigger] ?? null;
}

export async function enqueueWebhookEvent(
  input: {
    workspaceId: string;
    trigger: AutomationTrigger;
    payload: Record<string, unknown>;
  },
  client: WebhookDbClient = getPrismaClient(),
): Promise<number> {
  const event = webhookEventName(input.trigger);
  if (!event) return 0;

  const subscriptions = await client.webhookSubscription.findMany({
    where: {
      workspaceId: input.workspaceId,
      enabled: true,
      OR: [{ events: { has: event } }, { events: { has: '*' } }],
    },
    select: { id: true },
  });
  if (subscriptions.length === 0) return 0;

  const result = await client.webhookDelivery.createMany({
    data: subscriptions.map((subscription) => ({
      subscriptionId: subscription.id,
      event,
      payload: { trigger: input.trigger, ...input.payload } as Prisma.InputJsonValue,
    })),
  });
  return result.count;
}

export async function enqueueWebhookEventSafely(
  input: {
    workspaceId: string;
    trigger: AutomationTrigger;
    payload: Record<string, unknown>;
  },
  client: WebhookDbClient = getPrismaClient(),
  log: Logger = defaultLogger,
): Promise<number> {
  try {
    return await enqueueWebhookEvent(input, client);
  } catch (error) {
    log.error('webhook_enqueue_failed', {
      workspaceId: input.workspaceId,
      trigger: input.trigger,
      error,
    });
    return 0;
  }
}
