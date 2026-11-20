import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE8_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Project overview docs PostgreSQL tests', () =>
    test('skipped — set RUN_PHASE8_DB_TESTS=true to run', () => {}));
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
  let workspaceId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `ov-${suffix}-${tag}@test.example`;
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
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = (await import('./helpers/test-config')).loadTestConfig({
      RATE_LIMIT_NAMESPACE: `overview-db-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    owner = await register('Overview Owner', 'owner');
    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: `Overview Workspace ${tag}` }),
      jar: owner.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);
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

  test('the project overview lists project docs and project folders but not workspace ones', async () => {
    const project = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: 'Overview Project', key: `OV${Date.now()}`, visibility: 'WORKSPACE' }),
      jar: owner.jar,
    });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const projectId = (project.body.data as { id: string }).id;

    const db = await connectTestDatabase(rawDbUrl);
    const projectDoc = await db.prisma.document.create({
      data: { workspaceId, projectId, title: 'Project doc', authorId: owner.id },
    });
    const workspaceDoc = await db.prisma.document.create({
      data: { workspaceId, projectId: null, title: 'Workspace doc', authorId: owner.id },
    });
    await db.prisma.$disconnect();

    const projectFolder = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/resources/folders`,
      { method: 'POST', headers: auth(owner), body: JSON.stringify({ name: 'Project folder' }), jar: owner.jar },
    );
    assert.equal(projectFolder.status, 201, JSON.stringify(projectFolder.body));
    const workspaceFolder = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/resources/folders`,
      { method: 'POST', headers: auth(owner), body: JSON.stringify({ name: 'Workspace folder' }), jar: owner.jar },
    );
    assert.equal(workspaceFolder.status, 201, JSON.stringify(workspaceFolder.body));

    const overview = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/resources/dashboard/overview`,
      { headers: auth(owner) },
    );
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    const data = overview.body.data as {
      docs: Array<{ id: string; kind: string; title: string; createdByName: string }>;
      folders: Array<{ id: string; name: string }>;
    };

    const doc = data.docs.find((d) => d.id === projectDoc.id);
    assert.ok(doc, 'project doc should be listed');
    assert.equal(doc.kind, 'PROJECT_DOC');
    assert.equal(doc.createdByName, 'Overview Owner');
    assert.equal(data.docs.some((d) => d.id === workspaceDoc.id), false, 'workspace doc must not appear');

    assert.ok(data.folders.some((f) => f.name === 'Project folder'));
    assert.equal(data.folders.some((f) => f.name === 'Workspace folder'), false);
  });
}
