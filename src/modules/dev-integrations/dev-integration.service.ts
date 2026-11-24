import type { DevChangedFile, DevCommitSummary, DevPullRequestDetail } from './dev-integration.types';
/* eslint-disable @typescript-eslint/no-explicit-any */ // TODO(types): replace any with real types
import { Prisma, type DevIntegrationProvider, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  ProjectPermission,
  authorizeProject,
  effectiveWorkspaceRole,
  requireWorkspaceAccess,
  resolveProjectAuthorization,
  WorkspaceCapability,
} from '../authorization';
import { resolveRepositoryAccess, type RepositoryAccessLevelValue } from './repository-access.resolver';
import { resolveDevActivityDeveloper } from './dev-activity-identity';
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
  RepositoryAccessMember,
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

function toLinkedRepo(
  row: {
    id: string;
    projectId: string;
    connectionId: string;
    provider: DevIntegrationProvider;
    externalRepoId: string;
    fullName: string;
    defaultBranch: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  effectiveAccessLevel: RepositoryAccessLevelValue,
): LinkedProjectRepository {
  return {
    id: row.id,
    projectId: row.projectId,
    connectionId: row.connectionId,
    provider: row.provider,
    externalRepoId: row.externalRepoId,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    effectiveAccessLevel,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toTaskDevLink(
  row: {
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
  },
  effectiveAccessLevel: RepositoryAccessLevelValue | null,
): TaskDevLinkSummary {
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
    effectiveAccessLevel,
    linkedById: row.linkedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const MASKED_REPOSITORY_NAME = 'Restricted repository';

function missingRepositoryError(): AppError {
  // Same shape as missing resource; never leak repo identity.
  return new AppError(404, 'PROJECT_REPOSITORY_NOT_FOUND', 'Linked repository not found');
}

function repositoryAccessForbidden(): AppError {
  return new AppError(
    403,
    'PERMISSION_DENIED',
    'Your repository access does not allow this action',
  );
}

function maskLinkedRepo(repo: LinkedProjectRepository): LinkedProjectRepository {
  return {
    ...repo,
    externalRepoId: 'restricted',
    fullName: MASKED_REPOSITORY_NAME,
    defaultBranch: null,
  };
}

function maskTaskDevLink(link: TaskDevLinkSummary): TaskDevLinkSummary {
  return {
    ...link,
    externalId: 'restricted',
    externalNumber: null,
    title: null,
    url: null,
    ref: null,
    headRef: null,
    baseRef: null,
    repositoryFullName: MASKED_REPOSITORY_NAME,
    reviewState: null,
    reviewerLogin: null,
    reviewedAt: null,
    mergedAt: null,
  };
}

function defaultRepositoryAccessLevel(authorization: {
  projectRole?: string | null;
  accessSource?: string;
}): RepositoryAccessLevelValue {
  if (authorization.projectRole === 'VIEWER') return 'READ';
  if (authorization.accessSource === 'workspace_member' && authorization.projectRole === null) return 'READ';
  return 'LINK';
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
    if (!repo) throw missingRepositoryError();

    const access = await resolveRepositoryAccess(prisma, {
      projectId: input.projectId,
      repositoryId: input.repositoryId,
      userId: input.userId,
    });
    if (access === 'NONE' || access === 'METADATA') {
      throw missingRepositoryError();
    }

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
      const resolved = await Promise.all(
        rows.map(async (row) => {
          const access = await resolveRepositoryAccess(prisma, {
            projectId: input.projectId,
            repositoryId: row.id,
            userId: input.userId,
          });
          return { row, access };
        }),
      );
      return resolved.flatMap(({ row, access }) => {
        if (access === 'NONE') return [];
        const repo = toLinkedRepo(row, access);
        return [access === 'METADATA' ? maskLinkedRepo(repo) : repo];
      });
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
        const effectiveAccessLevel = await resolveRepositoryAccess(prisma, {
          projectId: input.projectId,
          repositoryId: created.id,
          userId: input.userId,
        });
        return toLinkedRepo(created, effectiveAccessLevel);
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

    async listRepositoryMembers(input: {
      userId: string;
      workspaceId: string;
      projectId: string;
      repositoryId: string;
    }): Promise<RepositoryAccessMember[]> {
      await requireProjectRepoManager(input.userId, input.workspaceId, input.projectId);
      const repo = await prisma.projectRepository.findFirst({
        where: { id: input.repositoryId, projectId: input.projectId, project: { workspaceId: input.workspaceId } },
        select: { id: true },
      });
      if (!repo) throw new AppError(404, 'PROJECT_REPOSITORY_NOT_FOUND', 'Linked repository not found');

      const workspaceMembers = await prisma.workspaceMembership.findMany({
        where: { workspaceId: input.workspaceId, status: 'ACTIVE' },
        select: {
          userId: true,
          role: true,
          organizationRole: true,
          workspace: { select: { type: true } },
          user: { select: { id: true, name: true, email: true } },
        },
      });

      const overrides = await prisma.projectRepositoryMember.findMany({
        where: { projectRepositoryId: input.repositoryId },
        select: { userId: true, level: true },
      });
      const overrideByUser = new Map(overrides.map((o) => [o.userId, o.level as RepositoryAccessLevelValue]));

      const members = await Promise.all(
        workspaceMembers.map(async (wm) => {
          const workspaceRole = effectiveWorkspaceRole(wm.workspace.type, wm.role, wm.organizationRole);
          let authorization;
          try {
            authorization = await resolveProjectAuthorization(
              prisma,
              { userId: wm.userId, workspaceId: input.workspaceId, workspaceRole },
              input.projectId,
            );
          } catch (error) {
            if (
              error instanceof AppError &&
              ['PROJECT_NOT_FOUND', 'PROJECT_ACCESS_DENIED', 'ORGANIZATION_ROLE_WORKSPACE_MISMATCH'].includes(error.code)
            ) {
              return null;
            }
            throw error;
          }

          const defaultLevel = defaultRepositoryAccessLevel(authorization);
          const overrideLevel = overrideByUser.get(wm.userId) ?? null;
          const effectiveAccessLevel = overrideLevel ?? defaultLevel;
          return {
            userId: wm.userId,
            effectiveAccessLevel,
            defaultLevel,
            isOverride: overrideLevel !== null,
            overrideLevel,
            inheritedWorkspaceAccess: authorization.accessSource !== 'project_member',
            user: wm.user,
          } satisfies RepositoryAccessMember;
        }),
      );

      const eligible: RepositoryAccessMember[] = [];
      for (const member of members) {
        if (member) eligible.push(member);
      }
      return eligible.sort((a, b) => {
        const an = (a.user.name ?? a.user.email).toLowerCase();
        const bn = (b.user.name ?? b.user.email).toLowerCase();
        if (an < bn) return -1;
        if (an > bn) return 1;
        return a.userId.localeCompare(b.userId);
      });
    },

    async setRepositoryMemberOverride(input: {
      userId: string;
      workspaceId: string;
      projectId: string;
      repositoryId: string;
      targetUserId: string;
      level: RepositoryAccessLevelValue;
    }): Promise<RepositoryAccessMember> {
      await requireProjectRepoManager(input.userId, input.workspaceId, input.projectId);
      const repo = await prisma.projectRepository.findFirst({
        where: { id: input.repositoryId, projectId: input.projectId, project: { workspaceId: input.workspaceId } },
        select: { id: true },
      });
      if (!repo) throw new AppError(404, 'PROJECT_REPOSITORY_NOT_FOUND', 'Linked repository not found');

      const targetMembership = await prisma.workspaceMembership.findFirst({
        where: { workspaceId: input.workspaceId, userId: input.targetUserId, status: 'ACTIVE' },
        select: {
          userId: true,
          role: true,
          organizationRole: true,
          workspace: { select: { type: true } },
          user: { select: { id: true, name: true, email: true } },
        },
      });
      if (!targetMembership) {
        throw new AppError(404, 'PROJECT_MEMBER_NOT_FOUND', 'That project member does not exist');
      }

      const targetWorkspaceRole = effectiveWorkspaceRole(
        targetMembership.workspace.type,
        targetMembership.role,
        targetMembership.organizationRole,
      );
      let targetAuth;
      try {
        targetAuth = await resolveProjectAuthorization(
          prisma,
          { userId: input.targetUserId, workspaceId: input.workspaceId, workspaceRole: targetWorkspaceRole },
          input.projectId,
        );
      } catch (error) {
        if (
          error instanceof AppError &&
          ['PROJECT_NOT_FOUND', 'PROJECT_ACCESS_DENIED', 'ORGANIZATION_ROLE_WORKSPACE_MISMATCH'].includes(error.code)
        ) {
          throw new AppError(404, 'PROJECT_MEMBER_NOT_FOUND', 'That project member does not exist');
        }
        throw error;
      }

      const defaultLevel = defaultRepositoryAccessLevel(targetAuth);
      const existing = await prisma.projectRepositoryMember.findUnique({
        where: { projectRepositoryId_userId: { projectRepositoryId: input.repositoryId, userId: input.targetUserId } },
        select: { level: true },
      });
      const oldOverrideLevel = (existing?.level as RepositoryAccessLevelValue | undefined) ?? null;
      const oldEffectiveLevel = oldOverrideLevel ?? defaultLevel;

      await prisma.projectRepositoryMember.upsert({
        where: { projectRepositoryId_userId: { projectRepositoryId: input.repositoryId, userId: input.targetUserId } },
        create: {
          projectRepositoryId: input.repositoryId,
          projectId: input.projectId,
          userId: input.targetUserId,
          level: input.level,
          grantedById: input.userId,
        },
        update: {
          level: input.level,
          grantedById: input.userId,
        },
      });

      await recordAuditEvent(prisma, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'dev_integration.repository_access_override_set',
        targetType: 'ProjectRepositoryMember',
        targetId: input.repositoryId,
        metadata: {
          projectId: input.projectId,
          repositoryId: input.repositoryId,
          targetUserId: input.targetUserId,
          oldOverrideLevel,
          newOverrideLevel: input.level,
          oldEffectiveLevel,
          newEffectiveLevel: input.level,
        },
      });

      return {
        userId: input.targetUserId,
        effectiveAccessLevel: input.level,
        defaultLevel,
        isOverride: true,
        overrideLevel: input.level,
        inheritedWorkspaceAccess: targetAuth.accessSource !== 'project_member',
        user: targetMembership.user,
      };
    },

    async removeRepositoryMemberOverride(input: {
      userId: string;
      workspaceId: string;
      projectId: string;
      repositoryId: string;
      targetUserId: string;
    }): Promise<RepositoryAccessMember> {
      await requireProjectRepoManager(input.userId, input.workspaceId, input.projectId);
      const repo = await prisma.projectRepository.findFirst({
        where: { id: input.repositoryId, projectId: input.projectId, project: { workspaceId: input.workspaceId } },
        select: { id: true },
      });
      if (!repo) throw new AppError(404, 'PROJECT_REPOSITORY_NOT_FOUND', 'Linked repository not found');

      const targetMembership = await prisma.workspaceMembership.findFirst({
        where: { workspaceId: input.workspaceId, userId: input.targetUserId, status: 'ACTIVE' },
        select: {
          userId: true,
          role: true,
          organizationRole: true,
          workspace: { select: { type: true } },
          user: { select: { id: true, name: true, email: true } },
        },
      });
      if (!targetMembership) {
        throw new AppError(404, 'PROJECT_MEMBER_NOT_FOUND', 'That project member does not exist');
      }

      const targetWorkspaceRole = effectiveWorkspaceRole(
        targetMembership.workspace.type,
        targetMembership.role,
        targetMembership.organizationRole,
      );
      let targetAuth;
      try {
        targetAuth = await resolveProjectAuthorization(
          prisma,
          { userId: input.targetUserId, workspaceId: input.workspaceId, workspaceRole: targetWorkspaceRole },
          input.projectId,
        );
      } catch (error) {
        if (
          error instanceof AppError &&
          ['PROJECT_NOT_FOUND', 'PROJECT_ACCESS_DENIED', 'ORGANIZATION_ROLE_WORKSPACE_MISMATCH'].includes(error.code)
        ) {
          throw new AppError(404, 'PROJECT_MEMBER_NOT_FOUND', 'That project member does not exist');
        }
        throw error;
      }

      const defaultLevel = defaultRepositoryAccessLevel(targetAuth);
      const existing = await prisma.projectRepositoryMember.findUnique({
        where: { projectRepositoryId_userId: { projectRepositoryId: input.repositoryId, userId: input.targetUserId } },
        select: { level: true },
      });
      const oldOverrideLevel = (existing?.level as RepositoryAccessLevelValue | undefined) ?? null;
      const oldEffectiveLevel = oldOverrideLevel ?? defaultLevel;

      if (existing) {
        await prisma.projectRepositoryMember.delete({
          where: { projectRepositoryId_userId: { projectRepositoryId: input.repositoryId, userId: input.targetUserId } },
        });
        await recordAuditEvent(prisma, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'dev_integration.repository_access_override_removed',
          targetType: 'ProjectRepositoryMember',
          targetId: input.repositoryId,
          metadata: {
            projectId: input.projectId,
            repositoryId: input.repositoryId,
            targetUserId: input.targetUserId,
            oldOverrideLevel,
            newOverrideLevel: null,
            oldEffectiveLevel,
            newEffectiveLevel: defaultLevel,
          },
        });
      }

      return {
        userId: input.targetUserId,
        effectiveAccessLevel: defaultLevel,
        defaultLevel,
        isOverride: false,
        overrideLevel: null,
        inheritedWorkspaceAccess: targetAuth.accessSource !== 'project_member',
        user: targetMembership.user,
      };
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

      const accessByRepo = new Map<string, RepositoryAccessLevelValue>();
      const uniqueRepoIds = [...new Set(rows.map((r) => r.projectRepositoryId).filter((id): id is string => !!id))];
      await Promise.all(
        uniqueRepoIds.map(async (repositoryId) => {
          const access = await resolveRepositoryAccess(prisma, {
            projectId: input.projectId,
            repositoryId,
            userId: input.userId,
          });
          accessByRepo.set(repositoryId, access);
        }),
      );

      return rows.flatMap((row) => {
        if (!row.projectRepositoryId) return [toTaskDevLink(row, null)];
        const access = accessByRepo.get(row.projectRepositoryId) ?? 'NONE';
        if (access === 'NONE') return [];
        const link = toTaskDevLink(row, access);
        if (access === 'METADATA') return [maskTaskDevLink(link)];
        return [link];
      });
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
      if (!repo) throw missingRepositoryError();

      const access = await resolveRepositoryAccess(prisma, {
        projectId: input.projectId,
        repositoryId: repo.id,
        userId: input.userId,
      });
      if (access === 'NONE') throw missingRepositoryError();
      if (access === 'METADATA' || access === 'READ') throw repositoryAccessForbidden();

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
        return toTaskDevLink(created, 'LINK');
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

      if (link.projectRepositoryId) {
        const access = await resolveRepositoryAccess(prisma, {
          projectId: input.projectId,
          repositoryId: link.projectRepositoryId,
          userId: input.userId,
        });
        if (access === 'NONE') throw missingRepositoryError();
        if (access === 'METADATA' || access === 'READ') throw repositoryAccessForbidden();
      }

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

    async listDevActivityCommits(input: {
      userId: string;
      workspaceId: string;
      projectId: string;
      cursor?: string;
      limit?: number;
      repositoryId?: string;
      authorLogin?: string;
      from?: string;
      to?: string;
    }): Promise<{
      items: Array<{
        id: string;
        repositoryId: string;
        repositoryFullName: string;
        sha: string;
        message: string;
        authorName: string | null;
        authorLogin: string | null;
        authorUser: { id: string; name: string | null } | null;
        committedAt: string;
        url: string | null;
        branch: string | null;
      }>;
      nextCursor: string | null;
    }> {
      await requireProjectViewer(input.userId, input.workspaceId, input.projectId);

      const linkedRepos = await prisma.projectRepository.findMany({
        where: { projectId: input.projectId, provider: 'GITHUB', project: { workspaceId: input.workspaceId } },
        select: { id: true, fullName: true, provider: true },
      });

      const readableRepos: Array<{ id: string; fullName: string; provider: 'GITHUB'; lowerFullName: string }> = [];
      for (const repo of linkedRepos) {
        const access = await resolveRepositoryAccess(prisma, {
          projectId: input.projectId,
          repositoryId: repo.id,
          userId: input.userId,
        });
        if (access === 'READ' || access === 'LINK') {
          readableRepos.push({
            id: repo.id,
            fullName: repo.fullName,
            provider: 'GITHUB',
            lowerFullName: repo.fullName.toLowerCase(),
          });
        }
      }

      if (input.repositoryId) {
        const target = linkedRepos.find((r) => r.id === input.repositoryId);
        const targetReadable = readableRepos.find((r) => r.id === input.repositoryId);
        if (!target || !targetReadable) {
          throw missingRepositoryError();
        }
      }

      const selectedRepos = input.repositoryId
        ? readableRepos.filter((r) => r.id === input.repositoryId)
        : readableRepos;

      const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
      if (selectedRepos.length === 0) {
        return { items: [], nextCursor: null };
      }

      const repoNames = selectedRepos.map((r) => r.lowerFullName);
      const repoByLower = new Map(selectedRepos.map((r) => [r.lowerFullName, r]));

      const fromDate = input.from ? new Date(input.from) : null;
      const toDate = input.to ? new Date(input.to) : null;
      const authorLoginFilter = input.authorLogin?.trim() ? input.authorLogin.trim().toLowerCase() : null;

      let cursorCommittedAt: Date | null = null;
      let cursorId: string | null = null;
      if (input.cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as {
            c?: string;
            i?: string;
          };
          if (typeof decoded.c === 'string' && typeof decoded.i === 'string') {
            const c = new Date(decoded.c);
            if (!Number.isNaN(c.getTime())) {
              cursorCommittedAt = c;
              cursorId = decoded.i;
            }
          }
        } catch {
          throw new AppError(400, 'VALIDATION_ERROR', 'Invalid cursor');
        }
      }

      // Read-time case-insensitive match and dedupe by lower(repositoryFullName)+sha.
      // Access filter is applied before pagination by restricting to readable repos only.
      const conditions: Prisma.Sql[] = [
        Prisma.sql`"provider" = 'GITHUB'`,
        Prisma.sql`"isDefaultBranch" = true`,
        Prisma.sql`LOWER("repositoryFullName") = ANY(${repoNames}::text[])`,
      ];
      if (fromDate) conditions.push(Prisma.sql`"committedAt" >= ${fromDate}`);
      if (toDate) conditions.push(Prisma.sql`"committedAt" <= ${toDate}`);
      if (authorLoginFilter) conditions.push(Prisma.sql`LOWER("authorLogin") = ${authorLoginFilter}`);
      if (cursorCommittedAt && cursorId) {
        conditions.push(
          Prisma.sql`("committedAt" < ${cursorCommittedAt} OR ("committedAt" = ${cursorCommittedAt} AND "id" < ${cursorId}))`,
        );
      }
      const where = Prisma.join(conditions, ' AND ');

      const rows = await prisma.$queryRaw<
        Array<{
          id: string;
          repositoryFullName: string;
          sha: string;
          message: string;
          authorName: string | null;
          authorLogin: string | null;
          committedAt: Date;
          url: string | null;
          branch: string | null;
        }>
      >(Prisma.sql`
        SELECT "id", "repositoryFullName", "sha", "message", "authorName", "authorLogin",
               "committedAt", "url", "branch"
        FROM (
          SELECT DISTINCT ON (LOWER("repositoryFullName"), "sha")
            "id", "repositoryFullName", "sha", "message", "authorName", "authorLogin",
            "committedAt", "url", "branch"
          FROM "RepositoryCommit"
          WHERE ${where}
          ORDER BY LOWER("repositoryFullName"), "sha", "committedAt" DESC, "id" DESC
        ) t
        ORDER BY "committedAt" DESC, "id" DESC
        LIMIT ${limit + 1}
      `);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      // Identity resolved at read time from verified workspace member connections only.
      const identityCandidates = await prisma.integrationConnection.findMany({
        where: {
          workspaceId: input.workspaceId,
          provider: 'GITHUB',
          status: 'ACTIVE',
          externalAccountLogin: { not: null },
          createdBy: {
            workspaceMemberships: {
              some: { workspaceId: input.workspaceId, status: 'ACTIVE' },
            },
          },
        },
        select: {
          externalAccountLogin: true,
          createdBy: { select: { id: true, name: true } },
        },
      });
      const candidates = identityCandidates.map((c) => ({
        userId: c.createdBy.id,
        name: c.createdBy.name,
        externalAccountLogin: c.externalAccountLogin,
      }));

      const items = page.map((row) => {
        const repo = repoByLower.get(row.repositoryFullName.toLowerCase());
        const resolved = resolveDevActivityDeveloper({ providerLogin: row.authorLogin, candidates });
        return {
          id: row.id,
          repositoryId: repo?.id ?? '',
          repositoryFullName: row.repositoryFullName,
          sha: row.sha,
          message: row.message,
          authorName: row.authorName,
          authorLogin: row.authorLogin,
          authorUser: resolved.type === 'workspace_user' ? resolved.user : null,
          committedAt: row.committedAt.toISOString(),
          url: row.url,
          branch: row.branch,
        };
      });

      const last = page.at(-1);
      const nextCursor =
        hasMore && last
          ? Buffer.from(
              JSON.stringify({ c: last.committedAt.toISOString(), i: last.id }),
              'utf8',
            ).toString('base64url')
          : null;

      return { items, nextCursor };
    },

    async listDevActivityDevelopers(input: {
      userId: string;
      workspaceId: string;
      projectId: string;
      from: string;
      to: string;
      repositoryId?: string;
    }): Promise<{
      range: { from: string; to: string };
      coverageStartedAt: string | null;
      developers: Array<{
        type: 'workspace_user' | 'unmapped';
        user: { id: string; name: string | null } | null;
        providerLogin: string | null;
        displayName: string;
        commits: number;
        pullRequestsOpened: number;
        pullRequestsMerged: number;
        reviewsGiven: number;
      }>;
    }> {
      // Manager-level permission (not plain View). ProjectPermission.Update = 'project.update'.
      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      await authorizeProject(prisma, {
        actor: { userId: input.userId, workspaceId: input.workspaceId, workspaceRole: workspace.effectiveRole },
        projectId: input.projectId,
        permission: ProjectPermission.Update,
      });

      const from = new Date(input.from);
      const to = new Date(input.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid from/to');
      }
      if (!(from < to)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'from must be before to');
      }
      const maxRangeMs = 90 * 24 * 60 * 60 * 1000;
      if (to.getTime() - from.getTime() > maxRangeMs) {
        throw new AppError(400, 'VALIDATION_ERROR', 'range must be 90 days or less');
      }

      const linkedRepos = await prisma.projectRepository.findMany({
        where: { projectId: input.projectId, provider: 'GITHUB', project: { workspaceId: input.workspaceId } },
        select: { id: true, fullName: true, provider: true },
      });

      const readableRepos: Array<{ id: string; fullName: string; lowerFullName: string }> = [];
      for (const repo of linkedRepos) {
        const access = await resolveRepositoryAccess(prisma, {
          projectId: input.projectId,
          repositoryId: repo.id,
          userId: input.userId,
        });
        if (access === 'READ' || access === 'LINK') {
          readableRepos.push({ id: repo.id, fullName: repo.fullName, lowerFullName: repo.fullName.toLowerCase() });
        }
      }

      if (input.repositoryId) {
        const target = linkedRepos.find((r) => r.id === input.repositoryId);
        const targetReadable = readableRepos.find((r) => r.id === input.repositoryId);
        if (!target || !targetReadable) {
          throw missingRepositoryError();
        }
      }

      const selectedRepos = input.repositoryId
        ? readableRepos.filter((r) => r.id === input.repositoryId)
        : readableRepos;

      if (selectedRepos.length === 0) {
        return {
          range: { from: from.toISOString(), to: to.toISOString() },
          coverageStartedAt: null,
          developers: [],
        };
      }

      const repoNames = selectedRepos.map((r) => r.lowerFullName);

      // coverageStartedAt: earliest ingestedAt among mirror rows of INCLUDED repos only.
      const [commitCov, prCov, reviewCov] = await Promise.all([
        prisma.$queryRaw<Array<{ min: Date | null }>>(Prisma.sql`
          SELECT MIN("ingestedAt") AS "min" FROM "RepositoryCommit"
          WHERE "provider" = 'GITHUB' AND LOWER("repositoryFullName") = ANY(${repoNames}::text[])
        `),
        prisma.$queryRaw<Array<{ min: Date | null }>>(Prisma.sql`
          SELECT MIN("ingestedAt") AS "min" FROM "RepositoryPullRequestEvent"
          WHERE "provider" = 'GITHUB' AND LOWER("repositoryFullName") = ANY(${repoNames}::text[])
        `),
        prisma.$queryRaw<Array<{ min: Date | null }>>(Prisma.sql`
          SELECT MIN("ingestedAt") AS "min" FROM "RepositoryReviewEvent"
          WHERE "provider" = 'GITHUB' AND LOWER("repositoryFullName") = ANY(${repoNames}::text[])
        `),
      ]);
      const covDates = [commitCov[0]?.min, prCov[0]?.min, reviewCov[0]?.min].filter(
        (d): d is Date => d instanceof Date,
      );
      const coverageStartedAt =
        covDates.length > 0 ? new Date(Math.min(...covDates.map((d) => d.getTime()))).toISOString() : null;

      // Counting caveats (documented in code and PR body):
      // - merge commits are counted because parents are not stored
      // - force-push can leave rewritten history in counts
      // - partial push truncation is not detected
      // - history starts at ingestion, no backfill

      const [commitRows, prOpenedRows, prMergedRows, reviewRows, prAuthors] = await Promise.all([
        prisma.$queryRaw<Array<{ authorLogin: string | null; commits: bigint }>>(Prisma.sql`
          SELECT "authorLogin", COUNT(*)::bigint AS "commits"
          FROM (
            SELECT DISTINCT ON (LOWER("repositoryFullName"), "sha") "authorLogin"
            FROM "RepositoryCommit"
            WHERE "provider" = 'GITHUB'
              AND "isDefaultBranch" = true
              AND LOWER("repositoryFullName") = ANY(${repoNames}::text[])
              AND "committedAt" >= ${from}
              AND "committedAt" <= ${to}
            ORDER BY LOWER("repositoryFullName"), "sha", "committedAt" DESC, "id" DESC
          ) t
          GROUP BY "authorLogin"
        `),
        prisma.$queryRaw<Array<{ authorLogin: string | null; count: bigint }>>(Prisma.sql`
          SELECT "authorLogin", COUNT(*)::bigint AS "count"
          FROM "RepositoryPullRequestEvent"
          WHERE "provider" = 'GITHUB'
            AND LOWER("repositoryFullName") = ANY(${repoNames}::text[])
            AND "action" = 'OPENED'
            AND "occurredAt" >= ${from}
            AND "occurredAt" <= ${to}
          GROUP BY "authorLogin"
        `),
        prisma.$queryRaw<Array<{ authorLogin: string | null; count: bigint }>>(Prisma.sql`
          SELECT "authorLogin", COUNT(*)::bigint AS "count"
          FROM "RepositoryPullRequestEvent"
          WHERE "provider" = 'GITHUB'
            AND LOWER("repositoryFullName") = ANY(${repoNames}::text[])
            AND "action" = 'MERGED'
            AND "occurredAt" >= ${from}
            AND "occurredAt" <= ${to}
          GROUP BY "authorLogin"
        `),
        prisma.$queryRaw<Array<{ reviewerLogin: string | null; externalPrId: string | null; repositoryFullName: string }>>(Prisma.sql`
          SELECT "reviewerLogin", "externalPrId", "repositoryFullName"
          FROM "RepositoryReviewEvent"
          WHERE "provider" = 'GITHUB'
            AND LOWER("repositoryFullName") = ANY(${repoNames}::text[])
            AND "submittedAt" >= ${from}
            AND "submittedAt" <= ${to}
        `),
        prisma.$queryRaw<Array<{ externalPrId: string | null; repositoryFullName: string; authorLogin: string | null }>>(Prisma.sql`
          SELECT "externalPrId", "repositoryFullName", "authorLogin"
          FROM "RepositoryPullRequestEvent"
          WHERE "provider" = 'GITHUB'
            AND LOWER("repositoryFullName") = ANY(${repoNames}::text[])
            AND "action" = 'OPENED'
        `),
      ]);

      const prAuthorByKey = new Map<string, string>();
      for (const pr of prAuthors) {
        if (pr.authorLogin && pr.externalPrId) {
          prAuthorByKey.set(`${pr.repositoryFullName.toLowerCase()}::${pr.externalPrId}`, pr.authorLogin.toLowerCase());
        }
      }

      type DevAgg = { commits: number; prsOpened: number; prsMerged: number; reviewsGiven: number };
      const byLogin = new Map<string, DevAgg>();
      const ensure = (login: string | null | undefined): DevAgg | null => {
        const key = (login ?? '').trim().toLowerCase();
        if (!key) return null;
        const existing = byLogin.get(key);
        if (existing) return existing;
        const created: DevAgg = { commits: 0, prsOpened: 0, prsMerged: 0, reviewsGiven: 0 };
        byLogin.set(key, created);
        return created;
      };

      for (const row of commitRows) {
        const agg = ensure(row.authorLogin);
        if (agg) agg.commits += Number(row.commits);
      }
      for (const row of prOpenedRows) {
        const agg = ensure(row.authorLogin);
        if (agg) agg.prsOpened += Number(row.count);
      }
      for (const row of prMergedRows) {
        const agg = ensure(row.authorLogin);
        if (agg) agg.prsMerged += Number(row.count);
      }
      for (const row of reviewRows) {
        const reviewer = (row.reviewerLogin ?? '').trim().toLowerCase();
        if (!reviewer) continue;
        const prKey = row.externalPrId ? `${row.repositoryFullName.toLowerCase()}::${row.externalPrId}` : null;
        const prAuthor = prKey ? prAuthorByKey.get(prKey) : undefined;
        // Exclude self-reviews when PR author is known from a mirrored OPENED event; otherwise count.
        if (prAuthor && prAuthor === reviewer) continue;
        const agg = ensure(row.reviewerLogin);
        if (agg) agg.reviewsGiven += 1;
      }

      // Read-time identity resolution (verified IntegrationConnection.externalAccountLogin of workspace members).
      const identityCandidates = await prisma.integrationConnection.findMany({
        where: {
          workspaceId: input.workspaceId,
          provider: 'GITHUB',
          status: 'ACTIVE',
          externalAccountLogin: { not: null },
          createdBy: {
            workspaceMemberships: {
              some: { workspaceId: input.workspaceId, status: 'ACTIVE' },
            },
          },
        },
        select: {
          externalAccountLogin: true,
          createdBy: { select: { id: true, name: true } },
        },
      });
      const candidates = identityCandidates.map((c) => ({
        userId: c.createdBy.id,
        name: c.createdBy.name,
        externalAccountLogin: c.externalAccountLogin,
      }));

      const displayLoginByLower = new Map<string, string>();
      for (const row of [...commitRows, ...prOpenedRows, ...prMergedRows]) {
        const raw = (row.authorLogin ?? '').trim();
        if (raw) displayLoginByLower.set(raw.toLowerCase(), raw);
      }
      for (const row of reviewRows) {
        const raw = (row.reviewerLogin ?? '').trim();
        if (raw && !displayLoginByLower.has(raw.toLowerCase())) displayLoginByLower.set(raw.toLowerCase(), raw);
      }

      const developers = Array.from(byLogin.entries())
        .map(([lowerLogin, agg]) => {
          const providerLogin = displayLoginByLower.get(lowerLogin) ?? lowerLogin;
          const resolved = resolveDevActivityDeveloper({ providerLogin, candidates });
          if (resolved.type === 'workspace_user') {
            return {
              type: 'workspace_user' as const,
              user: resolved.user,
              providerLogin,
              displayName: resolved.user.name ?? providerLogin,
              commits: agg.commits,
              pullRequestsOpened: agg.prsOpened,
              pullRequestsMerged: agg.prsMerged,
              reviewsGiven: agg.reviewsGiven,
            };
          }
          return {
            type: 'unmapped' as const,
            user: null,
            providerLogin,
            displayName: providerLogin,
            commits: agg.commits,
            pullRequestsOpened: agg.prsOpened,
            pullRequestsMerged: agg.prsMerged,
            reviewsGiven: agg.reviewsGiven,
          };
        })
        .filter((d) => d.providerLogin)
        .sort((a, b) => {
          const totalA = a.commits + a.pullRequestsOpened + a.pullRequestsMerged + a.reviewsGiven;
          const totalB = b.commits + b.pullRequestsOpened + b.pullRequestsMerged + b.reviewsGiven;
          if (totalB !== totalA) return totalB - totalA;
          return a.displayName.localeCompare(b.displayName);
        });

      return {
        range: { from: from.toISOString(), to: to.toISOString() },
        coverageStartedAt,
        developers,
      };
    },
  };
}

export type DevIntegrationService = ReturnType<typeof createDevIntegrationService>;
