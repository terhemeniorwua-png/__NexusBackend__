import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE8_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Meeting project access tests', () =>
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
  let privateProjectId: string;
  let openProjectId: string;
  let privateMeetingId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });
  const meetingsUrl = () => `${baseUrl}/api/v1/workspaces/${workspaceId}/meetings`;

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `mp-${suffix}-${tag}@test.example`;
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

  async function createProject(body: Record<string, unknown>): Promise<string> {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects`, {
      method: 'POST', headers: auth(owner), body: JSON.stringify(body), jar: owner.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return (res.body.data as { id: string }).id;
  }

  const createMeeting = (user: TestUser, body: Record<string, unknown>) =>
    jsonRequest(meetingsUrl(), { method: 'POST', headers: auth(user), body: JSON.stringify(body), jar: user.jar });

  async function listIds(user: TestUser, query = ''): Promise<string[]> {
    const res = await jsonRequest(`${meetingsUrl()}${query}`, { headers: auth(user), jar: user.jar });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body.data as unknown;
    const items = (Array.isArray(d) ? d : (d as { items: { id: string }[] }).items) as { id: string }[];
    return items.map((m) => m.id);
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = (await import('../src/config/env')).loadEnv({
      ...process.env,
      RATE_LIMIT_NAMESPACE: `meet-proj-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    owner = await register('Meet Owner', 'owner');
    member = await register('Meet Member', 'member');
    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST', headers: auth(owner), body: JSON.stringify({ name: `Meet Proj ${tag}` }), jar: owner.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);
    const added = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/members`, {
      method: 'POST', headers: auth(owner), body: JSON.stringify({ email: member.email, role: 'MEMBER' }), jar: owner.jar,
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));

    privateProjectId = await createProject({ name: `Secret ${tag}`, key: `S${Date.now()}`, visibility: 'PRIVATE' });
    openProjectId = await createProject({ name: `Open ${tag}`, key: `O${Date.now()}`, visibility: 'WORKSPACE' });

    const m = await createMeeting(owner, { title: `Private meeting ${tag}`, projectId: privateProjectId });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    privateMeetingId = (m.body.data as { id: string }).id;
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

  test('control: member can create a meeting with no project', async () => {
    const res = await createMeeting(member, { title: 'No project' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  test('control: member can create a meeting on a WORKSPACE project', async () => {
    const res = await createMeeting(member, { title: 'Open project', projectId: openProjectId });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  test('control: owner sees the private-project meeting in list', async () => {
    assert.ok((await listIds(owner)).includes(privateMeetingId));
  });

  test('member cannot create a meeting on a PRIVATE project', async () => {
    const res = await createMeeting(member, { title: 'Sneaky', projectId: privateProjectId });
    assert.ok([403, 404].includes(res.status), `leaked: expected 403/404, got ${res.status}`);
  });

  test('member cannot list a PRIVATE project meetings (unfiltered)', async () => {
    assert.ok(!(await listIds(member)).includes(privateMeetingId), 'leaked: private meeting in list');
  });

  test('member cannot list a PRIVATE project meetings (projectId filter)', async () => {
    const ids = await listIds(member, `?projectId=${privateProjectId}`);
    assert.ok(!ids.includes(privateMeetingId), 'leaked: private meeting via projectId filter');
  });

  test('member cannot get a PRIVATE project meeting by id', async () => {
    const res = await jsonRequest(`${meetingsUrl()}/${privateMeetingId}`, { headers: auth(member), jar: member.jar });
    assert.ok([403, 404].includes(res.status), `leaked: expected 403/404, got ${res.status}`);
  });
}
