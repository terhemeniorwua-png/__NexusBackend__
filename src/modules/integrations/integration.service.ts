import type { IntegrationProvider, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import { encryptIntegrationToken } from './token-crypto';

// Access and refresh tokens are encrypted with AES-256-GCM (token-crypto.ts) before
// storage. INTEGRATION_ENCRYPTION_KEY must be set or connect() fails with 503.

type Input = { userId: string };

export function createIntegrationService(prisma: PrismaClient = getPrismaClient()) {
  const encryptToken = encryptIntegrationToken;

  return {
    async connect(input: Input & {
      provider: IntegrationProvider; workspaceId?: string | null;
      accessToken: string; refreshToken?: string | null;
      tokenExpiresAt?: string | null; scopes?: string[];
      externalUserId?: string | null; externalEmail?: string | null;
    }) {
      if (input.workspaceId) {
        // Slack is a workspace-level connection, so it needs the same role the authorize step required.
        const capability = input.provider === 'SLACK' ? WorkspaceCapability.UpdateWorkspace : WorkspaceCapability.ViewWorkspace;
        await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability });
      }

      const accessTokenCiphertext = encryptToken(input.accessToken);
      const refreshTokenCiphertext = input.refreshToken ? encryptToken(input.refreshToken) : null;

      const integration = await prisma.$transaction(async (tx) => {
        const created = await tx.integration.upsert({
          where: {
            userId_provider_workspaceId: {
              userId: input.userId,
              provider: input.provider,
              workspaceId: input.workspaceId ?? '',
            },
          },
          create: {
            userId: input.userId, workspaceId: input.workspaceId ?? null,
            provider: input.provider, status: 'ACTIVE',
            accessTokenCiphertext, refreshTokenCiphertext,
            tokenExpiresAt: input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null,
            scopes: input.scopes ?? [],
            externalUserId: input.externalUserId ?? null,
            externalEmail: input.externalEmail ?? null,
          },
          update: {
            status: 'ACTIVE', accessTokenCiphertext, refreshTokenCiphertext,
            tokenExpiresAt: input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null,
            scopes: input.scopes ?? [],
            externalUserId: input.externalUserId ?? null,
            externalEmail: input.externalEmail ?? null,
          },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId, actorId: input.userId,
          action: 'integration.connected', targetType: 'Integration', targetId: created.id,
          metadata: { provider: input.provider, workspaceId: input.workspaceId ?? null },
        });
        return created;
      });

      return {
        id: integration.id, provider: integration.provider,
        status: integration.status, workspaceId: integration.workspaceId,
        externalEmail: integration.externalEmail, scopes: integration.scopes,
        createdAt: integration.createdAt.toISOString(),
      };
    },

    async disconnect(input: Input & { integrationId: string }) {
      const integration = await prisma.integration.findFirst({
        where: { id: input.integrationId, userId: input.userId },
      });
      if (!integration) throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'That integration does not exist');

      await prisma.$transaction(async (tx) => {
        await tx.integration.update({ where: { id: integration.id }, data: { status: 'DISCONNECTED' } });
        await recordAuditEvent(tx, {
          workspaceId: integration.workspaceId, actorId: input.userId,
          action: 'integration.disconnected', targetType: 'Integration', targetId: integration.id,
          metadata: { provider: integration.provider },
        });
      });
    },

    async list(input: Input & { workspaceId?: string }) {
      if (input.workspaceId) {
        await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.ViewWorkspace });
      }

      const integrations = await prisma.integration.findMany({
        where: {
          userId: input.userId,
          ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
        },
        orderBy: [{ provider: 'asc' }, { createdAt: 'desc' }],
      });

      return integrations.map((i) => ({
        id: i.id, provider: i.provider, status: i.status,
        workspaceId: i.workspaceId, externalEmail: i.externalEmail,
        scopes: i.scopes, createdAt: i.createdAt.toISOString(),
      }));
    },
  };
}

export type IntegrationService = ReturnType<typeof createIntegrationService>;
