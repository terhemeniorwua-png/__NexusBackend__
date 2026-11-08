import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE9_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Phase 9 tasks PostgreSQL tests', () =>
    test('skipped — set RUN_PHASE9_DB_TESTS=true to run', () => {}));
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
  let outsider: TestUser;
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
    const email = `p9-${suffix}-${tag}@test.example`;
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

  async function addWorkspaceMember(user: TestUser): Promise<void> {
    const response = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/members`,
      {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ email: user.email, role: 'MEMBER' }),
        jar: owner.jar,
      },
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = (await import('../src/config/env')).loadEnv({
      ...process.env,
      RATE_LIMIT_NAMESPACE: `phase9-db-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    owner = await register('Phase 9 Owner', 'owner');
    member = await register('Phase 9 Member', 'member');
    outsider = await register('Phase 9 Outsider', 'outsider');

    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: `Phase 9 WS ${tag}` }),
      jar: owner.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);

    await addWorkspaceMember(member);
    await addWorkspaceMember(outsider);

    // Make member a project member with MEMBER role so they can create tasks
    const projectResponse = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/projects`,
      {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ name: 'Phase 9 Project', key: `P9${tag.slice(-4)}`, visibility: 'WORKSPACE' }),
        jar: owner.jar,
      },
    );
    assert.equal(projectResponse.status, 201, JSON.stringify(projectResponse.body));
    projectId = (projectResponse.body.data as { id: string }).id;

    // Add member as a project member
    await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/members`,
      {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ userId: member.id, role: 'MEMBER' }),
        jar: owner.jar,
      },
    );
  });

  after(async () => {
    await server.close();
    await disconnectRedis();
    const db = await connectTestDatabase(rawDbUrl);
    await db.prisma.task.deleteMany({ where: { projectId } });
    await db.prisma.project.deleteMany({ where: { id: projectId } });
    await db.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
  });

  describe('Phase 9 task CRUD', () => {
    test('owner can create a task', async () => {
      const res = await jsonRequest(tasksUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ title: 'First Task', description: 'Test task', priority: 'HIGH' }),
        jar: owner.jar,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const data = res.body.data as { id: string; key: string; title: string; priority: string };
      assert.equal(data.title, 'First Task');
      assert.ok(data.key, 'task key should be generated');
    });

    test('member with project membership can create a task', async () => {
      const res = await jsonRequest(tasksUrl(), {
        method: 'POST',
        headers: auth(member),
        body: JSON.stringify({ title: 'Member Task', priority: 'MEDIUM' }),
        jar: member.jar,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal((res.body.data as { title: string }).title, 'Member Task');
    });

    test('outsider cannot create tasks', async () => {
      const res = await jsonRequest(tasksUrl(), {
        method: 'POST',
        headers: auth(outsider),
        body: JSON.stringify({ title: 'Should Fail' }),
        jar: outsider.jar,
      });
      assert.equal(res.status, 403);
    });

    test('can list tasks with filtering', async () => {
      // Create a task with a specific status
      await jsonRequest(tasksUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ title: 'List Test', status: 'IN_PROGRESS' }),
        jar: owner.jar,
      });

      const res = await jsonRequest(`${tasksUrl()}?status=IN_PROGRESS&limit=10`, {
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(res.status, 200);
      const data = res.body.data as { items: Array<{ title: string; status: string }> };
      assert.ok(data.items.length > 0, 'should find at least one IN_PROGRESS task');
      for (const task of data.items) {
        assert.equal(task.status, 'IN_PROGRESS');
      }
    });

    test('can get a single task', async () => {
      const create = await jsonRequest(tasksUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ title: 'Get Test' }),
        jar: owner.jar,
      });
      const taskId = (create.body.data as { id: string }).id;

      const res = await jsonRequest(taskUrl(taskId), {
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(res.status, 200);
      assert.equal((res.body.data as { title: string }).title, 'Get Test');
    });

    test('can update a task', async () => {
      const create = await jsonRequest(tasksUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ title: 'Update Me' }),
        jar: owner.jar,
      });
      const taskId = (create.body.data as { id: string }).id;

      const res = await jsonRequest(taskUrl(taskId), {
        method: 'PATCH',
        headers: auth(owner),
        body: JSON.stringify({ title: 'Updated Title', priority: 'URGENT' }),
        jar: owner.jar,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((res.body.data as { title: string }).title, 'Updated Title');
      assert.equal((res.body.data as { priority: string }).priority, 'URGENT');
    });

    test('can delete a task', async () => {
      const create = await jsonRequest(tasksUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ title: 'Delete Me' }),
        jar: owner.jar,
      });
      const taskId = (create.body.data as { id: string }).id;

      const res = await jsonRequest(taskUrl(taskId), {
        method: 'DELETE',
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(res.status, 200);
    });
  });

  describe('Phase 9 task lifecycle', () => {
    test('can archive and restore a task', async () => {
      const create = await jsonRequest(tasksUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ title: 'Archive Me' }),
        jar: owner.jar,
      });
      const taskId = (create.body.data as { id: string }).id;

      const archive = await jsonRequest(`${taskUrl(taskId)}/archive`, {
        method: 'POST',
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(archive.status, 200);

      const restore = await jsonRequest(`${taskUrl(taskId)}/restore`, {
        method: 'POST',
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(restore.status, 200);
    });

    test('can complete and reopen a task', async () => {
      const create = await jsonRequest(tasksUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ title: 'Complete Me' }),
        jar: owner.jar,
      });
      const taskId = (create.body.data as { id: string }).id;

      const complete = await jsonRequest(`${taskUrl(taskId)}/complete`, {
        method: 'POST',
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(complete.status, 200, JSON.stringify(complete.body));
      assert.equal((complete.body.data as { status: string }).status, 'APPROVED');
      assert.ok((complete.body.data as { completedAt: string }).completedAt);

      const reopen = await jsonRequest(`${taskUrl(taskId)}/reopen`, {
        method: 'POST',
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(reopen.status, 200, JSON.stringify(reopen.body));
      assert.equal((reopen.body.data as { status: string }).status, 'IN_PROGRESS');
      assert.equal((reopen.body.data as { completedAt: string | null }).completedAt, null);
    });
  });

  describe('Phase 9 assignee management', () => {
    test('can add and remove assignees', async () => {
      const create = await jsonRequest(tasksUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ title: 'Assign Me' }),
        jar: owner.jar,
      });
      const taskId = (create.body.data as { id: string }).id;

      const add = await jsonRequest(`${taskUrl(taskId)}/assignees`, {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ targetUserId: member.id }),
        jar: owner.jar,
      });
      assert.equal(add.status, 201, JSON.stringify(add.body));

      // Verify assignee is listed in the task
      const get = await jsonRequest(taskUrl(taskId), {
        headers: auth(owner),
        jar: owner.jar,
      });
      const assignees = (get.body.data as { assignees: Array<{ userId: string }> }).assignees;
      assert.ok(assignees.some((a) => a.userId === member.id));

      const remove = await jsonRequest(`${taskUrl(taskId)}/assignees/${member.id}`, {
        method: 'DELETE',
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(remove.status, 200);
    });
  });

  describe('Phase 9 dependencies', () => {
    test('can add and remove dependencies', async () => {
      const create1 = await jsonRequest(tasksUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ title: 'Dep Source' }),
        jar: owner.jar,
      });
      const create2 = await jsonRequest(tasksUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ title: 'Dep Target' }),
        jar: owner.jar,
      });
      const task1Id = (create1.body.data as { id: string }).id;
      const task2Id = (create2.body.data as { id: string }).id;

      const add = await jsonRequest(`${taskUrl(task1Id)}/dependencies`, {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ dependsOnTaskId: task2Id }),
        jar: owner.jar,
      });
      assert.equal(add.status, 201, JSON.stringify(add.body));

      const remove = await jsonRequest(`${taskUrl(task1Id)}/dependencies/${task2Id}`, {
        method: 'DELETE',
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(remove.status, 200);
    });

    test('cannot create a self-dependency', async () => {
      const create = await jsonRequest(tasksUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ title: 'Self Dep' }),
        jar: owner.jar,
      });
      const taskId = (create.body.data as { id: string }).id;

      const res = await jsonRequest(`${taskUrl(taskId)}/dependencies`, {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ dependsOnTaskId: taskId }),
        jar: owner.jar,
      });
      assert.equal(res.status, 400);
      assert.equal((res.body.error as { code: string }).code, 'TASK_SELF_DEPENDENCY');
    });
  });

  describe('Phase 9 comments', () => {
    test('can create, update, and delete comments', async () => {
      const create = await jsonRequest(tasksUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ title: 'Comment Task' }),
        jar: owner.jar,
      });
      const taskId = (create.body.data as { id: string }).id;

      const addComment = await jsonRequest(`${taskUrl(taskId)}/comments`, {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ body: 'Test comment' }),
        jar: owner.jar,
      });
      assert.equal(addComment.status, 201, JSON.stringify(addComment.body));
      const commentId = (addComment.body.data as { id: string }).id;

      const list = await jsonRequest(`${taskUrl(taskId)}/comments`, {
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(list.status, 200);
      assert.ok(((list.body.data as { items: unknown[] }).items).length > 0);

      // Update comment
      const update = await jsonRequest(`${taskUrl(taskId)}/comments/${commentId}`, {
        method: 'PATCH',
        headers: auth(owner),
        body: JSON.stringify({ body: 'Updated comment' }),
        jar: owner.jar,
      });
      assert.equal(update.status, 200, JSON.stringify(update.body));

      // Delete comment
      const del = await jsonRequest(`${taskUrl(taskId)}/comments/${commentId}`, {
        method: 'DELETE',
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(del.status, 200);
    });
  });
}
