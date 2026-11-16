import type { PrismaClient } from '@prisma/client';

/**
 * Durable queue depth for background processing.
 *
 * Each background worker claims rows from a PostgreSQL-backed queue with
 * `FOR UPDATE SKIP LOCKED`. The counts below make a backlog or a set of
 * exhausted jobs observable without exposing queue payloads.
 */

export interface QueueStatus {
  name: string;
  /** Durable jobs waiting for a worker pass. */
  pending: number;
  /** Jobs that exhausted their retries and need inspection. */
  failed: number;
}

export type QueueStatusProbe = () => Promise<QueueStatus[]>;

export interface QueueStatusPrisma {
  emailDelivery: Pick<PrismaClient['emailDelivery'], 'count'>;
  webhookDelivery: Pick<PrismaClient['webhookDelivery'], 'count'>;
  automationRun: Pick<PrismaClient['automationRun'], 'count'>;
  integrationSyncJob: Pick<PrismaClient['integrationSyncJob'], 'count'>;
}

export function createQueueStatusProbe(prisma: QueueStatusPrisma): QueueStatusProbe {
  return async () => {
    const [
      emailPending,
      emailFailed,
      webhookPending,
      webhookFailed,
      automationPending,
      automationFailed,
      integrationPending,
      integrationFailed,
    ] = await Promise.all([
      prisma.emailDelivery.count({ where: { status: { in: ['QUEUED', 'SENDING'] } } }),
      prisma.emailDelivery.count({ where: { status: 'FAILED' } }),
      prisma.webhookDelivery.count({ where: { status: { in: ['PENDING', 'RUNNING'] } } }),
      prisma.webhookDelivery.count({ where: { status: 'FAILED' } }),
      prisma.automationRun.count({ where: { status: { in: ['PENDING', 'RUNNING'] } } }),
      prisma.automationRun.count({ where: { status: 'FAILED' } }),
      prisma.integrationSyncJob.count({ where: { status: { in: ['PENDING', 'RUNNING'] } } }),
      prisma.integrationSyncJob.count({ where: { status: 'FAILED' } }),
    ]);

    return [
      { name: 'email', pending: emailPending, failed: emailFailed },
      { name: 'webhooks', pending: webhookPending, failed: webhookFailed },
      { name: 'automation', pending: automationPending, failed: automationFailed },
      { name: 'integration-sync', pending: integrationPending, failed: integrationFailed },
    ];
  };
}
