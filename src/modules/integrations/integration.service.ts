import type { Integration, IntegrationProvider, Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import { encryptIntegrationToken } from './token-crypto';

// Access and refresh tokens are encrypted with AES-256-GCM (token-crypto.ts) before
// storage. INTEGRATION_ENCRYPTION_KEY must be set or connect() fails with 503.
//
// Slack is a WORKSPACE-level connection: one active row per workspace, visible to every
// member, connectable and disconnectable by any OWNER / PROJECT_MANAGER (UpdateWorkspace).
// Every other provider stays personal to the user who connected it.

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
      const tokenData = {
        status: 'ACTIVE' as const,
        accessTokenCiphertext, refreshTokenCiphertext,
        tokenExpiresAt: input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null,
        scopes: input.scopes ?? [],
        externalUserId: input.externalUserId ?? null,
        externalEmail: input.externalEmail ?? null,
      };

      const connectWorkspaceSlack = async (tx: Prisma.TransactionClient, workspaceId: string): Promise<Integration> => {
        const existing =
          (await tx.integration.findFirst({ where: { provider: 'SLACK', workspaceId, userId: input.userId } })) ??
          (await tx.integration.findFirst({ where: { provider: 'SLACK', workspaceId }, orderBy: { createdAt: 'desc' } }));
        const row = existing
          ? await tx.integration.update({ where: { id: existing.id }, data: { ...tokenData, userId: input.userId } })
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
              data: { userId: input.userId, workspaceId: null, provider: input.provider, ...tokenData },
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
                  userId: input.userId, workspaceId: input.workspaceId ?? null,
                  provider: input.provider, ...tokenData,
                },
                update: { ...tokenData },
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
      const integration = await prisma.integration.findUnique({ where: { id: input.integrationId } });
      if (!integration) throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'That integration does not exist');

      const workspaceLevel = integration.provider === 'SLACK' && integration.workspaceId !== null;
      if (workspaceLevel && integration.workspaceId) {
        // Any OWNER / PROJECT_MANAGER may disconnect, whoever connected it. Members get 403.
        await requireWorkspaceAccess(prisma, {
          userId: input.userId, workspaceId: integration.workspaceId,
          capability: WorkspaceCapability.UpdateWorkspace,
        });
      } else if (integration.userId !== input.userId) {
        throw new AppError(404, 'INTEGRATION_NOT_FOUND', 'That integration does not exist');
      }

      await prisma.$transaction(async (tx) => {
        if (workspaceLevel && integration.workspaceId) {
          await tx.integration.updateMany({
            where: { provider: 'SLACK', workspaceId: integration.workspaceId },
            data: { status: 'DISCONNECTED' },
          });
        } else {
          await tx.integration.update({ where: { id: integration.id }, data: { status: 'DISCONNECTED' } });
        }
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
        if (!current || (current.status !== 'ACTIVE' && i.status === 'ACTIVE')) bestSlack.set(key, i);
      }
      const visible = integrations.filter((i) => i.provider !== 'SLACK' || bestSlack.get(i.workspaceId ?? '') === i);

      return visible.map((i) => ({
        id: i.id, provider: i.provider, status: i.status,
        workspaceId: i.workspaceId, externalEmail: i.externalEmail,
        scopes: i.scopes, createdAt: i.createdAt.toISOString(),
      }));
    },
  };
}

export type IntegrationService = ReturnType<typeof createIntegrationService>;
