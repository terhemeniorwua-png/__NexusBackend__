import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE19_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Phase 19 route integration tests', () =>
    test('skipped — set RUN_PHASE19_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

interface TestUser {
  id: string;
  email: string;
  token: string;
  jar: CookieJar;
}

function runTests(rawDbUrl: string): void {
  let server: RunningServer;
  let baseUrl: string;
  let owner: TestUser;
  let member: TestUser;
  let workspaceId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `p19-${suffix}-${tag}@test.example`;
    const password = 'TestPass123!';
    const jar = new CookieJar();
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
      jar,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const db = await connectTestDatabase(rawDbUrl);
    const user = await db.prisma.user.findUniqueOrThrow({ where: { email } });
    await db.prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    await db.prisma.authToken.updateMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', usedAt: null },
      data: { usedAt: new Date() },
    });
    await db.prisma.$disconnect();
    const login = await jsonRequest<{ accessToken: string }>(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      jar,
    });
    assert.equal(login.status, 200);
    const token = (login.body.data as { accessToken: string }).accessToken;
    const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      jar,
    });
    const id = (me.body.data as { user: { id: string } }).user.id;
    userIds.push(id);
    return { id, email, token, jar };
  }

  before(async () => {
    process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString('base64url');
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = (await import('./helpers/test-config')).loadTestConfig({
      RATE_LIMIT_NAMESPACE: `p19-routes-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    owner = await register('Phase19 Owner', 'owner');
    member = await register('Phase19 Member', 'member');
    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: `Phase19 Routes ${tag}` }),
      jar: owner.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);
    const added = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/members`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ email: member.email, role: 'MEMBER' }),
      jar: owner.jar,
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
  });

  after(async () => {
    await server?.close();
    await disconnectRedis();
    const db = await connectTestDatabase(rawDbUrl);
    await db.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
  });

  test('integration lifecycle routes are registered and permission-checked', async () => {
    const connected = await jsonRequest(`${baseUrl}/api/v1/integrations`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({
        provider: 'ONEDRIVE',
        accessToken: 'route-test-token',
        scopes: ['read'],
      }),
      jar: owner.jar,
    });
    assert.equal(connected.status, 201, JSON.stringify(connected.body));
    const integrationId = (connected.body.data as { id: string }).id;

    const disabled = await jsonRequest(`${baseUrl}/api/v1/integrations/${integrationId}`, {
      method: 'PATCH',
      headers: auth(owner),
      body: JSON.stringify({ enabled: false }),
      jar: owner.jar,
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    assert.equal((disabled.body.data as { enabled: boolean }).enabled, false);

    const enabled = await jsonRequest(`${baseUrl}/api/v1/integrations/${integrationId}`, {
      method: 'PATCH',
      headers: auth(owner),
      body: JSON.stringify({ enabled: true }),
      jar: owner.jar,
    });
    assert.equal(enabled.status, 200, JSON.stringify(enabled.body));

    const blocked = await jsonRequest(`${baseUrl}/api/v1/integrations/${integrationId}`, {
      method: 'PATCH',
      headers: auth(member),
      body: JSON.stringify({ enabled: false }),
      jar: member.jar,
    });
    assert.equal(blocked.status, 404, JSON.stringify(blocked.body));

    const sync = await jsonRequest(`${baseUrl}/api/v1/integrations/${integrationId}/sync`, {
      method: 'POST',
      headers: auth(owner),
      jar: owner.jar,
    });
    assert.equal(sync.status, 202, JSON.stringify(sync.body));
    const jobId = (sync.body.data as { id: string }).id;

    const jobs = await jsonRequest(`${baseUrl}/api/v1/integrations/${integrationId}/sync-jobs`, {
      headers: auth(owner),
      jar: owner.jar,
    });
    assert.equal(jobs.status, 200, JSON.stringify(jobs.body));
    assert.ok((jobs.body.data as { id: string }[]).some((job) => job.id === jobId));

    const retry = await jsonRequest(
      `${baseUrl}/api/v1/integrations/${integrationId}/sync-jobs/${jobId}/retry`,
      {
        method: 'POST',
        headers: auth(owner),
        jar: owner.jar,
      },
    );
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal((retry.body.data as { status: string }).status, 'PENDING');

    const disconnect = await jsonRequest(`${baseUrl}/api/v1/integrations/${integrationId}`, {
      method: 'DELETE',
      headers: auth(owner),
      jar: owner.jar,
    });
    assert.equal(disconnect.status, 200, JSON.stringify(disconnect.body));
  });

  test('webhook subscription routes are workspace-scoped', async () => {
    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/webhooks`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({
        url: 'https://example.test/hooks/nexus',
        events: ['task.created', 'member.joined'],
        description: 'Route test',
      }),
      jar: owner.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const webhookId = (created.body.data as { id: string }).id;
    assert.ok((created.body.data as { secret: string }).secret.length >= 32);

    const memberCreate = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/webhooks`, {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ url: 'https://example.test/hooks/member', events: ['task.created'] }),
      jar: member.jar,
    });
    assert.equal(memberCreate.status, 403, JSON.stringify(memberCreate.body));

    const listed = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/webhooks`, {
      headers: auth(member),
      jar: member.jar,
    });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok((listed.body.data as { id: string }[]).some((item) => item.id === webhookId));

    const updated = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/webhooks/${webhookId}`,
      {
        method: 'PATCH',
        headers: auth(owner),
        body: JSON.stringify({ enabled: false }),
        jar: owner.jar,
      },
    );
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal((updated.body.data as { enabled: boolean }).enabled, false);

    const deliveries = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/webhooks/${webhookId}/deliveries`,
      {
        headers: auth(owner),
        jar: owner.jar,
      },
    );
    assert.equal(deliveries.status, 200, JSON.stringify(deliveries.body));

    const deleted = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/webhooks/${webhookId}`,
      {
        method: 'DELETE',
        headers: auth(owner),
        jar: owner.jar,
      },
    );
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  });

  test('search suggestions, pagination metadata and recent history routes work', async () => {
    const searched = await jsonRequest(
      `${baseUrl}/api/v1/search?q=${encodeURIComponent(tag)}&category=all&workspaceId=${workspaceId}&page=1&limit=2`,
      { headers: auth(owner), jar: owner.jar },
    );
    assert.equal(searched.status, 200, JSON.stringify(searched.body));
    assert.ok(Array.isArray(searched.body.data));
    const searchMeta = (searched.body as { meta?: { page: number; limit: number } }).meta;
    assert.equal(searchMeta?.page, 1);
    assert.equal(searchMeta?.limit, 2);

    const suggestions = await jsonRequest(
      `${baseUrl}/api/v1/search/suggestions?q=${encodeURIComponent(tag)}&workspaceId=${workspaceId}`,
      { headers: auth(owner), jar: owner.jar },
    );
    assert.equal(suggestions.status, 200, JSON.stringify(suggestions.body));
    assert.ok(Array.isArray(suggestions.body.data));

    const recent = await jsonRequest(`${baseUrl}/api/v1/search/recent?workspaceId=${workspaceId}`, {
      headers: auth(owner),
      jar: owner.jar,
    });
    assert.equal(recent.status, 200, JSON.stringify(recent.body));
    assert.ok((recent.body.data as { query: string }[]).some((entry) => entry.query === tag));

    const cleared = await jsonRequest(
      `${baseUrl}/api/v1/search/recent?workspaceId=${workspaceId}`,
      { method: 'DELETE', headers: auth(owner), jar: owner.jar },
    );
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.ok((cleared.body.data as { deleted: number }).deleted >= 1);
  });
}
