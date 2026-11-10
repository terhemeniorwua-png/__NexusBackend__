import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE8_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Search project visibility tests', () =>
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
  let member: TestUser;
  let workspaceId: string;
  let privateProjectId: string;
  let openProjectId: string;
  let privateFileId: string;
  let privateDocumentId: string;
  let privateChannelId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;
  const needle = `zqneedle${Date.now()}`;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `sv-${suffix}-${tag}@test.example`;
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

  async function createProject(body: Record<string, unknown>): Promise<string> {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify(body),
      jar: owner.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return (res.body.data as { id: string }).id;
  }

  async function search(user: TestUser, category: string): Promise<{ id: string; title: string }[]> {
    const res = await jsonRequest(
      `${baseUrl}/api/v1/search?q=${encodeURIComponent(needle)}&category=${category}&workspaceId=${workspaceId}`,
      { headers: auth(user), jar: user.jar },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data as { id: string; title: string }[];
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = (await import('./helpers/test-config')).loadTestConfig({
      RATE_LIMIT_NAMESPACE: `search-vis-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    owner = await register('Search Owner', 'owner');
    member = await register('Search Member', 'member');
    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: `Search Visibility ${tag}` }),
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

    privateProjectId = await createProject({
      name: `Secret ${needle}`,
      key: `S${Date.now()}`,
      visibility: 'PRIVATE',
    });
    openProjectId = await createProject({
      name: `Open ${needle}`,
      key: `O${Date.now()}`,
      visibility: 'WORKSPACE',
    });

    const privateDocument = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/documents`, {
      method: 'POST', headers: auth(owner),
      body: JSON.stringify({ title: `Private document ${needle}`, content: `Private body ${needle}`, projectId: privateProjectId }),
      jar: owner.jar,
    });
    assert.equal(privateDocument.status, 201, JSON.stringify(privateDocument.body));
    privateDocumentId = (privateDocument.body.data as { id: string }).id;

    const privateChannel = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/channels`, {
      method: 'POST', headers: auth(owner),
      body: JSON.stringify({ type: 'PRIVATE', name: `Secret channel ${needle}` }),
      jar: owner.jar,
    });
    assert.equal(privateChannel.status, 201, JSON.stringify(privateChannel.body));
    privateChannelId = (privateChannel.body.data as { id: string }).id;

    const fdb = await connectTestDatabase(rawDbUrl);
    const file = await fdb.prisma.fileAttachment.create({
      data: {
        workspaceId,
        projectId: privateProjectId,
        uploadedById: owner.id,
        fileName: `secret-${needle}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: 10,
        storageKey: `test/${tag}/${needle}`,
      },
    });
    privateFileId = file.id;
    await fdb.prisma.$disconnect();
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

  test('control: member finds a WORKSPACE-visible project', async () => {
    const ids = (await search(member, 'projects')).map((r) => r.id);
    assert.ok(ids.includes(openProjectId));
  });

  test('control: owner finds the private project and its file', async () => {
    assert.ok((await search(owner, 'projects')).some((r) => r.id === privateProjectId));
    assert.ok((await search(owner, 'files')).some((r) => r.id === privateFileId));
    assert.ok((await search(owner, 'documents')).some((r) => r.id === privateDocumentId));
    assert.ok((await search(owner, 'channels')).some((r) => r.id === privateChannelId));
  });

  test('member cannot find a PRIVATE project via search', async () => {
    const ids = (await search(member, 'projects')).map((r) => r.id);
    assert.ok(!ids.includes(privateProjectId), 'private project leaked into search');
  });

  test('member cannot find files attached to a PRIVATE project', async () => {
    const ids = (await search(member, 'files')).map((r) => r.id);
    assert.ok(!ids.includes(privateFileId), 'private project file leaked into search');
  });

  test('member cannot find documents attached to a PRIVATE project', async () => {
    const ids = (await search(member, 'documents')).map((r) => r.id);
    assert.ok(!ids.includes(privateDocumentId), 'private project document leaked into search');
  });

  test('member cannot read or list documents attached to a PRIVATE project', async () => {
    const read = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/documents/${privateDocumentId}`, {
      headers: auth(member), jar: member.jar,
    });
    assert.equal(read.status, 404);
    const list = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/documents`, {
      headers: auth(member), jar: member.jar,
    });
    assert.equal(list.status, 200);
    const items = (list.body.data as { items: { id: string }[] }).items;
    assert.ok(!items.some((item) => item.id === privateDocumentId));
  });

  test('member cannot discover a private channel by searching its name', async () => {
    const ids = (await search(member, 'channels')).map((r) => r.id);
    assert.ok(!ids.includes(privateChannelId), 'private channel leaked into search');
  });
}
