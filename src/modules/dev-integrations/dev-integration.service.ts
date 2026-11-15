import type { DevIntegrationProvider, Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { ProjectPermission, authorizeProject, requireWorkspaceAccess, WorkspaceCapability } from '../authorization';
import type { AppConfig } from '../../config/env';
import { githubAppProvider } from './providers/github-app.provider';
import type { DevIntegrationProviderAdapter } from './provider.interface';
import type { DevConnectionSummary, DevRepositorySummary, LinkedProjectRepository } from './dev-integration.types';

function providerFor(_provider: DevIntegrationProvider): DevIntegrationProviderAdapter {
  // Feature A: GitHub only. GitLab will be added behind the same interface.
  return githubAppProvider;
}

function toConnectionSummary(row: {
  id: string;
  provider: DevIntegrationProvider;
  workspaceId: string;
  status: any;
  externalAccountId: string | null;
  externalAccountLogin: string | null;
  externalAccountName: string | null;
  scopes: string[];
  createdById: string;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): DevConnectionSummary {
  return {
    id: row.id,
    provider: row.provider,
    workspaceId: row.workspaceId,
    status: row.status,
    externalAccount: {
      id: row.externalAccountId,
      login: row.externalAccountLogin,
      name: row.externalAccountName,
    },
    scopes: row.scopes,
    createdById: row.createdById,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toLinkedRepo(row: {
  id: string;
  projectId: string;
  connectionId: string;
  provider: DevIntegrationProvider;
  externalRepoId: string;
  fullName: string;
  defaultBranch: string | null;
  createdAt: Date;
  updatedAt: Date;
}): LinkedProjectRepository {
  return {
    id: row.id,
    projectId: row.projectId,
    connectionId: row.connectionId,
    provider: row.provider,
    externalRepoId: row.externalRepoId,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createDevIntegrationService(
  config: AppConfig,
  prisma: PrismaClient = getPrismaClient(),
) {
  async function requireWorkspaceManager(userId: string, workspaceId: string) {
    return requireWorkspaceAccess(prisma, {
      userId,
      workspaceId,
      capability: WorkspaceCapability.UpdateWorkspace,
    });
  }

  async function requireProjectRepoManager(userId: string, workspaceId: string, projectId: string) {
    const workspace = await requireWorkspaceAccess(prisma, {
      userId,
      workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });
    await authorizeProject(prisma, {
      actor: { userId, workspaceId, workspaceRole: workspace.effectiveRole },
      projectId,
      permission: ProjectPermission.Update,
    });
    return workspace;
  }

  async function requireProjectViewer(userId: string, workspaceId: string, projectId: string) {
    const workspace = await requireWorkspaceAccess(prisma, {
      userId,
      workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });
    await authorizeProject(prisma, {
      actor: { userId, workspaceId, workspaceRole: workspace.effectiveRole },
      projectId,
      permission: ProjectPermission.View,
    });
    return workspace;
  }

  return {
    async startGithubConnect(input: { userId: string; workspaceId: string }) {
      await requireWorkspaceManager(input.userId, input.workspaceId);
      const provider = providerFor('GITHUB');
      const result = await provider.startConnect({ config, userId: input.userId, workspaceId: input.workspaceId });
      await recordAuditEvent(prisma, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'dev_integration.connect_started',
        targetType: 'IntegrationConnection',
        targetId: input.workspaceId,
        metadata: { provider: 'GITHUB' },
      });
      return result;
    },

    async handleGithubCallback(input: { query: Record<string, unknown> }) {
      const provider = providerFor('GITHUB');
      const state = typeof input.query.state === 'string' ? input.query.state : '';
      if (!state) throw new AppError(400, 'GITHUB_STATE_INVALID', 'Missing GitHub authorization state');
      const claims = await provider.verifyAndConsumeState(state);
      await requireWorkspaceManager(claims.userId, claims.workspaceId);

      // If user cancelled/denied installation, GitHub may redirect with error params; caller handles redirect.
      const result = await provider.handleCallback({ config, query: input.query, claims });

      const connection = await prisma.integrationConnection.upsert({
        where: { workspaceId_provider: { workspaceId: claims.workspaceId, provider: 'GITHUB' } },
        create: {
          provider: 'GITHUB',
          workspaceId: claims.workspaceId,
          status: 'ACTIVE',
          externalAccountId: result.externalAccount.id,
          externalAccountLogin: result.externalAccount.login,
          externalAccountName: result.externalAccount.name,
          encryptedCredentials: result.encryptedCredentials,
          scopes: result.scopes,
          createdById: claims.userId,
          lastError: null,
          revokedAt: null,
        },
        update: {
          status: 'ACTIVE',
          externalAccountId: result.externalAccount.id,
          externalAccountLogin: result.externalAccount.login,
          externalAccountName: result.externalAccount.name,
          encryptedCredentials: result.encryptedCredentials,
          scopes: result.scopes,
          createdById: claims.userId,
          lastError: null,
          revokedAt: null,
        },
      });

      await recordAuditEvent(prisma, {
        workspaceId: claims.workspaceId,
        actorId: claims.userId,
        action: 'dev_integration.connected',
        targetType: 'IntegrationConnection',
        targetId: connection.id,
        metadata: { provider: 'GITHUB', externalAccountLogin: result.externalAccount.login },
      });

      return { connection: toConnectionSummary(connection), claims };
    },

    async listConnections(input: { userId: string; workspaceId: string }): Promise<DevConnectionSummary[]> {
      // Workspace members can see connection status (no secrets). Management actions are separately protected.
      await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const rows = await prisma.integrationConnection.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toConnectionSummary);
    },

    async disconnect(input: { userId: string; workspaceId: string; connectionId: string }) {
      await requireWorkspaceManager(input.userId, input.workspaceId);
      const connection = await prisma.integrationConnection.findFirst({
        where: { id: input.connectionId, workspaceId: input.workspaceId },
      });
      if (!connection) {
        throw new AppError(404, 'DEV_INTEGRATION_NOT_FOUND', 'Integration connection not found');
      }
      const provider = providerFor(connection.provider);
      let revoke: { revoked: boolean; detail?: string } = { revoked: false };
      try {
        revoke = await provider.disconnect({ config, encryptedCredentials: connection.encryptedCredentials });
      } catch (error) {
        logger.warn('dev_integration_disconnect_provider_failed', { error, connectionId: connection.id });
      }

      await prisma.$transaction(async (tx) => {
        await tx.integrationConnection.update({
          where: { id: connection.id },
          data: {
            status: 'DISCONNECTED',
            lastError: revoke.detail?.slice(0, 500) ?? null,
            revokedAt: new Date(),
            // Remove stored credentials by replacing with a minimal encrypted tombstone is not ideal;
            // better to overwrite with empty payload marker encrypted. But easier: keep column non-empty encrypted string.
            encryptedCredentials: connection.encryptedCredentials, // will be overwritten below if possible
          },
        });
        // Overwrite credentials with encrypted revoked marker
        const { encryptIntegrationToken } = await import('../integrations/token-crypto');
        const revokedMarker = encryptIntegrationToken(JSON.stringify({ revoked: true, at: new Date().toISOString() }));
        await tx.integrationConnection.update({
          where: { id: connection.id },
          data: { encryptedCredentials: revokedMarker },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'dev_integration.disconnected',
          targetType: 'IntegrationConnection',
          targetId: connection.id,
          metadata: { provider: connection.provider, ...revoke },
        });
      });

      return { ok: true, providerRevoked: revoke.revoked };
    },

    async listAvailableRepositories(input: {
      userId: string;
      workspaceId: string;
      connectionId: string;
    }): Promise<DevRepositorySummary[]> {
      // Any active workspace member can list available repos from an active workspace connection
      // (needed for project linking UI). Linking/unlinking remains project-permission gated.
      await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const connection = await prisma.integrationConnection.findFirst({
        where: { id: input.connectionId, workspaceId: input.workspaceId },
      });
      if (!connection) throw new AppError(404, 'DEV_INTEGRATION_NOT_FOUND', 'Integration connection not found');
      if (connection.status !== 'ACTIVE') {
        throw new AppError(409, 'DEV_INTEGRATION_NOT_ACTIVE', 'Integration connection is not active');
      }
      const provider = providerFor(connection.provider);
      try {
        const repos = await provider.listAvailableRepositories({
          config,
          encryptedCredentials: connection.encryptedCredentials,
        });
        return repos;
      } catch (error) {
        await prisma.integrationConnection.update({
          where: { id: connection.id },
          data: { status: 'ERROR', lastError: error instanceof Error ? error.message.slice(0, 500) : 'Failed to list repositories' },
        }).catch(() => undefined);
        throw error;
      }
    },

    async listProjectRepositories(input: { userId: string; workspaceId: string; projectId: string }): Promise<LinkedProjectRepository[]> {
      await requireProjectViewer(input.userId, input.workspaceId, input.projectId);
      const rows = await prisma.projectRepository.findMany({
        where: { projectId: input.projectId, project: { workspaceId: input.workspaceId } },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toLinkedRepo);
    },

    async linkRepository(input: {
      userId: string;
      workspaceId: string;
      projectId: string;
      connectionId: string;
      externalRepoId: string;
      fullName: string;
      defaultBranch?: string | null;
    }): Promise<LinkedProjectRepository> {
      await requireProjectRepoManager(input.userId, input.workspaceId, input.projectId);
      const connection = await prisma.integrationConnection.findFirst({
        where: { id: input.connectionId, workspaceId: input.workspaceId, provider: 'GITHUB', status: 'ACTIVE' },
      });
      if (!connection) {
        throw new AppError(404, 'DEV_INTEGRATION_NOT_FOUND', 'Active GitHub integration connection not found');
      }
      // Verify project belongs to workspace
      const project = await prisma.project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId, deletedAt: null } });
      if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project not found');

      try {
        const created = await prisma.projectRepository.create({
          data: {
            projectId: input.projectId,
            connectionId: connection.id,
            provider: connection.provider,
            externalRepoId: input.externalRepoId,
            fullName: input.fullName,
            defaultBranch: input.defaultBranch ?? null,
          },
        });
        await recordAuditEvent(prisma, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'dev_integration.repository_linked',
          targetType: 'ProjectRepository',
          targetId: created.id,
          metadata: { projectId: input.projectId, fullName: input.fullName, provider: connection.provider },
        });
        return toLinkedRepo(created);
      } catch (error: any) {
        if (error?.code === 'P2002') {
          throw new AppError(409, 'REPOSITORY_ALREADY_LINKED', 'This repository is already linked to the project');
        }
        throw error;
      }
    },

    async unlinkRepository(input: {
      userId: string;
      workspaceId: string;
      projectId: string;
      repositoryId: string;
    }) {
      await requireProjectRepoManager(input.userId, input.workspaceId, input.projectId);
      const repo = await prisma.projectRepository.findFirst({
        where: { id: input.repositoryId, projectId: input.projectId, project: { workspaceId: input.workspaceId } },
      });
      if (!repo) throw new AppError(404, 'PROJECT_REPOSITORY_NOT_FOUND', 'Linked repository not found');
      await prisma.projectRepository.delete({ where: { id: repo.id } });
      await recordAuditEvent(prisma, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'dev_integration.repository_unlinked',
        targetType: 'ProjectRepository',
        targetId: repo.id,
        metadata: { projectId: input.projectId, fullName: repo.fullName },
      });
      return { ok: true };
    },
  };
}

export type DevIntegrationService = ReturnType<typeof createDevIntegrationService>;
