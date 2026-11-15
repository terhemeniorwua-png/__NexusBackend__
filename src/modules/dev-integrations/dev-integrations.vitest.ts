// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies before imports that use them
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createSign: () => ({
      update: () => undefined,
      end: () => undefined,
      sign: () => Buffer.from('fakesignature'),
    }),
  };
});

vi.mock('../../db/prisma', () => ({ getPrismaClient: vi.fn() }));
vi.mock('../../db/redis', () => ({ getRedisClient: vi.fn() }));
vi.mock('../../services/audit', () => ({ recordAuditEvent: vi.fn(async () => undefined) }));
vi.mock('../authorization', () => ({
  requireWorkspaceAccess: vi.fn(async () => ({ effectiveRole: 'ADMIN', workspace: { id: 'ws' }, membership: { id: 'm' } })),
  authorizeProject: vi.fn(async () => ({})),
  WorkspaceCapability: { ViewWorkspace: 'workspace:view', UpdateWorkspace: 'workspace:update' },
  ProjectPermission: { View: 'project.view', Update: 'project.update' },
}));
vi.mock('../integrations/token-crypto', () => ({
  encryptIntegrationToken: (v: string) => `enc:${Buffer.from(v, 'utf8').toString('base64url')}`,
  decryptIntegrationToken: (v: string) => {
    if (!v.startsWith('enc:')) throw new Error('bad token');
    return Buffer.from(v.slice(4), 'base64url').toString('utf8');
  },
}));

import { createHmac } from 'node:crypto';
import { AppError } from '../../utils/errors';
import { githubAppProvider } from './providers/github-app.provider';
import { createDevIntegrationService } from './dev-integration.service';
import { getRedisClient } from '../../db/redis';
import { requireWorkspaceAccess, authorizeProject } from '../authorization';

const config: any = {
  jwtAccessSecret: 'test-access-secret-1234567890-test',
  githubAppId: '12345',
  githubAppSlug: 'nexus-test',
  githubAppClientId: 'Iv1.client',
  githubAppClientSecret: 'secret',
  githubAppPrivateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALri\n-----END RSA PRIVATE KEY-----',
  githubAppCallbackUrl: 'http://localhost:4000/api/v1/dev-integrations/github/callback',
  githubAppInstallUrl: 'https://github.com/apps/nexus-test/installations/new',
  frontendUrl: 'http://localhost:3000',
  corsOrigins: ['http://localhost:3000'],
};

function signState(body: string): string {
  return createHmac('sha256', Buffer.from(config.jwtAccessSecret, 'utf8')).update(body).digest('base64url');
}

function makeState(nonce = '0123456789abcdef0123456789abcdef', expMs = 10 * 60 * 1000) {
  const claims = {
    userId: '11111111-1111-1111-1111-111111111111',
    workspaceId: '22222222-2222-2222-2222-222222222222',
    provider: 'GITHUB',
    nonce,
    exp: Date.now() + expMs,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { state: `${body}.${signState(body)}`, claims, body };
}

describe('GitHub App dev-integration provider (Feature A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_ACCESS_SECRET = config.jwtAccessSecret;
  });

  it('creates install URL with signed state and stores one-time nonce in redis', async () => {
    const redis = { set: vi.fn(async () => 'OK'), get: vi.fn(), del: vi.fn() };
    (getRedisClient as any).mockReturnValue(redis);
    const res = await githubAppProvider.startConnect({
      config,
      userId: '11111111-1111-1111-1111-111111111111',
      workspaceId: '22222222-2222-2222-2222-222222222222',
    });
    expect(res.url).toContain('https://github.com/apps/nexus-test/installations/new');
    const u = new URL(res.url);
    const state = u.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, value, opts] = redis.set.mock.calls[0];
    expect(key).toMatch(/^devint:github:state:[0-9a-f]{32}$/);
    expect(JSON.parse(value)).toEqual({
      userId: '11111111-1111-1111-1111-111111111111',
      workspaceId: '22222222-2222-2222-2222-222222222222',
    });
    expect(opts).toEqual({ EX: 600 });
  });

  it('rejects invalid, tampered, expired, mismatched, or reused state', async () => {
    const { state, claims } = makeState();
    const redis = {
      get: vi.fn(async (k: string) => (k.endsWith(claims.nonce) ? JSON.stringify({ userId: claims.userId, workspaceId: claims.workspaceId }) : null)),
      del: vi.fn(async () => 1),
      set: vi.fn(),
    };
    (getRedisClient as any).mockReturnValue(redis);

    await expect(githubAppProvider.verifyAndConsumeState('bad.state')).rejects.toMatchObject({ code: 'GITHUB_STATE_INVALID' });

    const tampered = state.slice(0, -2) + 'aa';
    await expect(githubAppProvider.verifyAndConsumeState(tampered)).rejects.toMatchObject({ code: 'GITHUB_STATE_INVALID' });

    const expired = makeState('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', -1000).state;
    await expect(githubAppProvider.verifyAndConsumeState(expired)).rejects.toMatchObject({ code: 'GITHUB_STATE_INVALID' });

    redis.get.mockResolvedValueOnce(null);
    redis.del.mockResolvedValueOnce(0);
    const fresh = makeState('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb').state;
    await expect(githubAppProvider.verifyAndConsumeState(fresh)).rejects.toMatchObject({ code: 'GITHUB_STATE_INVALID' });

    const { state: s2, claims: c2 } = makeState('cccccccccccccccccccccccccccccccc');
    redis.get.mockResolvedValueOnce(JSON.stringify({ userId: 'other', workspaceId: c2.workspaceId }));
    redis.del.mockResolvedValueOnce(1);
    await expect(githubAppProvider.verifyAndConsumeState(s2)).rejects.toMatchObject({ code: 'GITHUB_STATE_INVALID' });
  });

  it('consumes valid state once and returns claims', async () => {
    const { state, claims } = makeState('dddddddddddddddddddddddddddddddd');
    const redis = {
      get: vi.fn(async () => JSON.stringify({ userId: claims.userId, workspaceId: claims.workspaceId })),
      del: vi.fn(async () => 1),
      set: vi.fn(),
    };
    (getRedisClient as any).mockReturnValue(redis);
    const out = await githubAppProvider.verifyAndConsumeState(state);
    expect(out).toEqual({ userId: claims.userId, workspaceId: claims.workspaceId, provider: 'GITHUB', nonce: claims.nonce });
    expect(redis.del).toHaveBeenCalledWith(`devint:github:state:${claims.nonce}`);
  });

  it('encrypts credentials at rest and never exposes secrets in callback result', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/app/installations/42')) {
        return new Response(JSON.stringify({ id: 42, account: { id: 7, login: 'acme', type: 'Organization', name: 'Acme' }, permissions: { contents: 'read', metadata: 'read' } }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const claims = { userId: 'u', workspaceId: 'w', provider: 'GITHUB' as const, nonce: 'n' };
    const result = await githubAppProvider.handleCallback({ config, query: { installation_id: '42', state: 'x' }, claims });
    expect(result.externalAccount).toEqual({ id: '7', login: 'acme', name: 'Acme', type: 'Organization' });
    expect(result.scopes).toEqual(['contents', 'metadata']);
    expect(result.encryptedCredentials).toMatch(/^enc:/);
    expect(result.encryptedCredentials).not.toContain('installationId');
    expect(result.encryptedCredentials).not.toContain('acme');
    const plain = JSON.parse(Buffer.from(result.encryptedCredentials.slice(4), 'base64url').toString('utf8'));
    expect(plain.installationId).toBe(42);
    expect(JSON.stringify(result)).not.toContain(config.githubAppPrivateKey);
    expect(JSON.stringify(result)).not.toContain(config.githubAppClientSecret);
  });

  it('requires installation_id on callback', async () => {
    const claims = { userId: 'u', workspaceId: 'w', provider: 'GITHUB' as const, nonce: 'n' };
    await expect(githubAppProvider.handleCallback({ config, query: { state: 'x' }, claims })).rejects.toMatchObject({ code: 'GITHUB_INSTALLATION_REQUIRED' });
  });
});

describe('Dev integration service permissions and behavior', () => {
  const workspaceId = '22222222-2222-2222-2222-222222222222';
  const userId = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects listing connections when workspace access denied', async () => {
    (requireWorkspaceAccess as any).mockRejectedValueOnce(new AppError(403, 'WORKSPACE_ACCESS_DENIED', 'denied'));
    const svc = createDevIntegrationService(config, { integrationConnection: { findMany: vi.fn(async () => []) } } as any);
    await expect(svc.listConnections({ userId, workspaceId })).rejects.toMatchObject({ code: 'WORKSPACE_ACCESS_DENIED' });
  });

  it('returns connection summaries without encrypted credentials', async () => {
    (requireWorkspaceAccess as any).mockResolvedValueOnce({ effectiveRole: 'MEMBER' });
    const prisma: any = {
      integrationConnection: {
        findMany: vi.fn(async () => ([{
          id: 'conn-1', provider: 'GITHUB', workspaceId, status: 'ACTIVE',
          externalAccountId: '7', externalAccountLogin: 'acme', externalAccountName: 'Acme',
          scopes: ['contents:read'], createdById: userId, lastError: null,
          createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
          encryptedCredentials: 'enc:secret-payload',
        }])),
      },
    };
    const svc = createDevIntegrationService(config, prisma);
    const list = await svc.listConnections({ userId, workspaceId });
    expect(list).toHaveLength(1);
    expect((list[0] as any).encryptedCredentials).toBeUndefined();
    expect(JSON.stringify(list)).not.toContain('enc:secret-payload');
    expect(list[0].externalAccount.login).toBe('acme');
  });

  it('enforces workspace manager capability for connect start', async () => {
    (requireWorkspaceAccess as any).mockRejectedValueOnce(new AppError(403, 'INSUFFICIENT_ROLE', 'not manager'));
    const svc = createDevIntegrationService(config, {} as any);
    await expect(svc.startGithubConnect({ userId, workspaceId })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('enforces project update permission for repo linking', async () => {
    (requireWorkspaceAccess as any).mockResolvedValueOnce({ effectiveRole: 'MEMBER' });
    (authorizeProject as any).mockRejectedValueOnce(new AppError(403, 'PROJECT_PERMISSION_DENIED', 'no'));
    const svc = createDevIntegrationService(config, { project: { findFirst: vi.fn() }, integrationConnection: { findFirst: vi.fn() } } as any);
    await expect(svc.linkRepository({ userId, workspaceId, projectId: 'p1', connectionId: 'c1', externalRepoId: '1', fullName: 'a/b' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('lists repository branches and pull requests via mocked GitHub API (no network secrets)', async () => {
    const encCreds = 'enc:' + Buffer.from(JSON.stringify({ installationId: 42, account: { id: '7', login: 'acme' } }), 'utf8').toString('base64url');
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/app/installations/42/access_tokens')) {
        return new Response(JSON.stringify({ token: 'inst-token' }), { status: 200 });
      }
      if (String(url).includes('/repos/acme/app/branches')) {
        return new Response(JSON.stringify([
          { name: 'main', commit: { sha: 'abc123' }, protected: true },
          { name: 'feat/x', commit: { sha: 'def456' }, protected: false },
        ]), { status: 200 });
      }
      if (String(url).includes('/repos/acme/app/pulls')) {
        return new Response(JSON.stringify([
          { id: 99, number: 12, title: 'Add thing', state: 'open', html_url: 'https://github.com/acme/app/pull/12', head: { ref: 'feat/x' }, base: { ref: 'main' }, user: { login: 'dev' }, updated_at: '2026-01-01T00:00:00Z', merged_at: null, draft: false },
        ]), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const branches = await githubAppProvider.listRepositoryBranches({ config, encryptedCredentials: encCreds, repositoryFullName: 'acme/app' });
    expect(branches).toEqual([
      { name: 'main', commitSha: 'abc123', protected: true, url: 'https://github.com/acme/app/tree/main' },
      { name: 'feat/x', commitSha: 'def456', protected: false, url: 'https://github.com/acme/app/tree/feat%2Fx' },
    ]);

    const prs = await githubAppProvider.listRepositoryPullRequests({ config, encryptedCredentials: encCreds, repositoryFullName: 'acme/app', state: 'open' });
    expect(prs[0]).toMatchObject({ externalId: '99', number: 12, title: 'Add thing', state: 'open', headRef: 'feat/x', baseRef: 'main', authorLogin: 'dev' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('rejects invalid repository names for dev resource browsing', async () => {
    const encCreds = 'enc:' + Buffer.from(JSON.stringify({ installationId: 1 }), 'utf8').toString('base64url');
    await expect(githubAppProvider.listRepositoryBranches({ config, encryptedCredentials: encCreds, repositoryFullName: 'badname' } as any)).rejects.toMatchObject({ code: 'INVALID_REPOSITORY_NAME' });
  });
});

describe('Task dev links service (Feature B)', () => {
  const workspaceId = '22222222-2222-2222-2222-222222222222';
  const userId = '11111111-1111-1111-1111-111111111111';
  const projectId = '33333333-3333-3333-3333-333333333333';
  const taskId = '44444444-4444-4444-4444-444444444444';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists task dev links without leaking credentials and requires view access', async () => {
    (requireWorkspaceAccess as any).mockResolvedValue({ effectiveRole: 'MEMBER' });
    (authorizeProject as any).mockResolvedValue({});
    const prisma: any = {
      task: { findFirst: vi.fn(async () => ({ id: taskId, projectId })) },
      taskDevLink: {
        findMany: vi.fn(async () => ([{
          id: 'l1', taskId, projectId, projectRepositoryId: 'r1', provider: 'GITHUB', externalType: 'BRANCH',
          externalId: 'main', externalNumber: null, title: 'main', url: 'https://x', ref: 'main', headRef: null, baseRef: null, state: null,
          repositoryFullName: 'acme/app', linkedById: userId, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
        }])),
      },
    };
    const svc = createDevIntegrationService(config, prisma);
    const links = await svc.listTaskDevLinks({ userId, workspaceId, projectId, taskId });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ externalType: 'BRANCH', externalId: 'main', repositoryFullName: 'acme/app' });
    expect(JSON.stringify(links)).not.toContain('encryptedCredentials');
  });

  it('enforces task update permission when linking dev items', async () => {
    (requireWorkspaceAccess as any).mockResolvedValue({ effectiveRole: 'MEMBER' });
    (authorizeProject as any).mockRejectedValue(new AppError(403, 'PROJECT_PERMISSION_DENIED', 'no'));
    const svc = createDevIntegrationService(config, { task: { findFirst: vi.fn(async () => ({ id: taskId, projectId })) } } as any);
    await expect(svc.linkTaskDevLink({ userId, workspaceId, projectId, taskId, projectRepositoryId: 'r1', externalType: 'BRANCH', externalId: 'main' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects duplicate task dev links', async () => {
    (requireWorkspaceAccess as any).mockResolvedValue({ effectiveRole: 'MEMBER' });
    (authorizeProject as any).mockResolvedValue({});
    const prisma: any = {
      task: { findFirst: vi.fn(async () => ({ id: taskId, projectId })) },
      projectRepository: { findFirst: vi.fn(async () => ({ id: 'r1', projectId, provider: 'GITHUB', fullName: 'acme/app', connection: { status: 'ACTIVE' } })) },
      taskDevLink: { create: vi.fn(async () => { const e: any = new Error('dup'); e.code = 'P2002'; throw e; }) },
    };
    const svc = createDevIntegrationService(config, prisma);
    await expect(svc.linkTaskDevLink({ userId, workspaceId, projectId, taskId, projectRepositoryId: 'r1', externalType: 'BRANCH', externalId: 'main' })).rejects.toMatchObject({ code: 'TASK_DEV_LINK_ALREADY_EXISTS' });
  });

  it('links and unlinks task dev items with audit-safe behavior', async () => {
    (requireWorkspaceAccess as any).mockResolvedValue({ effectiveRole: 'MEMBER' });
    (authorizeProject as any).mockResolvedValue({});
    const created = { id: 'l1', taskId, projectId, projectRepositoryId: 'r1', provider: 'GITHUB', externalType: 'PULL_REQUEST', externalId: '99', externalNumber: 12, title: 'PR', url: 'https://x', ref: 'feat', headRef: 'feat', baseRef: 'main', state: 'open', repositoryFullName: 'acme/app', linkedById: userId, createdAt: new Date(), updatedAt: new Date() };
    const prisma: any = {
      task: { findFirst: vi.fn(async () => ({ id: taskId, projectId })) },
      projectRepository: { findFirst: vi.fn(async () => ({ id: 'r1', projectId, provider: 'GITHUB', fullName: 'acme/app', connection: { status: 'ACTIVE' } })) },
      taskDevLink: {
        create: vi.fn(async () => created),
        findFirst: vi.fn(async () => ({ id: 'l1', taskId, projectId, externalType: 'PULL_REQUEST', externalId: '99' })),
        delete: vi.fn(async () => ({})),
      },
    };
    const svc = createDevIntegrationService(config, prisma);
    const link = await svc.linkTaskDevLink({ userId, workspaceId, projectId, taskId, projectRepositoryId: 'r1', externalType: 'PULL_REQUEST', externalId: '99', externalNumber: 12, title: 'PR' });
    expect(link.externalType).toBe('PULL_REQUEST');
    const out = await svc.unlinkTaskDevLink({ userId, workspaceId, projectId, taskId, devLinkId: 'l1' });
    expect(out).toEqual({ ok: true });
  });


});
