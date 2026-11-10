import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE8_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Slack OAuth security tests', () =>
    test('skipped — set RUN_PHASE8_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

interface TestUser { id: string; email: string; token: string; jar: CookieJar }

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
    const email = `so-${suffix}-${tag}@test.example`;
    const password = 'TestPass123!';
    const jar = new CookieJar();
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST', body: JSON.stringify({ name, email, password }), jar,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const db = await connectTestDatabase(rawDbUrl);
    const user = await db.prisma.user.findUniqueOrThrow({ where: { email } });
    await db.prisma.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', emailVerifiedAt: new Date() } });
    await db.prisma.authToken.updateMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', usedAt: null },
      data: { usedAt: new Date() },
    });
    await db.prisma.$disconnect();
    const login = await jsonRequest<{ accessToken: string }>(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST', body: JSON.stringify({ email, password }), jar,
    });
    assert.equal(login.status, 200);
    const token = (login.body.data as { accessToken: string }).accessToken;
    const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` }, jar });
    const id = (me.body.data as { user: { id: string } }).user.id;
    userIds.push(id);
    return { id, email, token, jar };
  }

  const authorize = (user: TestUser) =>
    jsonRequest(`${baseUrl}/api/v1/integrations/slack/authorize?workspaceId=${workspaceId}`, {
      headers: auth(user), jar: user.jar,
    });

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = (await import('./helpers/test-config')).loadTestConfig({
      RATE_LIMIT_NAMESPACE: `slack-sec-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    // Slack settings used only by this test process.
    process.env.SLACK_CLIENT_ID = 'test-client-id';
    process.env.SLACK_CLIENT_SECRET = 'test-client-secret';
    process.env.SLACK_REDIRECT_URI = 'http://localhost/api/v1/integrations/slack/callback';
    process.env.JWT_ACCESS_SECRET ??= `test-secret-${tag}-padding-padding-padding`;

    owner = await register('Slack Owner', 'owner');
    member = await register('Slack Member', 'member');
    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST', headers: auth(owner), body: JSON.stringify({ name: `Slack Sec ${tag}` }), jar: owner.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);
    const added = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/members`, {
      method: 'POST', headers: auth(owner), body: JSON.stringify({ email: member.email, role: 'MEMBER' }), jar: owner.jar,
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
  });

  after(async () => {
    await server?.close();
    await disconnectRedis();
    const db = await connectTestDatabase(rawDbUrl);
    await db.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
  });

  test('POST /integrations rejects a client-supplied SLACK token', async () => {
    const res = await jsonRequest(`${baseUrl}/api/v1/integrations`, {
      method: 'POST', headers: auth(owner), jar: owner.jar,
      body: JSON.stringify({ provider: 'SLACK', workspaceId, accessToken: 'xoxb-fake' }),
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  test('a plain member cannot start the Slack flow', async () => {
    const res = await authorize(member);
    assert.ok([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
  });

  test('control: the owner gets a Slack consent URL with a state', async () => {
    const res = await authorize(owner);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const url = new URL((res.body.data as { url: string }).url);
    assert.equal(url.hostname, 'slack.com');
    assert.ok(url.searchParams.get('state'));
    assert.equal(url.searchParams.get('scope'), 'chat:write,channels:read,app_mentions:read');
  });

  test('a state can be used once; a replay is rejected', async () => {
    const { verifySlackState } = await import('../src/modules/integrations/slack.oauth');
    const res = await authorize(owner);
    const state = new URL((res.body.data as { url: string }).url).searchParams.get('state')!;
    const claims = await verifySlackState(state);
    assert.equal(claims.userId, owner.id);
    assert.equal(claims.workspaceId, workspaceId);
    await assert.rejects(verifySlackState(state), /invalid or expired/);
  });

  test('a tampered state is rejected', async () => {
    const { verifySlackState } = await import('../src/modules/integrations/slack.oauth');
    const res = await authorize(owner);
    const state = new URL((res.body.data as { url: string }).url).searchParams.get('state')!;
    await assert.rejects(verifySlackState(`${state}x`), /invalid or expired/);
  });
}
