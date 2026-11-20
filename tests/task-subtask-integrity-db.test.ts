import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { installOutboxEmailSender, resetEmailServices } from '../src/services/email';
import { loadTestConfig } from './helpers/test-config';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_TASK_SUBTASK_INTEGRITY_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Task subtask integrity DB tests', () =>
    test('skipped — set RUN_TASK_SUBTASK_INTEGRITY_DB_TESTS=true to run', () => {}));
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
  let pm: TestUser;
  let workspaceId: string;
  let projectId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });
  const tasksUrl = () => `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`;
  const taskUrl = (id: string) => `${tasksUrl()}/${id}`;

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `tsi-${suffix}-${tag}@test.example`;
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
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const token = (login.body.data as { accessToken: string }).accessToken;
    const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      jar,
    });
    const id = (me.body.data as { user: { id: string } }).user.id;
    userIds.push(id);
    return { id, email, token, jar };
  }

  async function createTask(title: string, body: Record<string, unknown> = {}): Promise<string> {
    const res = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title, ...body }),
      jar: pm.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return (res.body.data as { id: string }).id;
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = loadTestConfig({
      RATE_LIMIT_NAMESPACE: `task-subtask-integrity-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    installOutboxEmailSender(config);
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    pm = await register('PM', 'pm');

    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ name: `TSI WS ${tag}`, type: 'COMPANY' }),
      jar: pm.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);

    const projectResponse = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/projects`,
      {
        method: 'POST',
        headers: auth(pm),
        body: JSON.stringify({
          name: 'Subtask Integrity Project',
          key: `SI${String(tag).slice(-4)}`,
          visibility: 'WORKSPACE',
        }),
        jar: pm.jar,
      },
    );
    assert.equal(projectResponse.status, 201, JSON.stringify(projectResponse.body));
    projectId = (projectResponse.body.data as { id: string }).id;
  });

  after(async () => {
    await server.close();
    await disconnectRedis();
    await resetEmailServices();
    const db = await connectTestDatabase(rawDbUrl);
    await db.prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.prisma.task.deleteMany({ where: { projectId } });
    await db.prisma.project.deleteMany({ where: { id: projectId } });
    await db.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
  });

  test('create enforces MAX_TASK_DEPTH (task -> subtask -> sub-subtask)', async () => {
    const root = await createTask('Root depth task');
    const child = await createTask('Child depth task', { parentTaskId: root });
    const grandchild = await createTask('Grandchild depth task', { parentTaskId: child });

    const tooDeep = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Too deep task', parentTaskId: grandchild }),
      jar: pm.jar,
    });
    assert.equal(tooDeep.status, 400, JSON.stringify(tooDeep.body));
    assert.equal(tooDeep.body.error?.code, 'TASK_MAX_DEPTH_EXCEEDED');
  });

  test('update rejects moving a task under itself or any descendant (cycle)', async () => {
    const root = await createTask('Cycle root');
    const child = await createTask('Cycle child', { parentTaskId: root });
    const grandchild = await createTask('Cycle grandchild', { parentTaskId: child });

    const self = await jsonRequest(taskUrl(root), {
      method: 'PATCH',
      headers: auth(pm),
      body: JSON.stringify({ parentTaskId: root }),
      jar: pm.jar,
    });
    assert.equal(self.status, 400, JSON.stringify(self.body));
    assert.ok(['TASK_SELF_PARENT', 'TASK_PARENT_CYCLE'].includes(self.body.error?.code ?? ''));

    const descendant = await jsonRequest(taskUrl(root), {
      method: 'PATCH',
      headers: auth(pm),
      body: JSON.stringify({ parentTaskId: grandchild }),
      jar: pm.jar,
    });
    assert.equal(descendant.status, 400, JSON.stringify(descendant.body));
    assert.equal(descendant.body.error?.code, 'TASK_PARENT_CYCLE');
  });

  test('update rejects moves that would exceed max depth, including subtree height', async () => {
    const rootA = await createTask('Move root A');
    const childA = await createTask('Move child A', { parentTaskId: rootA });
    await createTask('Move grandchild A', { parentTaskId: childA });

    const rootB = await createTask('Move root B');
    const childB = await createTask('Move child B', { parentTaskId: rootB });

    // Moving rootA (subtree height 3) under childB (depth 2) would exceed depth 3.
    const moveDeep = await jsonRequest(taskUrl(rootA), {
      method: 'PATCH',
      headers: auth(pm),
      body: JSON.stringify({ parentTaskId: childB }),
      jar: pm.jar,
    });
    assert.equal(moveDeep.status, 400, JSON.stringify(moveDeep.body));
    assert.equal(moveDeep.body.error?.code, 'TASK_MAX_DEPTH_EXCEEDED');

    // Moving childA (has one child, subtree height 2) under another depth-2 task would exceed depth 3.
    const rootC = await createTask('Move root C');
    const childC = await createTask('Move child C', { parentTaskId: rootC });
    const moveChildWithSubtree = await jsonRequest(taskUrl(childA), {
      method: 'PATCH',
      headers: auth(pm),
      body: JSON.stringify({ parentTaskId: childC }),
      jar: pm.jar,
    });
    assert.equal(moveChildWithSubtree.status, 400, JSON.stringify(moveChildWithSubtree.body));
    assert.equal(moveChildWithSubtree.body.error?.code, 'TASK_MAX_DEPTH_EXCEEDED');
  });
}
