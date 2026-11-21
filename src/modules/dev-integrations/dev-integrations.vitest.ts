/* eslint-disable @typescript-eslint/no-explicit-any */
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


describe('GitHub webhook ingestion (Feature C)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verifies HMAC signatures (constant-time check behavior)', async () => {
    const { verifyGithubWebhookSignature } = await import('./github-webhook.service');
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const sig = 'sha256=' + createHmac('sha256', 'topsecret').update(body).digest('hex');
    expect(verifyGithubWebhookSignature(body, sig, 'topsecret')).toBe(true);
    expect(verifyGithubWebhookSignature(body, sig, 'wrong')).toBe(false);
    expect(verifyGithubWebhookSignature(body, 'sha256=' + '0'.repeat(64), 'topsecret')).toBe(false);
    expect(verifyGithubWebhookSignature(body, undefined, 'topsecret')).toBe(false);
  });

  it('rejects unverified or invalid webhooks', async () => {
    const { processGithubWebhook } = await import('./github-webhook.service');
    const body = Buffer.from(JSON.stringify({ action: 'opened' }));
    const prisma: any = { gitHubWebhookDelivery: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() } };
    await expect(processGithubWebhook({ prisma, rawBody: body, signature: undefined, secret: 's', deliveryId: 'd1', event: 'pull_request' })).resolves.toBe('unverified');
    const bad = await processGithubWebhook({ prisma, rawBody: Buffer.from('{nope'), signature: 'sha256=' + createHmac('sha256', 's').update(Buffer.from('{nope')).digest('hex'), secret: 's', deliveryId: 'd1', event: 'pull_request' });
    expect(bad).toBe('invalid');
  });

  it('is idempotent by delivery id (duplicates do not reapply)', async () => {
    const { processGithubWebhook } = await import('./github-webhook.service');
    const body = Buffer.from(JSON.stringify({ action: 'opened', pull_request: { id: 99, number: 12, title: 'PR', state: 'open', html_url: 'x', head: { ref: 'f' }, base: { ref: 'm' } } }));
    const sig = 'sha256=' + createHmac('sha256', 's').update(body).digest('hex');
    const prisma: any = {
      gitHubWebhookDelivery: {
        create: vi.fn(async () => { const e: any = new Error('dup'); e.code = 'P2002'; throw e; }),
      },
    };
    const out = await processGithubWebhook({ prisma, rawBody: body, signature: sig, secret: 's', deliveryId: 'deliv-1', event: 'pull_request' });
    expect(out).toBe('duplicate');
  });

  it('syncs pull_request state to linked TaskDevLink records', async () => {
    const { processGithubWebhook } = await import('./github-webhook.service');
    const body = Buffer.from(JSON.stringify({ action: 'closed', pull_request: { id: 99, number: 12, title: 'New title', state: 'closed', merged: true, merged_at: '2026-01-01', html_url: 'https://pr/12', head: { ref: 'feat' }, base: { ref: 'main' } } }));
    const sig = 'sha256=' + createHmac('sha256', 's').update(body).digest('hex');
    const prisma: any = {
      gitHubWebhookDelivery: {
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
      taskDevLink: {
        updateMany: vi.fn(async () => ({ count: 2 })),
      },
    };
    const out = await processGithubWebhook({ prisma, rawBody: body, signature: sig, secret: 's', deliveryId: 'd2', event: 'pull_request' });
    expect(out).toBe('processed');
    expect(prisma.taskDevLink.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { provider: 'GITHUB', externalType: 'PULL_REQUEST', externalId: '99' },
      data: expect.objectContaining({ state: 'merged', externalNumber: 12, title: 'New title', headRef: 'feat', baseRef: 'main' }),
    }));
    expect(prisma.gitHubWebhookDelivery.update).toHaveBeenCalled();
  });

  it('disconnects matching GitHub installation connections on installation deleted', async () => {
    const { processGithubWebhook } = await import('./github-webhook.service');
    const body = Buffer.from(JSON.stringify({ action: 'deleted', installation: { id: 42 } }));
    const sig = 'sha256=' + createHmac('sha256', 's').update(body).digest('hex');
    const enc = 'enc:' + Buffer.from(JSON.stringify({ installationId: 42 }), 'utf8').toString('base64url');
    const otherEnc = 'enc:' + Buffer.from(JSON.stringify({ installationId: 99 }), 'utf8').toString('base64url');
    const prisma: any = {
      gitHubWebhookDelivery: {
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
      integrationConnection: {
        findMany: vi.fn(async () => ([{ id: 'c1', encryptedCredentials: enc }, { id: 'c2', encryptedCredentials: otherEnc }])),
        update: vi.fn(async () => ({})),
      },
    };
    const out = await processGithubWebhook({ prisma, rawBody: body, signature: sig, secret: 's', deliveryId: 'd3', event: 'installation' });
    expect(out).toBe('processed');
    expect(prisma.integrationConnection.update).toHaveBeenCalledTimes(1);
    expect(prisma.integrationConnection.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'c1' },
      data: expect.objectContaining({ status: 'DISCONNECTED' }),
    }));
  });
});


  it('moves linked CHANGES_REQUESTED task to SUBMITTED on merged PR', async () => {
    const { processGithubWebhook } = await import('./github-webhook.service');
    const { recordAuditEvent } = await import('../../services/audit');
    vi.mocked(recordAuditEvent).mockResolvedValue(undefined);
    const body = Buffer.from(JSON.stringify({
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      pull_request: {
        id: 556,
        number: 43,
        title: 'Fix again',
        state: 'closed',
        merged: true,
        html_url: 'https://github.com/owner/repo/pull/43',
        head: { ref: 'fix2' },
        base: { ref: 'main' },
      },
    }));
    const sig = 'sha256=' + createHmac('sha256', 's').update(body).digest('hex');
    const txTaskUpdateMany = vi.fn(async () => ({ count: 1 }));
    const prisma: any = {
      gitHubWebhookDelivery: {
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
      taskDevLink: {
        findMany: vi.fn(async () => ([{
          id: 'link-2',
          taskId: 'task-2',
          externalId: '556',
          linkedById: 'linker-2',
          task: { id: 'task-2', status: 'CHANGES_REQUESTED', key: 'T-2', projectId: 'proj-1', project: { workspaceId: 'ws-1' } },
        }])),
      },
      $transaction: vi.fn(async (fn: any) => fn({
        taskDevLink: { update: vi.fn(async () => ({})), findUnique: vi.fn() },
        task: { updateMany: txTaskUpdateMany },
      })),
    };
    const out = await processGithubWebhook({ prisma, rawBody: body, signature: sig, secret: 's', deliveryId: 'deliv-merge-2', event: 'pull_request' });
    expect(out).toBe('processed');
    expect(txTaskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-2', status: { in: ['IN_PROGRESS', 'CHANGES_REQUESTED'] } },
      data: expect.objectContaining({ status: 'SUBMITTED' }),
    }));
  });

  it('does not move ASSIGNED task on merged PR', async () => {
    const { processGithubWebhook } = await import('./github-webhook.service');
    const body = Buffer.from(JSON.stringify({
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      pull_request: {
        id: 557,
        number: 44,
        title: 'Fix three',
        state: 'closed',
        merged: true,
        html_url: 'https://github.com/owner/repo/pull/44',
        head: { ref: 'fix3' },
        base: { ref: 'main' },
      },
    }));
    const sig = 'sha256=' + createHmac('sha256', 's').update(body).digest('hex');
    const txTaskUpdateMany = vi.fn(async () => ({ count: 0 }));
    const prisma: any = {
      gitHubWebhookDelivery: {
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
      taskDevLink: {
        findMany: vi.fn(async () => ([{
          id: 'link-3',
          taskId: 'task-3',
          externalId: '557',
          linkedById: 'linker-3',
          task: { id: 'task-3', status: 'ASSIGNED', key: 'T-3', projectId: 'proj-1', project: { workspaceId: 'ws-1' } },
        }])),
      },
      $transaction: vi.fn(async (fn: any) => fn({
        taskDevLink: { update: vi.fn(async () => ({})), findUnique: vi.fn() },
        task: { updateMany: txTaskUpdateMany },
      })),
    };
    const out = await processGithubWebhook({ prisma, rawBody: body, signature: sig, secret: 's', deliveryId: 'deliv-merge-3', event: 'pull_request' });
    expect(out).toBe('processed');
    expect(txTaskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-3', status: { in: ['IN_PROGRESS', 'CHANGES_REQUESTED'] } },
    }));
  });

  it('produces one transition for concurrent-style double processing via conditional update (idempotent status change)', async () => {
    const { processGithubWebhook } = await import('./github-webhook.service');
    const { recordAuditEvent } = await import('../../services/audit');
    vi.mocked(recordAuditEvent).mockResolvedValue(undefined);
    const body = Buffer.from(JSON.stringify({
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      pull_request: {
        id: 558,
        number: 45,
        state: 'closed',
        merged: true,
        html_url: 'https://github.com/owner/repo/pull/45',
        head: { ref: 'fix4' },
        base: { ref: 'main' },
      },
    }));
    const sig = 'sha256=' + createHmac('sha256', 's').update(body).digest('hex');
    const txTaskUpdateMany = vi.fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const prisma: any = {
      gitHubWebhookDelivery: {
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
      taskDevLink: {
        findMany: vi.fn(async () => ([{
          id: 'link-4',
          taskId: 'task-4',
          externalId: '558',
          linkedById: 'linker-4',
          task: { id: 'task-4', status: 'IN_PROGRESS', key: 'T-4', projectId: 'proj-1', project: { workspaceId: 'ws-1' } },
        }])),
      },
      $transaction: vi.fn(async (fn: any) => fn({
        taskDevLink: { update: vi.fn(async () => ({})), findUnique: vi.fn() },
        task: { updateMany: txTaskUpdateMany },
      })),
    };
    const out1 = await processGithubWebhook({ prisma, rawBody: body, signature: sig, secret: 's', deliveryId: 'deliv-merge-4a', event: 'pull_request' });
    const out2 = await processGithubWebhook({ prisma, rawBody: body, signature: sig, secret: 's', deliveryId: 'deliv-merge-4b', event: 'pull_request' });
    expect(out1).toBe('processed');
    expect(out2).toBe('processed');
    expect(txTaskUpdateMany).toHaveBeenCalledTimes(2);
  });


  it('sets submittedById to linkedById and submittedAt on merge; does not null feedback/summary/review fields', async () => {
    const { processGithubWebhook } = await import('./github-webhook.service');
    const { recordAuditEvent } = await import('../../services/audit');
    vi.mocked(recordAuditEvent).mockResolvedValue(undefined);
    const body = Buffer.from(JSON.stringify({
      action: 'closed',
      repository: { full_name: 'owner/repo' },
      pull_request: {
        id: 559,
        number: 46,
        state: 'closed',
        merged: true,
        html_url: 'https://github.com/owner/repo/pull/46',
        head: { ref: 'fix5' },
        base: { ref: 'main' },
      },
    }));
    const sig = 'sha256=' + createHmac('sha256', 's').update(body).digest('hex');
    const txTaskUpdateMany = vi.fn(async () => ({ count: 1 }));
    const prisma: any = {
      gitHubWebhookDelivery: {
        create: vi.fn(async () => ({})),
        update: vi.fn(async () => ({})),
      },
      taskDevLink: {
        findMany: vi.fn(async () => ([{
          id: 'link-5',
          taskId: 'task-5',
          externalId: '559',
          linkedById: 'user-linker-1',
          task: { id: 'task-5', status: 'IN_PROGRESS', key: 'T-5', projectId: 'proj-1', project: { workspaceId: 'ws-1' } },
        }])),
      },
      $transaction: vi.fn(async (fn: any) => fn({
        taskDevLink: { update: vi.fn(async () => ({})), findUnique: vi.fn() },
        task: { updateMany: txTaskUpdateMany },
      })),
    };
    const out = await processGithubWebhook({ prisma, rawBody: body, signature: sig, secret: 's', deliveryId: 'deliv-merge-5', event: 'pull_request' });
    expect(out).toBe('processed');
    expect(txTaskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'SUBMITTED',
        submittedById: 'user-linker-1',
      }),
    }));
    const callData = txTaskUpdateMany.mock.calls[0][0].data;
    expect(callData.submittedAt).toBeInstanceOf(Date);
    expect(callData).not.toHaveProperty('submissionSummary');
    expect(callData).not.toHaveProperty('reviewFeedback');
    expect(callData).not.toHaveProperty('reviewedAt');
    expect(callData).not.toHaveProperty('reviewedById');
  });

describe('GitLab dev-integration provider (Feature D)', () => {
  const gitlabConfig: any = {
    ...config,
    gitlabClientId: 'gl-client',
    gitlabClientSecret: 'gl-secret',
    gitlabCallbackUrl: 'http://localhost:4000/api/v1/dev-integrations/gitlab/callback',
    gitlabBaseUrl: 'https://gitlab.com',
    gitlabScopes: 'read_api read_repository',
    gitlabWebhookSecret: 'gl-hook-secret',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_ACCESS_SECRET = gitlabConfig.jwtAccessSecret;
  });

  it('creates GitLab OAuth URL with signed state and stores one-time nonce in redis', async () => {
    const { gitlabProvider } = await import('./providers/gitlab.provider');
    const redis = { set: vi.fn(async () => 'OK'), get: vi.fn(), del: vi.fn() };
    (getRedisClient as any).mockReturnValue(redis);
    const res = await gitlabProvider.startConnect({
      config: gitlabConfig,
      userId: '11111111-1111-1111-1111-111111111111',
      workspaceId: '22222222-2222-2222-2222-222222222222',
    });
    const u = new URL(res.url);
    expect(u.origin + u.pathname).toBe('https://gitlab.com/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('gl-client');
    expect(u.searchParams.get('redirect_uri')).toBe(gitlabConfig.gitlabCallbackUrl);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toContain('read_api');
    expect(u.searchParams.get('state')).toBeTruthy();
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set.mock.calls[0][0]).toMatch(/^devint:gitlab:state:[0-9a-f]{32}$/);
  });

  it('consumes valid GitLab state once and rejects invalid/tampered/reused state', async () => {
    const { gitlabProvider } = await import('./providers/gitlab.provider');
    const nonce = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const claims = { userId: 'u1', workspaceId: 'w1', provider: 'GITLAB', nonce, exp: Date.now() + 600000 };
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = createHmac('sha256', Buffer.from(gitlabConfig.jwtAccessSecret, 'utf8')).update(body).digest('base64url');
    const state = `${body}.${sig}`;
    const redis = {
      get: vi.fn(async () => JSON.stringify({ userId: 'u1', workspaceId: 'w1' })),
      del: vi.fn(async () => 1),
      set: vi.fn(),
    };
    (getRedisClient as any).mockReturnValue(redis);
    const out = await gitlabProvider.verifyAndConsumeState(state);
    expect(out).toEqual({ userId: 'u1', workspaceId: 'w1', provider: 'GITLAB', nonce });
    await expect(gitlabProvider.verifyAndConsumeState(state + 'x')).rejects.toMatchObject({ code: 'GITLAB_STATE_INVALID' });

    redis.get.mockResolvedValueOnce(null);
    redis.del.mockResolvedValueOnce(0);
    await expect(gitlabProvider.verifyAndConsumeState(state)).rejects.toMatchObject({ code: 'GITLAB_STATE_INVALID' });
  });

  it('exchanges GitLab code for tokens, fetches user, and stores encrypted credentials without secrets', async () => {
    const { gitlabProvider } = await import('./providers/gitlab.provider');
    const fetchMock = vi.fn(async (url: string, _init?: any) => {
      if (String(url).endsWith('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'gl-at', refresh_token: 'gl-rt', token_type: 'Bearer', expires_in: 7200, scope: 'read_api read_repository' }), { status: 200 });
      }
      if (String(url).endsWith('/api/v4/user')) {
        return new Response(JSON.stringify({ id: 77, username: 'gluser', name: 'GL User' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const claims = { userId: 'u', workspaceId: 'w', provider: 'GITLAB' as const, nonce: 'n' };
    const result = await gitlabProvider.handleCallback({ config: gitlabConfig, query: { code: 'abc', state: 'x' }, claims });
    expect(result.externalAccount).toEqual({ id: '77', login: 'gluser', name: 'GL User', type: 'user' });
    expect(result.encryptedCredentials).toMatch(/^enc:/);
    expect(result.encryptedCredentials).not.toContain('gl-at');
    expect(result.encryptedCredentials).not.toContain('gl-secret');
    expect(JSON.stringify(result)).not.toContain(gitlabConfig.gitlabClientSecret);
    const plain = JSON.parse(Buffer.from(result.encryptedCredentials.slice(4), 'base64url').toString('utf8'));
    expect(plain.accessToken).toBe('gl-at');
    expect(plain.baseUrl).toBe('https://gitlab.com');
  });

  it('requires authorization code for GitLab callback', async () => {
    const { gitlabProvider } = await import('./providers/gitlab.provider');
    const claims = { userId: 'u', workspaceId: 'w', provider: 'GITLAB' as const, nonce: 'n' };
    await expect(gitlabProvider.handleCallback({ config: gitlabConfig, query: { state: 'x' }, claims })).rejects.toMatchObject({ code: 'GITLAB_CODE_REQUIRED' });
  });

  it('lists GitLab projects, branches, and merge requests via mocked API', async () => {
    const { gitlabProvider } = await import('./providers/gitlab.provider');
    const encCreds = 'enc:' + Buffer.from(JSON.stringify({ accessToken: 'tok', baseUrl: 'https://gitlab.com', expiresAt: Date.now() + 3600000 }), 'utf8').toString('base64url');
    const fetchMock = vi.fn(async (url: string) => {
      const s = String(url);
      if (s.includes('/api/v4/projects?') || s.endsWith('/api/v4/projects')) {
        return new Response(JSON.stringify([{ id: 101, path_with_namespace: 'group/proj', name: 'proj', namespace: { path: 'group' }, default_branch: 'main', visibility: 'private', web_url: 'https://gitlab.com/group/proj' }]), { status: 200 });
      }
      if (s.includes('/repository/branches')) {
        return new Response(JSON.stringify([{ name: 'main', commit: { id: 'abc123' }, protected: true, web_url: 'https://gitlab.com/group/proj/-/tree/main' }]), { status: 200 });
      }
      if (s.includes('/merge_requests')) {
        return new Response(JSON.stringify([{ id: 9001, iid: 7, title: 'Add feature', state: 'opened', web_url: 'https://gitlab.com/group/proj/-/merge_requests/7', source_branch: 'feat', target_branch: 'main', author: { username: 'dev' }, updated_at: '2026-01-01T00:00:00Z' }]), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const repos = await gitlabProvider.listAvailableRepositories({ config: gitlabConfig, encryptedCredentials: encCreds });
    expect(repos[0]).toMatchObject({ externalRepoId: '101', fullName: 'group/proj', name: 'proj', ownerLogin: 'group' });
    const branches = await gitlabProvider.listRepositoryBranches({ config: gitlabConfig, encryptedCredentials: encCreds, repositoryFullName: 'group/proj' });
    expect(branches[0]).toMatchObject({ name: 'main', commitSha: 'abc123', protected: true });
    const prs = await gitlabProvider.listRepositoryPullRequests({ config: gitlabConfig, encryptedCredentials: encCreds, repositoryFullName: 'group/proj', state: 'open' });
    expect(prs[0]).toMatchObject({ externalId: '9001', number: 7, title: 'Add feature', state: 'open', headRef: 'feat', baseRef: 'main', authorLogin: 'dev' });
  });
});



describe('GitLab webhook ingestion (Feature D)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verifies GitLab webhook token and rejects unverified/invalid payloads', async () => {
    const { verifyGitlabWebhookToken, processGitlabWebhook } = await import('./gitlab-webhook.service');
    expect(verifyGitlabWebhookToken('secret', 'secret')).toBe(true);
    expect(verifyGitlabWebhookToken('wrong', 'secret')).toBe(false);
    expect(verifyGitlabWebhookToken(undefined, 'secret')).toBe(false);

    const body = Buffer.from(JSON.stringify({ object_kind: 'merge_request' }));
    const prisma: any = { gitLabWebhookDelivery: { create: vi.fn(), update: vi.fn() } };
    await expect(processGitlabWebhook({ prisma, rawBody: body, token: undefined, secret: 's', event: 'Merge Request Hook', eventUuid: 'u1' })).resolves.toBe('unverified');
    const bad = await processGitlabWebhook({ prisma, rawBody: Buffer.from('{nope'), token: 's', secret: 's', event: 'Merge Request Hook', eventUuid: 'u1' });
    expect(bad).toBe('invalid');
  });

  it('is idempotent by delivery id for GitLab webhooks', async () => {
    const { processGitlabWebhook } = await import('./gitlab-webhook.service');
    const body = Buffer.from(JSON.stringify({ object_kind: 'merge_request', object_attributes: { id: 9001, iid: 7, title: 'MR', state: 'opened' } }));
    const prisma: any = { gitLabWebhookDelivery: { create: vi.fn(async () => { const e: any = new Error('dup'); e.code = 'P2002'; throw e; }) } };
    const out = await processGitlabWebhook({ prisma, rawBody: body, token: 's', secret: 's', event: 'Merge Request Hook', eventUuid: 'evt-1' });
    expect(out).toBe('duplicate');
  });

  it('syncs merge_request state to linked GitLab TaskDevLink records', async () => {
    const { processGitlabWebhook } = await import('./gitlab-webhook.service');
    const body = Buffer.from(JSON.stringify({
      object_kind: 'merge_request',
      project: { id: 101 },
      object_attributes: { id: 9001, iid: 7, title: 'Updated MR', state: 'merged', action: 'merge', url: 'https://gitlab.com/group/proj/-/merge_requests/7', source_branch: 'feat', target_branch: 'main' },
    }));
    const prisma: any = {
      gitLabWebhookDelivery: { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      taskDevLink: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const out = await processGitlabWebhook({ prisma, rawBody: body, token: 's', secret: 's', event: 'Merge Request Hook', eventUuid: 'evt-2' });
    expect(out).toBe('processed');
    expect(prisma.taskDevLink.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { provider: 'GITLAB', externalType: 'PULL_REQUEST', externalId: '9001' },
      data: expect.objectContaining({ state: 'merged', externalNumber: 7, title: 'Updated MR', headRef: 'feat', baseRef: 'main' }),
    }));
  });
});

