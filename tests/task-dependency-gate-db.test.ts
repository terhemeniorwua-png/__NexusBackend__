import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { installOutboxEmailSender, resetEmailServices } from '../src/services/email';
import { loadTestConfig } from './helpers/test-config';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_TASK_DEPENDENCY_GATE_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Task dependency gate DB tests', () =>
    test('skipped — set RUN_TASK_DEPENDENCY_GATE_DB_TESTS=true to run', () => {}));
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
    const email = `tdg-${suffix}-${tag}@test.example`;
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

  async function addDependency(taskId: string, dependsOnTaskId: string) {
    return jsonRequest(`${taskUrl(taskId)}/dependencies`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ dependsOnTaskId }),
      jar: pm.jar,
    });
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = loadTestConfig({
      RATE_LIMIT_NAMESPACE: `task-dependency-gate-${tag}`,
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
      body: JSON.stringify({ name: `TDG WS ${tag}`, type: 'COMPANY' }),
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
          name: 'Dependency Gate Project',
          key: `DG${String(tag).slice(-4)}`,
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

  test('duplicate dependency returns DEPENDENCY_ALREADY_EXISTS and circular dependency returns CIRCULAR_DEPENDENCY', async () => {
    const a = await createTask('Dep A');
    const b = await createTask('Dep B');

    const first = await addDependency(a, b);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const duplicate = await addDependency(a, b);
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.error?.code, 'DEPENDENCY_ALREADY_EXISTS');

    const cycle = await addDependency(b, a);
    assert.equal(cycle.status, 409, JSON.stringify(cycle.body));
    assert.equal(cycle.body.error?.code, 'CIRCULAR_DEPENDENCY');
  });

  test('moving to IN_PROGRESS is blocked while dependency is not approved, and allowed after approval', async () => {
    const blocker = await createTask('Blocker for in-progress');
    const task = await createTask('Blocked task in-progress');
    const dep = await addDependency(task, blocker);
    assert.equal(dep.status, 201, JSON.stringify(dep.body));

    const blocked = await jsonRequest(taskUrl(task), {
      method: 'PATCH',
      headers: auth(pm),
      body: JSON.stringify({ status: 'IN_PROGRESS' }),
      jar: pm.jar,
    });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error?.code, 'TASK_BLOCKED_BY_DEPENDENCIES');
    assert.deepEqual(blocked.body.error?.details, { blockingTaskIds: [blocker] });

    const completeBlocker = await jsonRequest(`${taskUrl(blocker)}/complete`, {
      method: 'POST',
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.equal(completeBlocker.status, 200, JSON.stringify(completeBlocker.body));

    const allowed = await jsonRequest(taskUrl(task), {
      method: 'PATCH',
      headers: auth(pm),
      body: JSON.stringify({ status: 'IN_PROGRESS' }),
      jar: pm.jar,
    });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  });

  test('moving to SUBMITTED is blocked while dependency is not approved', async () => {
    const blocker = await createTask('Blocker for submit');
    const task = await createTask('Blocked task submit');
    await jsonRequest(`${taskUrl(task)}/assignees`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ targetUserId: pm.id }),
      jar: pm.jar,
    });
    const dep = await addDependency(task, blocker);
    assert.equal(dep.status, 201, JSON.stringify(dep.body));

    const blocked = await jsonRequest(`${taskUrl(task)}/submit`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ workSummary: 'Submitting while blocked' }),
      jar: pm.jar,
    });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error?.code, 'TASK_BLOCKED_BY_DEPENDENCIES');
    assert.deepEqual(blocked.body.error?.details, { blockingTaskIds: [blocker] });
  });

  test('moving to APPROVED is blocked while dependency is not approved', async () => {
    const blocker = await createTask('Blocker for complete');
    const task = await createTask('Blocked task complete');
    const dep = await addDependency(task, blocker);
    assert.equal(dep.status, 201, JSON.stringify(dep.body));

    const blocked = await jsonRequest(`${taskUrl(task)}/complete`, {
      method: 'POST',
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error?.code, 'TASK_BLOCKED_BY_DEPENDENCIES');
    assert.deepEqual(blocked.body.error?.details, { blockingTaskIds: [blocker] });
  });

  test('deleted or archived dependencies do not block transitions', async () => {
    const blocker = await createTask('Blocker to archive');
    const task = await createTask('Task with archived blocker');
    const dep = await addDependency(task, blocker);
    assert.equal(dep.status, 201, JSON.stringify(dep.body));

    const archived = await jsonRequest(`${taskUrl(blocker)}/archive`, {
      method: 'POST',
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.equal(archived.status, 200, JSON.stringify(archived.body));

    const allowed = await jsonRequest(taskUrl(task), {
      method: 'PATCH',
      headers: auth(pm),
      body: JSON.stringify({ status: 'IN_PROGRESS' }),
      jar: pm.jar,
    });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  });
}
