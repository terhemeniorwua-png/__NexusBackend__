import type { DevChangedFile, DevCommitSummary, DevPullRequestDetail } from './dev-integration.types';
/* eslint-disable @typescript-eslint/no-explicit-any */ // TODO(types): replace any with real types
import type { DevIntegrationProvider, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { ProjectPermission, authorizeProject, requireWorkspaceAccess, WorkspaceCapability } from '../authorization';
import type { AppConfig } from '../../config/env';
import { githubAppProvider } from './providers/github-app.provider';
import { gitlabProvider } from './providers/gitlab.provider';
import type { DevIntegrationProviderAdapter } from './provider.interface';
import type {
  DevBranchSummary,
  DevConnectionSummary,
  DevPullRequestSummary,
  DevRepositorySummary,
  LinkedProjectRepository,
  TaskDevLinkSummary,
} from './dev-integration.types';

function providerFor(provider: DevIntegrationProvider): DevIntegrationProviderAdapter {
  if (provider === 'GITLAB') return gitlabProvider;
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

function toTaskDevLink(row: {
  id: string;
  taskId: string;
  projectId: string;
  projectRepositoryId: string | null;
  provider: DevIntegrationProvider;
  externalType: string;
  externalId: string;
  externalNumber: number | null;
  title: string | null;
  url: string | null;
  ref: string | null;
  headRef: string | null;
  baseRef: string | null;
  state: string | null;
  repositoryFullName: string | null;
  reviewState?: string | null;
  reviewerLogin?: string | null;
  reviewedAt?: Date | null;
  mergedAt?: Date | null;
  linkedById: string;
  createdAt: Date;
  updatedAt: Date;
}): TaskDevLinkSummary {
  return {
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    projectRepositoryId: row.projectRepositoryId,
    provider: row.provider,
    externalType: row.externalType as TaskDevLinkSummary['externalType'],
    externalId: row.externalId,
    externalNumber: row.externalNumber,
    title: row.title,
    url: row.url,
    ref: row.ref,
    headRef: row.headRef,
    baseRef: row.baseRef,
    state: row.state,
    repositoryFullName: row.repositoryFullName,
    reviewState: row.reviewState ?? null,
    reviewerLogin: row.reviewerLogin ?? null,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    mergedAt: row.mergedAt ? row.mergedAt.toISOString() : null,
    linkedById: row.linkedById,
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

  async function requireTaskViewer(userId: string, workspaceId: string, projectId: string, taskId: string) {
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
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId, deletedAt: null, project: { workspaceId } },
      select: { id: true, projectId: true },
    });
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'Task not found');
    return { workspace, task };
  }

  async function requireTaskUpdater(userId: string, workspaceId: string, projectId: string, taskId: string) {
    const workspace = await requireWorkspaceAccess(prisma, {
      userId,
      workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });
    await authorizeProject(prisma, {
      actor: { userId, workspaceId, workspaceRole: workspace.effectiveRole },
      projectId,
      permission: ProjectPermission.TaskUpdate,
    });
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId, deletedAt: null, project: { workspaceId } },
      select: { id: true, projectId: true },
    });
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'Task not found');
    return { workspace, task };
  }

  async function getActiveLinkedRepository(input: {
    userId: string;
    workspaceId: string;
    projectId: string;
    repositoryId: string;
  }) {
    await requireProjectViewer(input.userId, input.workspaceId, input.projectId);
    const repo = await prisma.projectRepository.findFirst({
      where: { id: input.repositoryId, projectId: input.projectId, project: { workspaceId: input.workspaceId } },
      include: { connection: true },
    });
    if (!repo) throw new AppError(404, 'PROJECT_REPOSITORY_NOT_FOUND', 'Linked repository not found');
    if (repo.connection.status !== 'ACTIVE') {
      throw new AppError(409, 'DEV_INTEGRATION_NOT_ACTIVE', 'Integration connection is not active');
    }
    return repo;
  }

  return {
    async startConnect(input: { userId: string; workspaceId: string; provider: DevIntegrationProvider }) {
      await requireWorkspaceManager(input.userId, input.workspaceId);
      const providerImpl = providerFor(input.provider);
      const result = await providerImpl.startConnect({ config, userId: input.userId, workspaceId: input.workspaceId });
      await recordAuditEvent(prisma, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'dev_integration.connect_started',
        targetType: 'IntegrationConnection',
        targetId: input.workspaceId,
        metadata: { provider: input.provider },
      });
      return result;
    },

    async startGithubConnect(input: { userId: string; workspaceId: string }) {
      return this.startConnect({ ...input, provider: 'GITHUB' });
    },

    async startGitlabConnect(input: { userId: string; workspaceId: string }) {
      return this.startConnect({ ...input, provider: 'GITLAB' });
    },

    async handleCallback(input: { provider: DevIntegrationProvider; query: Record<string, unknown> }) {
      const providerImpl = providerFor(input.provider);
      const state = typeof input.query.state === 'string' ? input.query.state : '';
      if (!state) throw new AppError(400, 'DEV_INTEGRATION_STATE_INVALID', 'Missing authorization state');
      const claims = await providerImpl.verifyAndConsumeState(state);
      await requireWorkspaceManager(claims.userId, claims.workspaceId);

      const result = await providerImpl.handleCallback({ config, query: input.query, claims });

      const connection = await prisma.integrationConnection.upsert({
        where: { workspaceId_provider: { workspaceId: claims.workspaceId, provider: input.provider } },
        create: {
          provider: input.provider,
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
        metadata: { provider: input.provider, externalAccountLogin: result.externalAccount.login },
      });

      return { connection: toConnectionSummary(connection), claims };
    },

    async handleGithubCallback(input: { query: Record<string, unknown> }) {
      return this.handleCallback({ provider: 'GITHUB', query: input.query });
    },

    async handleGitlabCallback(input: { query: Record<string, unknown> }) {
      return this.handleCallback({ provider: 'GITLAB', query: input.query });
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
          onCredentialsRefreshed: async (encryptedCredentials) => {
            await prisma.integrationConnection.update({ where: { id: connection.id }, data: { encryptedCredentials, lastError: null } }).catch(() => undefined);
          },
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
        where: { id: input.connectionId, workspaceId: input.workspaceId, status: 'ACTIVE' },
      });
      if (!connection) {
        throw new AppError(404, 'DEV_INTEGRATION_NOT_FOUND', 'Active integration connection not found');
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

    async listRepositoryBranches(input: {
      userId: string;
      workspaceId: string;
      projectId: string;
      repositoryId: string;
      search?: string;
      page?: number;
      perPage?: number;
    }): Promise<DevBranchSummary[]> {
      const repo = await getActiveLinkedRepository(input);
      const provider = providerFor(repo.provider);
      try {
        return await provider.listRepositoryBranches({
          config,
          encryptedCredentials: repo.connection.encryptedCredentials,
          repositoryFullName: repo.fullName,
          search: input.search,
          page: input.page,
          perPage: input.perPage,
          onCredentialsRefreshed: async (encryptedCredentials) => {
            await prisma.integrationConnection.update({ where: { id: repo.connectionId }, data: { encryptedCredentials, lastError: null } }).catch(() => undefined);
          },
        });
      } catch (error) {
        logger.warn('dev_integration_list_branches_failed', { error, repositoryId: repo.id });
        throw error;
      }
    },

    async listRepositoryPullRequests(input: {
      userId: string;
      workspaceId: string;
      projectId: string;
      repositoryId: string;
      search?: string;
      page?: number;
      perPage?: number;
      state?: 'open' | 'closed' | 'all';
    }): Promise<DevPullRequestSummary[]> {
      const repo = await getActiveLinkedRepository(input);
      const provider = providerFor(repo.provider);
      try {
        return await provider.listRepositoryPullRequests({
          config,
          encryptedCredentials: repo.connection.encryptedCredentials,
          repositoryFullName: repo.fullName,
          search: input.search,
          page: input.page,
          perPage: input.perPage,
          state: input.state ?? 'open',
          onCredentialsRefreshed: async (encryptedCredentials) => {
            await prisma.integrationConnection.update({ where: { id: repo.connectionId }, data: { encryptedCredentials, lastError: null } }).catch(() => undefined);
          },
        });
      } catch (error) {
        logger.warn('dev_integration_list_prs_failed', { error, repositoryId: repo.id });
        throw error;
      }
    },

    async getRepositoryPullRequest(input: {
      userId: string; workspaceId: string; projectId: string; repositoryId: string; number: number;
    }): Promise<DevPullRequestDetail> {
      const repo = await getActiveLinkedRepository(input);
      const provider = providerFor(repo.provider);
      if (!provider.getPullRequest) throw new AppError(501, 'NOT_SUPPORTED', 'This provider does not support pull request details yet');
      return provider.getPullRequest({
        config, encryptedCredentials: repo.connection.encryptedCredentials,
        repositoryFullName: repo.fullName, number: input.number,
      });
    },

    async listRepositoryPullRequestFiles(input: {
      userId: string; workspaceId: string; projectId: string; repositoryId: string; number: number; page?: number; perPage?: number;
    }): Promise<DevChangedFile[]> {
      const repo = await getActiveLinkedRepository(input);
      const provider = providerFor(repo.provider);
      if (!provider.listPullRequestFiles) throw new AppError(501, 'NOT_SUPPORTED', 'This provider does not support changed files yet');
      return provider.listPullRequestFiles({
        config, encryptedCredentials: repo.connection.encryptedCredentials,
        repositoryFullName: repo.fullName, number: input.number, page: input.page, perPage: input.perPage,
      });
    },

    async listRepositoryPullRequestCommits(input: {
      userId: string; workspaceId: string; projectId: string; repositoryId: string; number: number; page?: number; perPage?: number;
    }): Promise<DevCommitSummary[]> {
      const repo = await getActiveLinkedRepository(input);
      const provider = providerFor(repo.provider);
      if (!provider.listPullRequestCommits) throw new AppError(501, 'NOT_SUPPORTED', 'This provider does not support commit lists yet');
      return provider.listPullRequestCommits({
        config, encryptedCredentials: repo.connection.encryptedCredentials,
        repositoryFullName: repo.fullName, number: input.number, page: input.page, perPage: input.perPage,
      });
    },

    async listRepositoryCommits(input: {
      userId: string; workspaceId: string; projectId: string; repositoryId: string; branch?: string; page?: number; perPage?: number;
    }): Promise<DevCommitSummary[]> {
      const repo = await getActiveLinkedRepository(input);
      const provider = providerFor(repo.provider);
      if (!provider.listBranchCommits) throw new AppError(501, 'NOT_SUPPORTED', 'This provider does not support commit lists yet');
      return provider.listBranchCommits({
        config, encryptedCredentials: repo.connection.encryptedCredentials,
        repositoryFullName: repo.fullName, branch: input.branch, page: input.page, perPage: input.perPage,
      });
    },

    async getRepositoryCommit(input: {
      userId: string; workspaceId: string; projectId: string; repositoryId: string; sha: string;
    }) {
      if (!/^[0-9a-fA-F]{7,40}$/.test(input.sha)) throw new AppError(400, 'INVALID_COMMIT_SHA', 'That is not a valid commit id');
      const repo = await getActiveLinkedRepository(input);
      const provider = providerFor(repo.provider);
      if (!provider.getCommit) throw new AppError(501, 'NOT_SUPPORTED', 'This provider does not support commit details yet');
      return provider.getCommit({
        config, encryptedCredentials: repo.connection.encryptedCredentials,
        repositoryFullName: repo.fullName, sha: input.sha,
      });
    },

    async listTaskDevLinks(input: {
      userId: string;
      workspaceId: string;
      projectId: string;
      taskId: string;
    }): Promise<TaskDevLinkSummary[]> {
      await requireTaskViewer(input.userId, input.workspaceId, input.projectId, input.taskId);
      const rows = await prisma.taskDevLink.findMany({
        where: { taskId: input.taskId, projectId: input.projectId, task: { project: { workspaceId: input.workspaceId } } },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toTaskDevLink);
    },

    async linkTaskDevLink(input: {
      userId: string;
      workspaceId: string;
      projectId: string;
      taskId: string;
      projectRepositoryId: string;
      externalType: 'BRANCH' | 'PULL_REQUEST' | 'COMMIT';
      externalId: string;
      externalNumber?: number | null;
      title?: string | null;
      url?: string | null;
      ref?: string | null;
      headRef?: string | null;
      baseRef?: string | null;
      state?: string | null;
    }): Promise<TaskDevLinkSummary> {
      await requireTaskUpdater(input.userId, input.workspaceId, input.projectId, input.taskId);
      const repo = await prisma.projectRepository.findFirst({
        where: { id: input.projectRepositoryId, projectId: input.projectId, project: { workspaceId: input.workspaceId } },
        include: { connection: true },
      });
      if (!repo) throw new AppError(404, 'PROJECT_REPOSITORY_NOT_FOUND', 'Linked repository not found');
      if (repo.connection.status !== 'ACTIVE') {
        throw new AppError(409, 'DEV_INTEGRATION_NOT_ACTIVE', 'Integration connection is not active');
      }

      try {
        const created = await prisma.taskDevLink.create({
          data: {
            taskId: input.taskId,
            projectId: input.projectId,
            projectRepositoryId: repo.id,
            provider: repo.provider,
            externalType: input.externalType,
            externalId: input.externalId,
            externalNumber: input.externalNumber ?? null,
            title: input.title ?? null,
            url: input.url ?? null,
            ref: input.ref ?? null,
            headRef: input.headRef ?? null,
            baseRef: input.baseRef ?? null,
            state: input.state ?? null,
            repositoryFullName: repo.fullName,
            linkedById: input.userId,
          },
        });
        await recordAuditEvent(prisma, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'dev_integration.task_dev_link_created',
          targetType: 'TaskDevLink',
          targetId: created.id,
          metadata: {
            taskId: input.taskId,
            projectId: input.projectId,
            repositoryFullName: repo.fullName,
            externalType: input.externalType,
            externalId: input.externalId,
          },
        });
        return toTaskDevLink(created);
      } catch (error: any) {
        if (error?.code === 'P2002') {
          throw new AppError(409, 'TASK_DEV_LINK_ALREADY_EXISTS', 'This development item is already linked to the task');
        }
        throw error;
      }
    },

    async unlinkTaskDevLink(input: {
      userId: string;
      workspaceId: string;
      projectId: string;
      taskId: string;
      devLinkId: string;
    }) {
      await requireTaskUpdater(input.userId, input.workspaceId, input.projectId, input.taskId);
      const link = await prisma.taskDevLink.findFirst({
        where: { id: input.devLinkId, taskId: input.taskId, projectId: input.projectId, task: { project: { workspaceId: input.workspaceId } } },
      });
      if (!link) throw new AppError(404, 'TASK_DEV_LINK_NOT_FOUND', 'Development link not found');
      await prisma.taskDevLink.delete({ where: { id: link.id } });
      await recordAuditEvent(prisma, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'dev_integration.task_dev_link_deleted',
        targetType: 'TaskDevLink',
        targetId: link.id,
        metadata: { taskId: input.taskId, externalType: link.externalType, externalId: link.externalId },
      });
      return { ok: true };
    },
  };
}

export type DevIntegrationService = ReturnType<typeof createDevIntegrationService>;
