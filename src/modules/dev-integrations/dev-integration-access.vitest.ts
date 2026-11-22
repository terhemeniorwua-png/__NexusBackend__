/* eslint-disable @typescript-eslint/no-explicit-any -- mocked prisma/service shapes for unit tests */
// @ts-expect-error vitest types are provided by the vitest runner, not tsconfig.test.json types
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../authorization', () => ({
  ProjectPermission: { View: 'project.view', Update: 'project.update', TaskUpdate: 'project.task.update' },
  authorizeProject: vi.fn(async () => ({})),
  requireWorkspaceAccess: vi.fn(async () => ({ effectiveRole: 'MEMBER' })),
  WorkspaceCapability: { ViewWorkspace: 'workspace.view', UpdateWorkspace: 'workspace.update' },
}));

vi.mock('./repository-access.resolver', () => ({
  resolveRepositoryAccess: vi.fn(),
}));

vi.mock('./providers/github-app.provider', () => ({
  githubAppProvider: {
    listRepositoryBranches: vi.fn(async () => [{ name: 'main' }]),
    listRepositoryPullRequests: vi.fn(async () => []),
    getPullRequest: vi.fn(async () => ({})),
    listPullRequestFiles: vi.fn(async () => []),
    listPullRequestCommits: vi.fn(async () => []),
    listBranchCommits: vi.fn(async () => []),
    getCommit: vi.fn(async () => ({})),
  },
}));

vi.mock('./providers/gitlab.provider', () => ({
  gitlabProvider: {
    listRepositoryBranches: vi.fn(async () => []),
  },
}));

import { createDevIntegrationService } from './dev-integration.service';
import { resolveRepositoryAccess } from './repository-access.resolver';

const config: any = { frontendUrl: 'http://localhost:3000', corsOrigins: ['http://localhost:3000'] };

const baseRepoRow = {
  id: 'repo-1',
  projectId: 'proj-1',
  connectionId: 'conn-1',
  provider: 'GITHUB',
  externalRepoId: '123',
  fullName: 'acme/private-repo',
  defaultBranch: 'main',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  connection: { id: 'conn-1', status: 'ACTIVE', encryptedCredentials: 'enc' },
};

const baseLinkRow = {
  id: 'link-1',
  taskId: 'task-1',
  projectId: 'proj-1',
  projectRepositoryId: 'repo-1',
  provider: 'GITHUB',
  externalType: 'PULL_REQUEST',
  externalId: 'pr-1',
  externalNumber: 42,
  title: 'Secret PR title',
  url: 'https://github.com/acme/private-repo/pull/42',
  ref: null,
  headRef: 'feat/secret',
  baseRef: 'main',
  state: 'open',
  repositoryFullName: 'acme/private-repo',
  reviewState: 'APPROVED',
  reviewerLogin: 'alice',
  reviewedAt: new Date('2026-01-02T00:00:00Z'),
  mergedAt: null,
  linkedById: 'user-1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    projectRepository: {
      findMany: vi.fn(async () => [baseRepoRow]),
      findFirst: vi.fn(async () => baseRepoRow),
    },
    taskDevLink: {
      findMany: vi.fn(async () => [baseLinkRow]),
      findFirst: vi.fn(async () => baseLinkRow),
      create: vi.fn(async ({ data }: any) => ({ ...baseLinkRow, ...data, id: 'link-new', createdAt: new Date(), updatedAt: new Date() })),
      delete: vi.fn(async () => ({})),
    },
    task: { findFirst: vi.fn(async () => ({ id: 'task-1', projectId: 'proj-1' })) },
    ...overrides,
  } as any;
}

describe('BE-9 stage 2 repository access enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listProjectRepositories', () => {
    it('omits NONE repositories', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('NONE');
      const svc = createDevIntegrationService(config, makePrisma());
      const out = await svc.listProjectRepositories({ userId: 'u1', workspaceId: 'w1', projectId: 'proj-1' });
      expect(out).toEqual([]);
    });

    it('masks METADATA repositories', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('METADATA');
      const svc = createDevIntegrationService(config, makePrisma());
      const [repo] = await svc.listProjectRepositories({ userId: 'u1', workspaceId: 'w1', projectId: 'proj-1' });
      expect(repo!.fullName).toBe('Restricted repository');
      expect(repo!.defaultBranch).toBeNull();
      expect(repo!.externalRepoId).toBe('restricted');
      expect(repo!.id).toBe('repo-1');
      expect(repo!.provider).toBe('GITHUB');
      expect(repo!.effectiveAccessLevel).toBe('METADATA');
    });

    it('returns full repository for READ', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('READ');
      const svc = createDevIntegrationService(config, makePrisma());
      const [repo] = await svc.listProjectRepositories({ userId: 'u1', workspaceId: 'w1', projectId: 'proj-1' });
      expect(repo!.fullName).toBe('acme/private-repo');
      expect(repo!.externalRepoId).toBe('123');
      expect(repo!.effectiveAccessLevel).toBe('READ');
    });

    it('returns full repository for LINK', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('LINK');
      const svc = createDevIntegrationService(config, makePrisma());
      const [repo] = await svc.listProjectRepositories({ userId: 'u1', workspaceId: 'w1', projectId: 'proj-1' });
      expect(repo!.fullName).toBe('acme/private-repo');
      expect(repo!.effectiveAccessLevel).toBe('LINK');
    });

    it('explicit override beats default (resolver returns METADATA)', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('METADATA');
      const svc = createDevIntegrationService(config, makePrisma());
      const [repo] = await svc.listProjectRepositories({ userId: 'u1', workspaceId: 'w1', projectId: 'proj-1' });
      expect(repo!.fullName).toBe('Restricted repository');
    });

    it('no project access resolves as NONE (omitted)', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('NONE');
      const svc = createDevIntegrationService(config, makePrisma());
      const out = await svc.listProjectRepositories({ userId: 'u1', workspaceId: 'w1', projectId: 'proj-1' });
      expect(out).toEqual([]);
    });
  });

  describe('repository browse/content endpoints (getActiveLinkedRepository)', () => {
    const callBranches = (svc: any) =>
      svc.listRepositoryBranches({ userId: 'u1', workspaceId: 'w1', projectId: 'proj-1', repositoryId: 'repo-1' });

    it('NONE returns missing-repo 404 shape', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('NONE');
      const svc = createDevIntegrationService(config, makePrisma());
      await expect(callBranches(svc)).rejects.toMatchObject({ statusCode: 404, code: 'PROJECT_REPOSITORY_NOT_FOUND' });
    });

    it('METADATA returns missing-repo 404 shape', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('METADATA');
      const svc = createDevIntegrationService(config, makePrisma());
      await expect(callBranches(svc)).rejects.toMatchObject({ statusCode: 404, code: 'PROJECT_REPOSITORY_NOT_FOUND' });
    });

    it('READ allows read endpoint', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('READ');
      const prisma = makePrisma();
      const svc = createDevIntegrationService(config, prisma);
      await expect(callBranches(svc)).resolves.toEqual([{ name: 'main' }]);
    });

    it('LINK allows read endpoint', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('LINK');
      const prisma = makePrisma();
      const svc = createDevIntegrationService(config, prisma);
      await expect(callBranches(svc)).resolves.toEqual([{ name: 'main' }]);
    });

    it('explicit override beating default is enforced (override METADATA blocks content)', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('METADATA'); // override beats default
      const svc = createDevIntegrationService(config, makePrisma());
      await expect(callBranches(svc)).rejects.toMatchObject({ statusCode: 404, code: 'PROJECT_REPOSITORY_NOT_FOUND' });
    });

    it('no project access returns missing-repo 404 shape', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('NONE'); // resolver returns NONE for no project access
      const svc = createDevIntegrationService(config, makePrisma());
      await expect(callBranches(svc)).rejects.toMatchObject({ statusCode: 404, code: 'PROJECT_REPOSITORY_NOT_FOUND' });
    });
  });

  describe('listTaskDevLinks', () => {
    it('omits NONE dev links', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('NONE');
      const svc = createDevIntegrationService(config, makePrisma());
      const out = await svc.listTaskDevLinks({ userId: 'u1', workspaceId: 'w1', projectId: 'proj-1', taskId: 'task-1' });
      expect(out).toEqual([]);
    });

    it('redacts METADATA dev links to masked repo name and state only', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('METADATA');
      const svc = createDevIntegrationService(config, makePrisma());
      const [link] = await svc.listTaskDevLinks({ userId: 'u1', workspaceId: 'w1', projectId: 'proj-1', taskId: 'task-1' });
      expect(link!.repositoryFullName).toBe('Restricted repository');
      expect(link!.state).toBe('open');
      expect(link!.effectiveAccessLevel).toBe('METADATA');
      expect(link!.title).toBeNull();
      expect(link!.url).toBeNull();
      expect(link!.ref).toBeNull();
      expect(link!.headRef).toBeNull();
      expect(link!.baseRef).toBeNull();
      expect(link!.externalNumber).toBeNull();
      expect(link!.reviewState).toBeNull();
      expect(link!.reviewerLogin).toBeNull();
      expect(link!.reviewedAt).toBeNull();
      expect(link!.mergedAt).toBeNull();
      expect(link!.externalId).toBe('restricted');
    });

    it('returns full dev link for READ', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('READ');
      const svc = createDevIntegrationService(config, makePrisma());
      const [link] = await svc.listTaskDevLinks({ userId: 'u1', workspaceId: 'w1', projectId: 'proj-1', taskId: 'task-1' });
      expect(link!.repositoryFullName).toBe('acme/private-repo');
      expect(link!.title).toBe('Secret PR title');
      expect(link!.url).toContain('github.com');
      expect(link!.effectiveAccessLevel).toBe('READ');
    });

    it('returns full dev link for LINK', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('LINK');
      const svc = createDevIntegrationService(config, makePrisma());
      const [link] = await svc.listTaskDevLinks({ userId: 'u1', workspaceId: 'w1', projectId: 'proj-1', taskId: 'task-1' });
      expect(link!.repositoryFullName).toBe('acme/private-repo');
    });
  });

  describe('linkTaskDevLink', () => {
    const payload = {
      userId: 'u1', workspaceId: 'w1', projectId: 'proj-1', taskId: 'task-1',
      projectRepositoryId: 'repo-1', externalType: 'PULL_REQUEST' as const, externalId: 'pr-1',
    };

    it('NONE returns missing-repo 404 shape', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('NONE');
      const svc = createDevIntegrationService(config, makePrisma());
      await expect(svc.linkTaskDevLink(payload)).rejects.toMatchObject({ statusCode: 404, code: 'PROJECT_REPOSITORY_NOT_FOUND' });
    });

    it('METADATA returns 403 forbidden convention', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('METADATA');
      const svc = createDevIntegrationService(config, makePrisma());
      await expect(svc.linkTaskDevLink(payload)).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    });

    it('READ returns 403 forbidden convention', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('READ');
      const svc = createDevIntegrationService(config, makePrisma());
      await expect(svc.linkTaskDevLink(payload)).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    });

    it('LINK allows linking', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('LINK');
      const svc = createDevIntegrationService(config, makePrisma());
      const out = await svc.linkTaskDevLink(payload);
      expect(out.taskId).toBe('task-1');
    });
  });

  describe('unlinkTaskDevLink', () => {
    const payload = { userId: 'u1', workspaceId: 'w1', projectId: 'proj-1', taskId: 'task-1', devLinkId: 'link-1' };

    it('NONE returns missing-repo 404 shape', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('NONE');
      const svc = createDevIntegrationService(config, makePrisma());
      await expect(svc.unlinkTaskDevLink(payload)).rejects.toMatchObject({ statusCode: 404, code: 'PROJECT_REPOSITORY_NOT_FOUND' });
    });

    it('METADATA returns 403 forbidden convention', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('METADATA');
      const svc = createDevIntegrationService(config, makePrisma());
      await expect(svc.unlinkTaskDevLink(payload)).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    });

    it('READ returns 403 forbidden convention', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('READ');
      const svc = createDevIntegrationService(config, makePrisma());
      await expect(svc.unlinkTaskDevLink(payload)).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    });

    it('LINK allows unlinking', async () => {
      (resolveRepositoryAccess as any).mockResolvedValue('LINK');
      const svc = createDevIntegrationService(config, makePrisma());
      const out = await svc.unlinkTaskDevLink(payload);
      expect(out).toEqual({ ok: true });
    });
  });
});
