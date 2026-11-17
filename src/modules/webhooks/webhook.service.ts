import { createHmac, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient, WebhookSubscription } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { assertSafeWebhookUrl } from '../automation/automation.engine';
import { decryptIntegrationToken, encryptIntegrationToken } from '../integrations/token-crypto';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import type { WorkspaceAccessContext } from '../workspaces/authorization';

/**
 * Workspace outbound webhooks (Phase 19).
 *
 * A subscription belongs to one workspace and is managed by OWNER /
 * PROJECT_MANAGER. Deliveries are written to PostgreSQL before any network
 * call, so a restart never loses an event. The worker claims due rows with
 * `FOR UPDATE SKIP LOCKED`, signs the body with HMAC-SHA256 and retries with
 * bounded exponential backoff.
 *
 * Secrets are encrypted with the shared integration token key and are only
 * returned once, when the subscription is created or its secret is rotated.
 */

type Input = { userId: string; workspaceId: string; context: WorkspaceAccessContext };

const DELIVERY_BATCH_SIZE = 25;
const STALE_DELIVERY_RUNNING_MS = 5 * 60_000;
const WEBHOOK_TIMEOUT_MS = 10_000;
const MIN_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

export interface WebhookSummary {
  id: string;
  workspaceId: string;
  url: string;
  events: string[];
  description: string | null;
  enabled: boolean;
  lastDeliveryAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface WebhookDeliverySummary {
  id: string;
  subscriptionId: string;
  event: string;
  status: string;
  attempts: number;
  maxRetries: number;
  responseStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string;
  deliveredAt: string | null;
  createdAt: string;
}

export interface ProcessWebhookDeliveriesResult {
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
}

export interface WebhookDeliveryDependencies {
  fetchImpl?: typeof fetch;
  /** Override the SSRF guard in tests. Production always resolves DNS. */
  resolveWebhookUrl?: (raw: string) => Promise<URL>;
  now?: () => Date;
}

function backoffFor(attempts: number): number {
  const delay = MIN_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, MAX_BACKOFF_MS);
}

function summary(subscription: WebhookSubscription): WebhookSummary {
  return {
    id: subscription.id,
    workspaceId: subscription.workspaceId,
    url: subscription.url,
    events: subscription.events,
    description: subscription.description,
    enabled: subscription.enabled,
    lastDeliveryAt: subscription.lastDeliveryAt?.toISOString() ?? null,
    lastError: subscription.lastError,
    createdAt: subscription.createdAt.toISOString(),
  };
}

function deliverySummary(delivery: {
  id: string;
  subscriptionId: string;
  event: string;
  status: string;
  attempts: number;
  maxRetries: number;
  responseStatus: number | null;
  lastError: string | null;
  nextAttemptAt: Date;
  deliveredAt: Date | null;
  createdAt: Date;
}): WebhookDeliverySummary {
  return {
    id: delivery.id,
    subscriptionId: delivery.subscriptionId,
    event: delivery.event,
    status: delivery.status,
    attempts: delivery.attempts,
    maxRetries: delivery.maxRetries,
    responseStatus: delivery.responseStatus,
    lastError: delivery.lastError,
    nextAttemptAt: delivery.nextAttemptAt.toISOString(),
    deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
    createdAt: delivery.createdAt.toISOString(),
  };
}

export function createWebhookService(
  prisma: PrismaClient = getPrismaClient(),
  deliveryDeps: WebhookDeliveryDependencies = {},
) {
  async function requireWebhook(
    workspaceId: string,
    webhookId: string,
  ): Promise<WebhookSubscription> {
    const subscription = await prisma.webhookSubscription.findFirst({
      where: { id: webhookId, workspaceId },
    });
    if (!subscription) {
      throw new AppError(404, 'WEBHOOK_NOT_FOUND', 'That webhook subscription does not exist');
    }
    return subscription;
  }

  return {
    async create(
      input: Input & {
        url: string;
        events: string[];
        description?: string | null;
        enabled?: boolean;
        secret?: string;
      },
    ) {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.UpdateWorkspace,
             context: (input as { context: WorkspaceAccessContext }).context,
      });

      const secret = input.secret ?? randomBytes(32).toString('hex');
      const subscription = await prisma.$transaction(async (tx) => {
        const created = await tx.webhookSubscription.create({
          data: {
            workspaceId: input.workspaceId,
            createdById: input.userId,
            url: input.url,
            secretCiphertext: encryptIntegrationToken(secret),
            events: input.events,
            description: input.description ?? null,
            enabled: input.enabled ?? true,
          },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'webhook.created',
          targetType: 'WebhookSubscription',
          targetId: created.id,
          metadata: { url: created.url, events: created.events },
        });
        return created;
      });

      // The plaintext secret is returned once so the receiver can verify signatures.
      return { ...summary(subscription), secret };
    },

    async list(input: Input) {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
             context: (input as { context: WorkspaceAccessContext }).context,
      });
      const rows = await prisma.webhookSubscription.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(summary);
    },

    async update(
      input: Input & {
        webhookId: string;
        url?: string;
        events?: string[];
        description?: string | null;
        enabled?: boolean;
        secret?: string;
      },
    ) {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.UpdateWorkspace,
             context: (input as { context: WorkspaceAccessContext }).context,
      });
      const existing = await requireWebhook(input.workspaceId, input.webhookId);

      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.webhookSubscription.update({
          where: { id: existing.id },
          data: {
            ...(input.url !== undefined ? { url: input.url } : {}),
            ...(input.events !== undefined ? { events: input.events } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(input.secret !== undefined
              ? { secretCiphertext: encryptIntegrationToken(input.secret) }
              : {}),
          },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'webhook.updated',
          targetType: 'WebhookSubscription',
          targetId: row.id,
          metadata: {
            url: row.url,
            events: row.events,
            enabled: row.enabled,
            secretRotated: input.secret !== undefined,
          },
        });
        return row;
      });

      return input.secret ? { ...summary(updated), secret: input.secret } : summary(updated);
    },

    async delete(input: Input & { webhookId: string }) {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.UpdateWorkspace,
             context: (input as { context: WorkspaceAccessContext }).context,
      });
      const existing = await requireWebhook(input.workspaceId, input.webhookId);
      await prisma.$transaction(async (tx) => {
        await tx.webhookSubscription.delete({ where: { id: existing.id } });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'webhook.deleted',
          targetType: 'WebhookSubscription',
          targetId: existing.id,
          metadata: { url: existing.url },
        });
      });
    },

    async listDeliveries(input: Input & { webhookId: string; limit?: number }) {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
             context: (input as { context: WorkspaceAccessContext }).context,
      });
      const subscription = await requireWebhook(input.workspaceId, input.webhookId);
      const rows = await prisma.webhookDelivery.findMany({
        where: { subscriptionId: subscription.id },
        orderBy: { createdAt: 'desc' },
        take: Math.min(100, Math.max(1, input.limit ?? 25)),
      });
      return rows.map(deliverySummary);
    },

    async retryDelivery(input: Input & { webhookId: string; deliveryId: string }) {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.UpdateWorkspace,
             context: (input as { context: WorkspaceAccessContext }).context,
      });
      const subscription = await requireWebhook(input.workspaceId, input.webhookId);
      const delivery = await prisma.webhookDelivery.findFirst({
        where: { id: input.deliveryId, subscriptionId: subscription.id },
      });
      if (!delivery)
        throw new AppError(404, 'WEBHOOK_DELIVERY_NOT_FOUND', 'That delivery does not exist');
      if (delivery.status === 'RUNNING') {
        throw new AppError(409, 'WEBHOOK_DELIVERY_RUNNING', 'The delivery is already running');
      }
      const updated = await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'PENDING',
          attempts: 0,
          lastError: null,
          responseStatus: null,
          deliveredAt: null,
          nextAttemptAt: new Date(),
        },
      });
      await recordAuditEvent(prisma, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'webhook.delivery_retried',
        targetType: 'WebhookDelivery',
        targetId: updated.id,
        metadata: { subscriptionId: subscription.id },
      });
      return deliverySummary(updated);
    },

    /**
     * Queue one delivery per enabled subscription that listens for the event.
     * A subscription may listen to `*` to receive every workspace event.
     */
    async enqueueEvent(input: {
      workspaceId: string;
      event: string;
      payload: Record<string, unknown>;
    }): Promise<number> {
      const subscriptions = await prisma.webhookSubscription.findMany({
        where: {
          workspaceId: input.workspaceId,
          enabled: true,
          OR: [{ events: { has: input.event } }, { events: { has: '*' } }],
        },
        select: { id: true },
      });
      if (subscriptions.length === 0) return 0;
      const result = await prisma.webhookDelivery.createMany({
        data: subscriptions.map((subscription) => ({
          subscriptionId: subscription.id,
          event: input.event,
          payload: input.payload as Prisma.InputJsonValue,
        })),
      });
      return result.count;
    },

    async processDeliveries(
      options: WebhookDeliveryDependencies & { limit?: number } = {},
    ): Promise<ProcessWebhookDeliveriesResult> {
      const now = (options.now ?? deliveryDeps.now ?? (() => new Date()))();
      const limit = options.limit ?? DELIVERY_BATCH_SIZE;
      const fetchImpl = options.fetchImpl ?? deliveryDeps.fetchImpl ?? fetch;
      const resolve =
        options.resolveWebhookUrl ?? deliveryDeps.resolveWebhookUrl ?? assertSafeWebhookUrl;

      await prisma.webhookDelivery.updateMany({
        where: {
          status: 'RUNNING',
          createdAt: { lt: new Date(now.getTime() - STALE_DELIVERY_RUNNING_MS) },
        },
        data: {
          status: 'FAILED',
          lastError: 'Delivery did not finish before the stale-run timeout',
        },
      });

      const claimed = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "WebhookDelivery"
          WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${now}
          ORDER BY "nextAttemptAt" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        `;
        const ids = rows.map((row) => row.id);
        if (ids.length === 0) return [];
        await tx.webhookDelivery.updateMany({
          where: { id: { in: ids } },
          data: { status: 'RUNNING' },
        });
        return tx.webhookDelivery.findMany({
          where: { id: { in: ids } },
          include: { subscription: true },
        });
      });

      const result: ProcessWebhookDeliveriesResult = {
        claimed: claimed.length,
        succeeded: 0,
        retried: 0,
        failed: 0,
      };

      for (const delivery of claimed) {
        const subscription = delivery.subscription;
        if (!subscription.enabled) {
          await prisma.webhookDelivery.updateMany({
            where: { id: delivery.id, status: 'RUNNING' },
            data: {
              status: 'FAILED',
              attempts: delivery.attempts + 1,
              lastError: 'The subscription is disabled',
            },
          });
          result.failed += 1;
          continue;
        }

        try {
          const url = await resolve(subscription.url);
          const secret = decryptIntegrationToken(subscription.secretCiphertext);
          const body = JSON.stringify({
            id: delivery.id,
            event: delivery.event,
            workspaceId: subscription.workspaceId,
            createdAt: delivery.createdAt.toISOString(),
            data: delivery.payload,
          });
          const signature = createHmac('sha256', secret).update(body).digest('hex');

          const response = await fetchImpl(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'user-agent': 'Nexus-Webhooks/1.0',
              'x-nexus-event': delivery.event,
              'x-nexus-delivery': delivery.id,
              'x-nexus-signature': `sha256=${signature}`,
            },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
          });

          if (!response.ok) {
            throw new Error(`The webhook responded with HTTP ${response.status}`);
          }

          await prisma.$transaction(async (tx) => {
            await tx.webhookDelivery.updateMany({
              where: { id: delivery.id, status: 'RUNNING' },
              data: {
                status: 'SUCCEEDED',
                attempts: delivery.attempts + 1,
                responseStatus: response.status,
                deliveredAt: now,
                lastError: null,
              },
            });
            await tx.webhookSubscription.update({
              where: { id: subscription.id },
              data: { lastDeliveryAt: now, lastError: null },
            });
          });
          result.succeeded += 1;
        } catch (error) {
          const attempts = delivery.attempts + 1;
          const message =
            error instanceof Error ? error.message.slice(0, 500) : 'The delivery failed';
          if (attempts >= Math.max(1, delivery.maxRetries)) {
            await prisma.$transaction(async (tx) => {
              await tx.webhookDelivery.updateMany({
                where: { id: delivery.id, status: 'RUNNING' },
                data: { status: 'FAILED', attempts, lastError: message },
              });
              await tx.webhookSubscription.update({
                where: { id: subscription.id },
                data: { lastError: message },
              });
            });
            result.failed += 1;
          } else {
            await prisma.webhookDelivery.updateMany({
              where: { id: delivery.id, status: 'RUNNING' },
              data: {
                status: 'PENDING',
                attempts,
                lastError: message,
                nextAttemptAt: new Date(now.getTime() + backoffFor(attempts)),
              },
            });
            result.retried += 1;
          }
          logger.warn('webhook_delivery_failed', {
            deliveryId: delivery.id,
            subscriptionId: subscription.id,
            attempts,
            error: message,
          });
        }
      }

      return result;
    },
  };
}

export type WebhookService = ReturnType<typeof createWebhookService>;
