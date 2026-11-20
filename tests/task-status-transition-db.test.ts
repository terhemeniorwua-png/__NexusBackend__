import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { installOutboxEmailSender, resetEmailServices } from '../src/services/email';
import { loadTestConfig } from './helpers/test-config';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_TASK_STATUS_TRANSITION_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Task status transition DB tests', () =>
    test('skipped — set RUN_TASK_STATUS_TRANSITION_DB_TESTS=true to run', () => {}));
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
    const email = `tst-${suffix}-${tag}@test.example`;
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
      RATE_LIMIT_NAMESPACE: `task-status-transition-${tag}`,
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
      body: JSON.stringify({ name: `TST WS ${tag}`, type: 'COMPANY' }),
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
          name: 'Status Transition Project',
          key: `ST${String(tag).slice(-4)}`,
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

  test('PATCH status rejects invalid transition with INVALID_STATUS_TRANSITION and details', async () => {
    const taskId = await createTask('Invalid patch transition'); // ASSIGNED by default
    const res = await jsonRequest(taskUrl(taskId), {
      method: 'PATCH',
      headers: auth(pm),
      body: JSON.stringify({ status: 'SUBMITTED' }),
      jar: pm.jar,
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error?.code, 'INVALID_STATUS_TRANSITION');
    assert.deepEqual(res.body.error?.details, { from: 'ASSIGNED', to: 'SUBMITTED' });
  });

  test('PATCH status allows same-status updates', async () => {
    const taskId = await createTask('Same status patch');
    const res = await jsonRequest(taskUrl(taskId), {
      method: 'PATCH',
      headers: auth(pm),
      body: JSON.stringify({ status: 'ASSIGNED', title: 'Same status patch renamed' }),
      jar: pm.jar,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body.data as { status: string }).status, 'ASSIGNED');
  });

  test('complete allows existing behavior (ASSIGNED -> APPROVED) and reopen returns to IN_PROGRESS', async () => {
    const taskId = await createTask('Complete and reopen');
    const complete = await jsonRequest(`${taskUrl(taskId)}/complete`, {
      method: 'POST',
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.equal(complete.status, 200, JSON.stringify(complete.body));
    assert.equal((complete.body.data as { status: string }).status, 'APPROVED');

    const reopen = await jsonRequest(`${taskUrl(taskId)}/reopen`, {
      method: 'POST',
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.equal(reopen.status, 200, JSON.stringify(reopen.body));
    assert.equal((reopen.body.data as { status: string }).status, 'IN_PROGRESS');
  });

  test('submit rejects invalid transition with INVALID_STATUS_TRANSITION when state is not submit-eligible', async () => {
    const taskId = await createTask('Submit after approved');
    const complete = await jsonRequest(`${taskUrl(taskId)}/complete`, {
      method: 'POST',
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.equal(complete.status, 200, JSON.stringify(complete.body));

    const submit = await jsonRequest(`${taskUrl(taskId)}/submit`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ workSummary: 'Trying to submit approved task' }),
      jar: pm.jar,
    });
    // Existing submit guard rejects non-submit states; matrix enforcement also rejects APPROVED -> SUBMITTED.
    assert.equal(submit.status, 409, JSON.stringify(submit.body));
    assert.ok(
      ['TASK_SUBMIT_NOT_ALLOWED', 'INVALID_STATUS_TRANSITION'].includes(submit.body.error?.code),
      JSON.stringify(submit.body),
    );
  });
}
