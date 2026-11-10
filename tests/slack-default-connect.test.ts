import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE8_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Slack default connect tests', () =>
    test('skipped — set RUN_PHASE8_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

interface TestUser { id: string; email: string; token: string; jar: CookieJar }
interface SlackRow { id: string; provider: string; status: string }

function runTests(rawDbUrl: string): void {
  let server: RunningServer;
  let baseUrl: string;
  let owner: TestUser;
  let member: TestUser;
  let manager: TestUser;
  let workspaceId: string;
  let integrationId = '';
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });
  const integrationsUrl = () => `${baseUrl}/api/v1/integrations`;

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `sd-${suffix}-${tag}@test.example`;
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

  async function createWorkspace(name: string): Promise<string> {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST', headers: auth(owner), body: JSON.stringify({ name }), jar: owner.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = (res.body.data as { id: string }).id;
    workspaceIds.push(id);
    return id;
  }

  async function addMember(ws: string, user: TestUser, role: string): Promise<void> {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${ws}/members`, {
      method: 'POST', headers: auth(owner), body: JSON.stringify({ email: user.email, role }), jar: owner.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  const startConnect = (user: TestUser, ws: string) =>
    jsonRequest(`${integrationsUrl()}/slack/authorize?workspaceId=${ws}`, { headers: auth(user), jar: user.jar });

  async function authorizeUrl(user: TestUser, ws: string): Promise<string> {
    const res = await startConnect(user, ws);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return (res.body.data as { url: string }).url;
  }

  /** Follows the returned link without following the final redirect to the frontend. */
  async function followLink(url: string): Promise<string> {
    const res = await fetch(url, { redirect: 'manual' });
    assert.equal(res.status, 302);
    return res.headers.get('location') ?? '';
  }

  async function slackRows(user: TestUser, ws: string): Promise<{ rows: SlackRow[]; raw: string }> {
    const res = await jsonRequest(`${integrationsUrl()}?workspaceId=${ws}`, { headers: auth(user), jar: user.jar });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body.data as unknown;
    const all = (Array.isArray(d) ? d : (d as { items: SlackRow[] }).items) as SlackRow[];
    return { rows: all.filter((r) => r.provider === 'SLACK'), raw: JSON.stringify(res.body) };
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = (await import('./helpers/test-config')).loadTestConfig({
      RATE_LIMIT_NAMESPACE: `slack-dc-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    // token-crypto.ts needs a base64url 32-byte key. Always use a fresh one in tests, so a missing or
    // wrongly formatted local value cannot break them.
    process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString('base64url');
    process.env.SLACK_CLIENT_ID = 'test-client-id';
    process.env.SLACK_CLIENT_SECRET = 'test-client-secret';
    process.env.SLACK_REDIRECT_URI = `${baseUrl}/api/v1/integrations/slack/callback`;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-not-a-real-token';
    process.env.SLACK_DEFAULT_CONNECT = 'true';

    owner = await register('SD Owner', 'owner');
    member = await register('SD Member', 'member');
    manager = await register('SD Manager', 'manager');
    workspaceId = await createWorkspace(`SD ${tag}`);
    await addMember(workspaceId, member, 'MEMBER');
    await addMember(workspaceId, manager, 'PROJECT_MANAGER');
  });

  after(async () => {
    await server?.close();
    try {
      const db = await connectTestDatabase(rawDbUrl);
      await db.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await db.prisma.$disconnect();
    } catch { /* best-effort cleanup */ }
    try {
      const db = await connectTestDatabase(rawDbUrl);
      await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await db.prisma.$disconnect();
    } catch { /* best-effort cleanup */ }
    try {
      const { getPrismaClient } = await import('../src/db/prisma');
      await getPrismaClient().$disconnect();
    } catch { /* ignore */ }
    try { await disconnectRedis(); } catch { /* ignore */ }
  });

  test('default connect: authorize returns a Nexus link, not a Slack page', async () => {
    const url = await authorizeUrl(owner, workspaceId);
    assert.ok(url.includes('/slack/default-callback'), `unexpected url: ${url}`);
    assert.ok(!url.includes('slack.com/oauth'), 'must not send the user to Slack');
  });

  test('a plain member cannot start the Slack connection', async () => {
    const res = await startConnect(member, workspaceId);
    assert.ok([403, 404].includes(res.status), `leaked: expected 403/404, got ${res.status}`);
  });

  test('owner clicks Connect: workspace becomes ACTIVE without calling Slack', async () => {
    const location = await followLink(await authorizeUrl(owner, workspaceId));
    assert.ok(location.includes('status=connected'), `unexpected redirect: ${location}`);
    const { rows, raw } = await slackRows(owner, workspaceId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'ACTIVE');
    assert.ok(!raw.includes('xoxb-'), 'token must never appear in the list response');
    integrationId = rows[0]!.id;
  });

  test('every member of the workspace sees Slack as ACTIVE', async () => {
    const { rows } = await slackRows(member, workspaceId);
    assert.equal(rows.length, 1, 'member does not see the workspace connection');
    assert.equal(rows[0]!.status, 'ACTIVE');
  });

  test('a replayed connect link is rejected', async () => {
    const url = await authorizeUrl(owner, workspaceId);
    const first = await followLink(url);
    assert.ok(first.includes('status=connected'));
    const second = await followLink(url);
    assert.ok(second.includes('status=error'), `replay accepted: ${second}`);
  });

  test('a plain member cannot disconnect the workspace Slack connection', async () => {
    const res = await jsonRequest(`${integrationsUrl()}/${integrationId}`, { method: 'DELETE', headers: auth(member), jar: member.jar });
    assert.ok([403, 404].includes(res.status), `leaked: expected 403/404, got ${res.status}`);
    const { rows } = await slackRows(owner, workspaceId);
    assert.equal(rows[0]!.status, 'ACTIVE', 'blocked member disconnected it anyway');
  });

  test('a manager who did not connect can disconnect it', async () => {
    const { rows: before } = await slackRows(manager, workspaceId);
    assert.equal(before.length, 1);
    const res = await jsonRequest(`${integrationsUrl()}/${before[0]!.id}`, { method: 'DELETE', headers: auth(manager), jar: manager.jar });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { rows } = await slackRows(owner, workspaceId);
    assert.equal(rows.length, 0, 'disconnected workspace connections are omitted from the list');
  });

  test('reconnecting after a disconnect leaves exactly one ACTIVE Slack connection', async () => {
    const location = await followLink(await authorizeUrl(owner, workspaceId));
    assert.ok(location.includes('status=connected'), `unexpected redirect: ${location}`);
    const { rows } = await slackRows(member, workspaceId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, 'ACTIVE');
  });

  test('default-callback refuses to connect when the feature flag is off', async () => {
    const ws2 = await createWorkspace(`SD2 ${tag}`);
    const url = await authorizeUrl(owner, ws2);
    process.env.SLACK_DEFAULT_CONNECT = 'false';
    try {
      const location = await followLink(url);
      assert.ok(location.includes('status=error'), `connected while disabled: ${location}`);
      const { rows } = await slackRows(owner, ws2);
      assert.equal(rows.filter((r) => r.status === 'ACTIVE').length, 0);
    } finally {
      process.env.SLACK_DEFAULT_CONNECT = 'true';
    }
  });
}
