import type { Integration, IntegrationProvider, Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import {
  createProviderLifecycle,
  toIntegrationError,
  type ProviderLifecycle,
} from './provider-lifecycle';
import { decryptIntegrationToken, encryptIntegrationToken } from './token-crypto';

// Access and refresh tokens are encrypted with AES-256-GCM (token-crypto.ts) before
// storage. INTEGRATION_ENCRYPTION_KEY must be set or connect() fails with 503.
//
// Slack is a WORKSPACE-level connection: one active row per workspace, visible to every
// member, connectable and disconnectable by any OWNER / PROJECT_MANAGER (UpdateWorkspace).
// Every other provider stays personal to the user who connected it.
//
// Phase 19 lifecycle:
// - `refresh` rotates an expiring access token through the provider adapter.
// - `setEnabled` lets the owner/manager pause an integration without deleting it.
// - `disconnect` revokes the provider token when possible, then marks the local
//   record DISCONNECTED. Provider-side data is never deleted.
// - `enqueueSync` / `processSyncJobs` provide a durable, retryable sync queue.

type Input = { userId: string };

const SYNC_BATCH_SIZE = 10;
const STALE_SYNC_RUNNING_MS = 5 * 60_000;
const MIN_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const REFRESH_WINDOW_MS = 5 * 60_000;

export interface ProcessSyncJobsResult {
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
}

function backoffFor(attempts: number): number {
  const delay = MIN_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, MAX_BACKOFF_MS);
}

function summary(integration: Integration) {
  return {
    id: integration.id,
    provider: integration.provider,
    status: integration.status,
    enabled: integration.enabled,
    workspaceId: integration.workspaceId,
    externalEmail: integration.externalEmail,
    scopes: integration.scopes,
    lastError: integration.lastError,
    lastRefreshedAt: integration.lastRefreshedAt?.toISOString() ?? null,
    lastSyncedAt: integration.lastSyncedAt?.toISOString() ?? null,
    createdAt: integration.createdAt.toISOString(),
  };
}

function jobSummary(job: {
  id: string;
  integrationId: string;
  status: string;
  attempts: number;
  maxRetries: number;
  lastError: string | null;
  nextAttemptAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: job.id,
    integrationId: job.integrationId,
    status: job.status,
    attempts: job.attempts,
    maxRetries: job.maxRetries,
    lastError: job.lastError,
    nextAttemptAt: job.nextAttemptAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
  };
}

export function createIntegrationService(
  prisma: PrismaClient = getPrismaClient(),
  lifecycle: ProviderLifecycle = createProviderLifecycle(),
) {
  const encryptToken = encryptIntegrationToken;

  async function requireManage(userId: string, integration: Integration): Promise<void> {
    if (integration.workspaceId) {
      await requireWorkspaceAccess(prisma, {
        userId,
        workspaceId: integration.workspaceId,
        capability: WorkspaceCapability.UpdateWorkspace,
      });
      return;
    }
    if (integration.userId !== userId) {
      throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'That integration does not exist');
    }
  }

  async function findForCaller(userId: string, integrationId: string): Promise<Integration> {
    const integration = await prisma.integration.findUnique({ where: { id: integrationId } });
    if (!integration)
      throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'That integration does not exist');
    await requireManage(userId, integration);
    return integration;
  }

  async function markError(integration: Integration, error: unknown): Promise<AppError> {
    const appError = toIntegrationError(error);
    await prisma.integration.update({
      where: { id: integration.id },
      data: { status: 'ERROR', lastError: appError.message.slice(0, 500) },
    });
    return appError;
  }

  /**
   * Refresh the access token when the provider supports it. Returns the updated
   * row. This is also used by the sync worker, so it never trusts a client
   * supplied token.
   */
  async function refreshIntegration(integration: Integration): Promise<Integration> {
    if (integration.status === 'DISCONNECTED') {
      throw new AppError(
        409,
        'INTEGRATION_DISCONNECTED',
        'Reconnect the integration before refreshing it',
      );
    }
    if (!integration.refreshTokenCiphertext) {
      throw new AppError(
        400,
        'INTEGRATION_NO_REFRESH_TOKEN',
        'This integration has no refresh token',
      );
    }

    const refreshToken = decryptIntegrationToken(integration.refreshTokenCiphertext);
    const refreshed = await lifecycle.refresh(integration.provider, refreshToken);
    if (!refreshed) {
      throw new AppError(
        400,
        'INTEGRATION_REFRESH_UNSUPPORTED',
        'This provider does not expose a token refresh flow',
      );
    }

    return prisma.integration.update({
      where: { id: integration.id },
      data: {
        accessTokenCiphertext: encryptToken(refreshed.accessToken),
        ...(refreshed.refreshToken
          ? { refreshTokenCiphertext: encryptToken(refreshed.refreshToken) }
          : {}),
        tokenExpiresAt: refreshed.tokenExpiresAt ? new Date(refreshed.tokenExpiresAt) : null,
        status: 'ACTIVE',
        lastError: null,
        lastRefreshedAt: new Date(),
      },
    });
  }

  return {
    async connect(
      input: Input & {
        provider: IntegrationProvider;
        workspaceId?: string | null;
        accessToken: string;
        refreshToken?: string | null;
        tokenExpiresAt?: string | null;
        scopes?: string[];
        externalUserId?: string | null;
        externalEmail?: string | null;
      },
    ) {
      if (input.workspaceId) {
        // Slack is a workspace-level connection, so it needs the same role the authorize step required.
        const capability =
          input.provider === 'SLACK'
            ? WorkspaceCapability.UpdateWorkspace
            : WorkspaceCapability.ViewWorkspace;
        await requireWorkspaceAccess(prisma, {
          userId: input.userId,
          workspaceId: input.workspaceId,
          capability,
        });
      }

      const accessTokenCiphertext = encryptToken(input.accessToken);
      const refreshTokenCiphertext = input.refreshToken ? encryptToken(input.refreshToken) : null;
      const tokenData = {
        status: 'ACTIVE' as const,
        enabled: true,
        accessTokenCiphertext,
        refreshTokenCiphertext,
        tokenExpiresAt: input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null,
        scopes: input.scopes ?? [],
        externalUserId: input.externalUserId ?? null,
        externalEmail: input.externalEmail ?? null,
        lastError: null,
        revokedAt: null,
      };

      const connectWorkspaceSlack = async (
        tx: Prisma.TransactionClient,
        workspaceId: string,
      ): Promise<Integration> => {
        const existing =
          (await tx.integration.findFirst({
            where: { provider: 'SLACK', workspaceId, userId: input.userId },
          })) ??
          (await tx.integration.findFirst({
            where: { provider: 'SLACK', workspaceId },
            orderBy: { createdAt: 'desc' },
          }));
        const row = existing
          ? await tx.integration.update({
              where: { id: existing.id },
              data: { ...tokenData, userId: input.userId },
            })
          : await tx.integration.create({
              data: { userId: input.userId, workspaceId, provider: 'SLACK', ...tokenData },
            });
        // One active Slack connection per workspace.
        await tx.integration.updateMany({
          where: { provider: 'SLACK', workspaceId, id: { not: row.id }, status: 'ACTIVE' },
          data: { status: 'DISCONNECTED' },
        });
        return row;
      };

      const connectPersonal = async (tx: Prisma.TransactionClient): Promise<Integration> => {
        const existing = await tx.integration.findFirst({
          where: { userId: input.userId, provider: input.provider, workspaceId: null },
          orderBy: { createdAt: 'desc' },
        });
        return existing
          ? tx.integration.update({ where: { id: existing.id }, data: tokenData })
          : tx.integration.create({
              data: {
                userId: input.userId,
                workspaceId: null,
                provider: input.provider,
                ...tokenData,
              },
            });
      };

      const integration = await prisma.$transaction(async (tx) => {
        const created =
          input.provider === 'SLACK' && input.workspaceId
            ? await connectWorkspaceSlack(tx, input.workspaceId)
            : !input.workspaceId
              ? await connectPersonal(tx)
              : await tx.integration.upsert({
                  where: {
                    userId_provider_workspaceId: {
                      userId: input.userId,
                      provider: input.provider,
                      workspaceId: input.workspaceId ?? '',
                    },
                  },
                  create: {
                    userId: input.userId,
                    workspaceId: input.workspaceId ?? null,
                    provider: input.provider,
                    ...tokenData,
                  },
                  update: { ...tokenData },
                });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'integration.connected',
          targetType: 'Integration',
          targetId: created.id,
          metadata: { provider: input.provider, workspaceId: input.workspaceId ?? null },
        });
        return created;
      });

      return summary(integration);
    },

    async disconnect(input: Input & { integrationId: string }) {
      const integration = await prisma.integration.findUnique({
        where: { id: input.integrationId },
      });
      if (!integration)
        throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'That integration does not exist');

      const workspaceLevel = integration.provider === 'SLACK' && integration.workspaceId !== null;
      if (workspaceLevel && integration.workspaceId) {
        // Any OWNER / PROJECT_MANAGER may disconnect, whoever connected it. Members get 403.
        await requireWorkspaceAccess(prisma, {
          userId: input.userId,
          workspaceId: integration.workspaceId,
          capability: WorkspaceCapability.UpdateWorkspace,
        });
      } else if (integration.userId !== input.userId) {
        throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'That integration does not exist');
      }

      // Revocation is best effort. A provider outage or an already-revoked
      // token must not prevent the local record from being disconnected.
      let revocation: { revoked: boolean; detail?: string } = {
        revoked: false,
        detail: 'No access token was available for revocation',
      };
      try {
        const accessToken = decryptIntegrationToken(integration.accessTokenCiphertext);
        revocation = await lifecycle.revoke(integration.provider, accessToken);
      } catch (error) {
        logger.warn('integration_revocation_failed', {
          integrationId: integration.id,
          provider: integration.provider,
          error,
        });
      }

      await prisma.$transaction(async (tx) => {
        const revokedAt = revocation.revoked ? new Date() : null;
        if (workspaceLevel && integration.workspaceId) {
          await tx.integration.updateMany({
            where: { provider: 'SLACK', workspaceId: integration.workspaceId },
            data: {
              status: 'DISCONNECTED',
              enabled: false,
              lastError: revocation.revoked ? null : (revocation.detail?.slice(0, 500) ?? null),
              ...(revokedAt ? { revokedAt } : {}),
            },
          });
        } else {
          await tx.integration.update({
            where: { id: integration.id },
            data: {
              status: 'DISCONNECTED',
              enabled: false,
              lastError: revocation.revoked ? null : (revocation.detail?.slice(0, 500) ?? null),
              ...(revokedAt ? { revokedAt } : {}),
            },
          });
        }
        await recordAuditEvent(tx, {
          workspaceId: integration.workspaceId,
          actorId: input.userId,
          action: 'integration.disconnected',
          targetType: 'Integration',
          targetId: integration.id,
          metadata: {
            provider: integration.provider,
            providerRevoked: revocation.revoked,
            revocationDetail: revocation.detail ?? null,
          },
        });
      });

      return { ok: true, providerRevoked: revocation.revoked };
    },

    async list(input: Input & { workspaceId?: string }) {
      if (input.workspaceId) {
        await requireWorkspaceAccess(prisma, {
          userId: input.userId,
          workspaceId: input.workspaceId,
          capability: WorkspaceCapability.ViewWorkspace,
        });
      }

      const integrations = await prisma.integration.findMany({
        where: {
          status: { not: 'DISCONNECTED' },
          ...(input.workspaceId
            ? {
                OR: [
                  { workspaceId: input.workspaceId, userId: input.userId },
                  { workspaceId: input.workspaceId, provider: 'SLACK' as const },
                  { workspaceId: null, userId: input.userId },
                ],
              }
            : { userId: input.userId }),
        },
        orderBy: [{ provider: 'asc' }, { createdAt: 'desc' }],
      });

      // One Slack row per workspace (prefer the ACTIVE one), even if older data has duplicates.
      const bestSlack = new Map<string, (typeof integrations)[number]>();
      for (const i of integrations) {
        if (i.provider !== 'SLACK') continue;
        const key = i.workspaceId ?? '';
        const current = bestSlack.get(key);
        if (!current || (current.status !== 'ACTIVE' && i.status === 'ACTIVE'))
          bestSlack.set(key, i);
      }
      const visible = integrations.filter(
        (i) => i.provider !== 'SLACK' || bestSlack.get(i.workspaceId ?? '') === i,
      );

      return visible.map(summary);
    },

    async refresh(input: Input & { integrationId: string }) {
      const integration = await findForCaller(input.userId, input.integrationId);
      try {
        const updated = await refreshIntegration(integration);
        await recordAuditEvent(prisma, {
          workspaceId: updated.workspaceId,
          actorId: input.userId,
          action: 'integration.refreshed',
          targetType: 'Integration',
          targetId: updated.id,
          metadata: { provider: updated.provider },
        });
        return summary(updated);
      } catch (error) {
        const appError = await markError(integration, error);
        await recordAuditEvent(prisma, {
          workspaceId: integration.workspaceId,
          actorId: input.userId,
          action: 'integration.refresh_failed',
          targetType: 'Integration',
          targetId: integration.id,
          metadata: { provider: integration.provider, error: appError.message.slice(0, 300) },
        });
        throw appError;
      }
    },

    async setEnabled(input: Input & { integrationId: string; enabled: boolean }) {
      const integration = await findForCaller(input.userId, input.integrationId);
      if (input.enabled && integration.status === 'DISCONNECTED') {
        throw new AppError(
          409,
          'INTEGRATION_DISCONNECTED',
          'Reconnect the integration before enabling it',
        );
      }
      const updated = await prisma.integration.update({
        where: { id: integration.id },
        data: { enabled: input.enabled },
      });
      await recordAuditEvent(prisma, {
        workspaceId: updated.workspaceId,
        actorId: input.userId,
        action: input.enabled ? 'integration.enabled' : 'integration.disabled',
        targetType: 'Integration',
        targetId: updated.id,
        metadata: { provider: updated.provider },
      });
      return summary(updated);
    },

    async enqueueSync(input: Input & { integrationId: string }) {
      const integration = await findForCaller(input.userId, input.integrationId);
      if (integration.status === 'DISCONNECTED') {
        throw new AppError(
          409,
          'INTEGRATION_DISCONNECTED',
          'Reconnect the integration before syncing it',
        );
      }
      if (!integration.enabled) {
        throw new AppError(409, 'INTEGRATION_DISABLED', 'Enable the integration before syncing it');
      }
      const job = await prisma.integrationSyncJob.create({
        data: { integrationId: integration.id },
      });
      await recordAuditEvent(prisma, {
        workspaceId: integration.workspaceId,
        actorId: input.userId,
        action: 'integration.sync_queued',
        targetType: 'IntegrationSyncJob',
        targetId: job.id,
        metadata: { integrationId: integration.id, provider: integration.provider },
      });
      return jobSummary(job);
    },

    async listSyncJobs(input: Input & { integrationId: string; limit?: number }) {
      const integration = await findForCaller(input.userId, input.integrationId);
      const jobs = await prisma.integrationSyncJob.findMany({
        where: { integrationId: integration.id },
        orderBy: { createdAt: 'desc' },
        take: Math.min(100, Math.max(1, input.limit ?? 25)),
      });
      return jobs.map(jobSummary);
    },

    async retrySyncJob(input: Input & { integrationId: string; jobId: string }) {
      const integration = await findForCaller(input.userId, input.integrationId);
      const job = await prisma.integrationSyncJob.findFirst({
        where: { id: input.jobId, integrationId: integration.id },
      });
      if (!job) throw new AppError(404, 'SYNC_JOB_NOT_FOUND', 'That sync job does not exist');
      if (job.status === 'RUNNING') {
        throw new AppError(409, 'SYNC_JOB_RUNNING', 'The sync job is already running');
      }
      const updated = await prisma.integrationSyncJob.update({
        where: { id: job.id },
        data: {
          status: 'PENDING',
          attempts: 0,
          lastError: null,
          startedAt: null,
          completedAt: null,
          nextAttemptAt: new Date(),
        },
      });
      await recordAuditEvent(prisma, {
        workspaceId: integration.workspaceId,
        actorId: input.userId,
        action: 'integration.sync_retried',
        targetType: 'IntegrationSyncJob',
        targetId: updated.id,
        metadata: { integrationId: integration.id },
      });
      return jobSummary(updated);
    },

    /**
     * Claim and process due sync jobs. The claim uses `FOR UPDATE SKIP LOCKED`,
     * so several API instances can run the worker safely. A provider failure
     * is retried with bounded exponential backoff and then recorded on both the
     * job and the integration.
     */
    async processSyncJobs(
      options: { limit?: number; now?: Date } = {},
    ): Promise<ProcessSyncJobsResult> {
      const now = options.now ?? new Date();
      const limit = options.limit ?? SYNC_BATCH_SIZE;

      await prisma.integrationSyncJob.updateMany({
        where: {
          status: 'RUNNING',
          startedAt: { lt: new Date(now.getTime() - STALE_SYNC_RUNNING_MS) },
        },
        data: {
          status: 'FAILED',
          completedAt: now,
          lastError: 'Sync did not finish before the stale-run timeout',
        },
      });

      const claimed = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "IntegrationSyncJob"
          WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${now}
          ORDER BY "nextAttemptAt" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        `;
        const ids = rows.map((row) => row.id);
        if (ids.length === 0) return [];
        await tx.integrationSyncJob.updateMany({
          where: { id: { in: ids } },
          data: { status: 'RUNNING', startedAt: now },
        });
        return tx.integrationSyncJob.findMany({
          where: { id: { in: ids } },
          include: { integration: true },
        });
      });

      const result: ProcessSyncJobsResult = {
        claimed: claimed.length,
        succeeded: 0,
        retried: 0,
        failed: 0,
      };

      for (const job of claimed) {
        const integration = job.integration;
        if (integration.status === 'DISCONNECTED' || !integration.enabled) {
          await prisma.integrationSyncJob.updateMany({
            where: { id: job.id, status: 'RUNNING' },
            data: {
              status: 'FAILED',
              completedAt: now,
              attempts: job.attempts + 1,
              lastError: 'The integration is disabled or disconnected',
            },
          });
          result.failed += 1;
          continue;
        }

        try {
          let current = integration;
          const expiresSoon =
            current.tokenExpiresAt !== null &&
            current.tokenExpiresAt.getTime() - now.getTime() <= REFRESH_WINDOW_MS;
          if (expiresSoon && current.refreshTokenCiphertext) {
            current = await refreshIntegration(current);
          }
          await prisma.integration.update({
            where: { id: current.id },
            data: { lastSyncedAt: now, status: 'ACTIVE', lastError: null },
          });
          await prisma.integrationSyncJob.updateMany({
            where: { id: job.id, status: 'RUNNING' },
            data: {
              status: 'SUCCEEDED',
              completedAt: now,
              attempts: job.attempts + 1,
              lastError: null,
            },
          });
          result.succeeded += 1;
        } catch (error) {
          const attempts = job.attempts + 1;
          const message = error instanceof Error ? error.message.slice(0, 500) : 'The sync failed';
          if (attempts >= Math.max(1, job.maxRetries)) {
            await prisma.integrationSyncJob.updateMany({
              where: { id: job.id, status: 'RUNNING' },
              data: { status: 'FAILED', completedAt: now, attempts, lastError: message },
            });
            await prisma.integration.update({
              where: { id: integration.id },
              data: { status: 'ERROR', lastError: message },
            });
            result.failed += 1;
          } else {
            await prisma.integrationSyncJob.updateMany({
              where: { id: job.id, status: 'RUNNING' },
              data: {
                status: 'PENDING',
                attempts,
                lastError: message,
                nextAttemptAt: new Date(now.getTime() + backoffFor(attempts)),
              },
            });
            result.retried += 1;
          }
          logger.warn('integration_sync_failed', {
            integrationId: integration.id,
            jobId: job.id,
            attempts,
            error: message,
          });
        }
      }

      return result;
    },
  };
}

export type IntegrationService = ReturnType<typeof createIntegrationService>;
