import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { verifyOAuthState, createOAuthState } from '../src/modules/integrations/oauth-state';
import { verifyGithubWebhookSignature, processGithubWebhook } from '../src/modules/dev-integrations/github-webhook.service';
import { createIntegrationService } from '../src/modules/integrations/integration.service';
import { createImportService } from '../src/modules/imports/import.service';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// --- Unit tests (no DB) ---

test('OAuth state tampering is rejected', async () => {
  setEnv('JWT_ACCESS_SECRET', 'x'.repeat(48));
  setEnv('REDIS_URL', undefined);
  const { state } = await createOAuthState({
    provider: 'github',
    userId: 'user-1',
    workspaceId: '11111111-1111-4111-8111-111111111111',
  });
  await assert.rejects(() => verifyOAuthState('github', `${state}tampered`), (err: { code?: string } | null | undefined) =>
    err?.code === 'OAUTH_STATE_INVALID' || err?.code === 'OAUTH_STATE_EXPIRED',
  );
  await assert.rejects(() => verifyOAuthState('slack', state), (err: { code?: string } | null | undefined) =>
    err?.code === 'OAUTH_STATE_INVALID' || err?.code === 'OAUTH_STATE_EXPIRED',
  );
  restoreEnv();
});

test('GitHub webhook with bad signature is rejected', async () => {
  const raw = Buffer.from(JSON.stringify({ action: 'opened' }), 'utf8');
  const ok = verifyGithubWebhookSignature(raw, 'sha256=' + '0'.repeat(64), 'secret');
  assert.equal(ok, false);
  const result = await processGithubWebhook({
    rawBody: raw,
    signature: 'sha256=' + '0'.repeat(64),
    secret: 'secret',
    deliveryId: 'd1',
    event: 'pull_request',
    prisma: {
      gitHubWebhookDelivery: {
        create: async () => ({ id: 'x' }),
        update: async () => ({}),
      },
      taskDevLink: { updateMany: async () => ({ count: 0 }) },
    } as never,
  });
  assert.equal(result, 'unverified');
});

test('GitHub webhook replay is detected when delivery already exists', async () => {
  const secret = 'topsecret';
  const raw = Buffer.from(JSON.stringify({ action: 'opened' }), 'utf8');
  const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const result = await processGithubWebhook({
    rawBody: raw,
    signature: sig,
    secret,
    deliveryId: 'dup-1',
    event: 'pull_request',
    prisma: {
      gitHubWebhookDelivery: {
        create: async () => {
          const err: any = new Error('dup');
          err.code = 'P2002';
          throw err;
        },
      },
    } as never,
  });
  assert.equal(result, 'duplicate');
});

// --- DB-gated tests ---

const DB_FLAG = 'RUN_PHASE19_DB_TESTS';
let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE19_DB_TESTS=true and an explicit loopback TEST_DATABASE_URL';
try {
  databaseUrl = resolveTestDatabaseUrl(DB_FLAG);
  if (databaseUrl) skipReason = '';
} catch (error) {
  if (process.env[DB_FLAG] === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database identity was rejected';
}

describe('Integrations/imports DB tests', { skip: skipReason || false }, () => {
  let prisma: PrismaClient;
  const ids = { users: [] as string[], workspaces: [] as string[] };

  before(async () => {
    setEnv('INTEGRATION_ENCRYPTION_KEY', randomBytes(32).toString('base64url'));
    const db = await connectTestDatabase(databaseUrl as string);
    prisma = db.prisma;
  });

  after(async () => {
    restoreEnv();
    try {
      if (ids.workspaces.length) await prisma.workspace.deleteMany({ where: { id: { in: ids.workspaces } } });
      if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
    } finally {
      await prisma?.$disconnect();
    }
  });

  test('token never leaked in integration responses', async () => {
    const suffix = `${process.pid}-${Date.now()}-leak`;
    const owner = await prisma.user.create({
      data: { email: `leak-${suffix}@example.test`, name: 'Leak', passwordHash: 'x', status: 'ACTIVE' },
    });
    ids.users.push(owner.id);
    const ws = await prisma.workspace.create({
      data: { name: `Leak ${suffix}`, slug: `leak-${suffix}`, ownerId: owner.id },
    });
    ids.workspaces.push(ws.id);
    await prisma.workspaceMembership.create({
      data: { workspaceId: ws.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
    });

    const service = createIntegrationService(prisma, {
      async refresh() {
        return { accessToken: 'new-access', refreshToken: 'new-refresh', tokenExpiresAt: new Date(Date.now() + 3600000).toISOString() };
      },
      async revoke() { return { revoked: true }; },
    });

    const connected = await service.connect({
      userId: owner.id,
      provider: 'SLACK',
      workspaceId: ws.id,
      accessToken: 'SUPER_SECRET_ACCESS',
      refreshToken: 'SUPER_SECRET_REFRESH',
      scopes: ['chat:write'],
    });
    const text = JSON.stringify(connected);
    assert.equal(text.includes('SUPER_SECRET_ACCESS'), false);
    assert.equal(text.includes('SUPER_SECRET_REFRESH'), false);
    assert.equal(text.includes('accessTokenCiphertext'), false);
    assert.equal(text.includes('refreshTokenCiphertext'), false);

    const list = await service.list({ userId: owner.id, workspaceId: ws.id });
    const listText = JSON.stringify(list);
    assert.equal(listText.includes('SUPER_SECRET_ACCESS'), false);
    assert.equal(listText.includes('SUPER_SECRET_REFRESH'), false);

    const status = await service.getStatus({ userId: owner.id, integrationId: connected.id });
    const statusText = JSON.stringify(status);
    assert.equal(statusText.includes('SUPER_SECRET_ACCESS'), false);
    assert.equal(statusText.includes('SUPER_SECRET_REFRESH'), false);
  });

  test('cross-workspace integration isolation', async () => {
    const suffix = `${process.pid}-${Date.now()}-iso`;
    const a = await prisma.user.create({ data: { email: `iso-a-${suffix}@e.test`, name: 'A', passwordHash: 'x', status: 'ACTIVE' } });
    const b = await prisma.user.create({ data: { email: `iso-b-${suffix}@e.test`, name: 'B', passwordHash: 'x', status: 'ACTIVE' } });
    ids.users.push(a.id, b.id);
    const wsA = await prisma.workspace.create({ data: { name: `A ${suffix}`, slug: `a-${suffix}`, ownerId: a.id } });
    const wsB = await prisma.workspace.create({ data: { name: `B ${suffix}`, slug: `b-${suffix}`, ownerId: b.id } });
    ids.workspaces.push(wsA.id, wsB.id);
    await prisma.workspaceMembership.create({ data: { workspaceId: wsA.id, userId: a.id, role: 'OWNER', status: 'ACTIVE' } });
    await prisma.workspaceMembership.create({ data: { workspaceId: wsB.id, userId: b.id, role: 'OWNER', status: 'ACTIVE' } });

    const service = createIntegrationService(prisma);
    const integration = await service.connect({
      userId: a.id,
      provider: 'SLACK',
      workspaceId: wsA.id,
      accessToken: 'tok-a',
      scopes: ['chat:write'],
    });

    await assert.rejects(
      () => service.getStatus({ userId: b.id, integrationId: integration.id }),
      (err: { code?: string } | null | undefined) => err?.statusCode === 403 || err?.statusCode === 404 || err?.code === 'WORKSPACE_ACCESS_DENIED' || err?.code === 'INTEGRATION_NOT_FOUND',
    );
  });

  test('import dry-run creates nothing and confirm is idempotent', async () => {
    const suffix = `${process.pid}-${Date.now()}-imp`;
    const owner = await prisma.user.create({ data: { email: `imp-${suffix}@e.test`, name: 'Imp', passwordHash: 'x', status: 'ACTIVE' } });
    ids.users.push(owner.id);
    const ws = await prisma.workspace.create({ data: { name: `Imp ${suffix}`, slug: `imp-${suffix}`, ownerId: owner.id } });
    ids.workspaces.push(ws.id);
    await prisma.workspaceMembership.create({ data: { workspaceId: ws.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' } });

    const service = createImportService(prisma);
    const csv = 'title,description,external_id\nTask One,Desc,ext-1\nTask Two,Desc,ext-2\n';
    const projectsBefore = await prisma.project.count({ where: { workspaceId: ws.id } });
    const tasksBefore = await prisma.task.count({ where: { project: { workspaceId: ws.id } } });

    const preview = await service.createPreview({ userId: owner.id, workspaceId: ws.id, source: 'CSV', csv });
    assert.equal(preview.status, 'PREVIEWED');
    assert.ok(preview.preview.counts.tasks >= 2);

    const projectsAfterPreview = await prisma.project.count({ where: { workspaceId: ws.id } });
    const tasksAfterPreview = await prisma.task.count({ where: { project: { workspaceId: ws.id } } });
    assert.equal(projectsAfterPreview, projectsBefore);
    assert.equal(tasksAfterPreview, tasksBefore);

    const exec1 = await service.confirm({ userId: owner.id, importId: preview.id, idempotencyKey: 'k1' });
    await service.processQueued(10);
    const after1Tasks = await prisma.task.count({ where: { project: { workspaceId: ws.id } } });
    assert.ok(after1Tasks >= tasksBefore + 2);

    // re-confirm same key returns same execution, processing again does not duplicate
    const exec2 = await service.confirm({ userId: owner.id, importId: preview.id, idempotencyKey: 'k1' });
    assert.equal(exec2.id, exec1.id);
    await service.processQueued(10);
    const after2Tasks = await prisma.task.count({ where: { project: { workspaceId: ws.id } } });
    assert.equal(after2Tasks, after1Tasks);
  });
});
