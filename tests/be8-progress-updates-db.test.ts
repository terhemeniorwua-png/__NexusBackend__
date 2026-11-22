import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { installOutboxEmailSender, resetEmailServices } from '../src/services/email';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { loadTestConfig } from './helpers/test-config';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_BE8_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('BE-8 task progress updates PostgreSQL tests', () =>
    test('skipped — set RUN_BE8_DB_TESTS=true to run', () => {}));
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
  let member: TestUser;
  let manager: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let workspaceId: string;
  let projectId: string;
  let taskId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;
  let db: Awaited<ReturnType<typeof connectTestDatabase>>;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });
  const tasksUrl = () => `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`;
  const taskUrl = (id: string) => `${tasksUrl()}/${id}`;
  const progressUrl = (id: string) => `${taskUrl(id)}/progress-updates`;

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `be8-${suffix}-${tag}@test.example`;
    const password = 'TestPass123!';
    const jar = new CookieJar();
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
      jar,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
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
    const res = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/members`,
      {
        method: 'POST',
        headers: auth(pm),
        body: JSON.stringify({ email: user.email, role: 'MEMBER' }),
        jar: pm.jar,
      },
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  async function addProjectMember(user: TestUser, role: 'PROJECT_MANAGER' | 'MEMBER' | 'COLLABORATOR' | 'VIEWER') {
    const res = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/members`,
      {
        method: 'POST',
        headers: auth(pm),
        body: JSON.stringify({ userId: user.id, role }),
        jar: pm.jar,
      },
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  before(async () => {
    db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = loadTestConfig({
      RATE_LIMIT_NAMESPACE: `be8-progress-updates-db-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    installOutboxEmailSender(config);
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;

    pm = await register('PM', 'pm');
    member = await register('Member', 'member');
    manager = await register('Manager', 'manager');
    viewer = await register('Viewer', 'viewer');
    outsider = await register('Outsider', 'outsider');

    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ name: `BE8 WS ${tag}`, type: 'COMPANY' }),
      jar: pm.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);

    await addWorkspaceMember(member);
    await addWorkspaceMember(manager);
    await addWorkspaceMember(viewer);
    await addWorkspaceMember(outsider);

    const projectResponse = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/projects`,
      {
        method: 'POST',
        headers: auth(pm),
        body: JSON.stringify({ name: 'BE8 Project', key: `BE8${String(tag).slice(-4)}`, visibility: 'WORKSPACE' }),
        jar: pm.jar,
      },
    );
    assert.equal(projectResponse.status, 201, JSON.stringify(projectResponse.body));
    projectId = (projectResponse.body.data as { id: string }).id;

    await addProjectMember(member, 'MEMBER');
    await addProjectMember(manager, 'PROJECT_MANAGER');
    await addProjectMember(viewer, 'VIEWER');

    const createdTask = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Progress task', assigneeIds: [member.id] }),
      jar: pm.jar,
    });
    assert.equal(createdTask.status, 201, JSON.stringify(createdTask.body));
    taskId = (createdTask.body.data as { id: string }).id;

    // Put the task in a state where progress updates are allowed.
    await db.prisma.task.update({ where: { id: taskId }, data: { status: 'IN_PROGRESS' } });
  });

  after(async () => {
    await server.close();
    await disconnectRedis();
    await resetEmailServices();
    await db.prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.prisma.taskProgressUpdate.deleteMany({ where: { taskId } });
    await db.prisma.task.deleteMany({ where: { projectId } });
    await db.prisma.project.deleteMany({ where: { id: projectId } });
    await db.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
  });

  test('assignee can post a progress update (201) and it is returned', async () => {
    const res = await jsonRequest(progressUrl(taskId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: 'Started implementation', percent: 30 }),
      jar: member.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const data = res.body.data as { update: { id: string; taskId: string; authorId: string; note: string; percent: number | null; clientRequestId: string | null; createdAt: string } };
    assert.equal(data.update.taskId, taskId);
    assert.equal(data.update.authorId, member.id);
    assert.equal(data.update.note, 'Started implementation');
    assert.equal(data.update.percent, 30);
    assert.equal(data.update.clientRequestId, null);
    assert.ok(typeof data.update.id === 'string' && data.update.id.length > 0);
    assert.ok(typeof data.update.createdAt === 'string' && data.update.createdAt.length > 0);
  });

  test('progress update without percent is stored with null percent', async () => {
    const res = await jsonRequest(progressUrl(taskId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: 'No percent reported' }),
      jar: member.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const data = res.body.data as { update: { percent: number | null } };
    assert.equal(data.update.percent, null);
  });

  test('idempotent repeat with same clientRequestId returns existing row with 200', async () => {
    const clientRequestId = `cli-${tag}-1`;
    const first = await jsonRequest(progressUrl(taskId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: 'Idempotent note', percent: 10, clientRequestId }),
      jar: member.jar,
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const firstId = (first.body.data as { update: { id: string } }).update.id;

    const repeat = await jsonRequest(progressUrl(taskId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: 'Different note', percent: 99, clientRequestId }),
      jar: member.jar,
    });
    assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
    const repeatId = (repeat.body.data as { update: { id: string } }).update.id;
    assert.equal(repeatId, firstId);

    const rows = await db.prisma.taskProgressUpdate.findMany({
      where: { taskId, authorId: member.id, clientRequestId },
    });
    assert.equal(rows.length, 1);
  });

  test('viewer and manager who are not assignees cannot post (403)', async () => {
    for (const user of [viewer, manager]) {
      const res = await jsonRequest(progressUrl(taskId), {
        method: 'POST',
        headers: auth(user),
        body: JSON.stringify({ note: 'should not be allowed', percent: 50 }),
        jar: user.jar,
      });
      assert.equal(res.status, 403, `${user.email} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error.code, 'NOT_TASK_ASSIGNEE');
    }
  });

  test('non-assignee outsider is denied', async () => {
    const res = await jsonRequest(progressUrl(taskId), {
      method: 'POST',
      headers: auth(outsider),
      body: JSON.stringify({ note: 'outsider', percent: 10 }),
      jar: outsider.jar,
    });
    assert.ok([403, 404].includes(res.status), JSON.stringify(res.body));
  });

  test('removed assignee cannot post (403)', async () => {
    // Create a fresh task assigned to member, then remove the assignment.
    const fresh = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Removed assignee task', assigneeIds: [member.id] }),
      jar: pm.jar,
    });
    assert.equal(fresh.status, 201);
    const freshId = (fresh.body.data as { id: string }).id;
    await db.prisma.task.update({ where: { id: freshId }, data: { status: 'IN_PROGRESS' } });

    const unassign = await jsonRequest(`${taskUrl(freshId)}/assignees/${member.id}`, {
      method: 'DELETE',
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.ok([200, 204].includes(unassign.status), JSON.stringify(unassign.body));

    const res = await jsonRequest(progressUrl(freshId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: 'after removal', percent: 20 }),
      jar: member.jar,
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'NOT_TASK_ASSIGNEE');
  });

  test('wrong status returns 409 PROGRESS_UPDATE_NOT_ALLOWED', async () => {
    const notStarted = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Not started task', assigneeIds: [member.id] }),
      jar: pm.jar,
    });
    assert.equal(notStarted.status, 201);
    const notStartedId = (notStarted.body.data as { id: string }).id;
    // status defaults to ASSIGNED: updates are only allowed in IN_PROGRESS/CHANGES_REQUESTED.
    const res = await jsonRequest(progressUrl(notStartedId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: 'too early', percent: 5 }),
      jar: member.jar,
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'PROGRESS_UPDATE_NOT_ALLOWED');
  });

  test('archived or deleted task returns 404 TASK_NOT_FOUND', async () => {
    const archived = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Archived task', assigneeIds: [member.id] }),
      jar: pm.jar,
    });
    assert.equal(archived.status, 201);
    const archivedId = (archived.body.data as { id: string }).id;

    const deleted = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Deleted task', assigneeIds: [member.id] }),
      jar: pm.jar,
    });
    assert.equal(deleted.status, 201);
    const deletedId = (deleted.body.data as { id: string }).id;

    await jsonRequest(`${taskUrl(archivedId)}/archive`, { method: 'POST', headers: auth(pm), jar: pm.jar });
    await jsonRequest(`${taskUrl(deletedId)}`, { method: 'DELETE', headers: auth(pm), jar: pm.jar });

    const archivedRes = await jsonRequest(progressUrl(archivedId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: 'archived', percent: 1 }),
      jar: member.jar,
    });
    assert.equal(archivedRes.status, 404, JSON.stringify(archivedRes.body));
    assert.equal(archivedRes.body.error.code, 'TASK_NOT_FOUND');

    const deletedRes = await jsonRequest(progressUrl(deletedId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: 'deleted', percent: 1 }),
      jar: member.jar,
    });
    assert.equal(deletedRes.status, 404, JSON.stringify(deletedRes.body));
    assert.equal(deletedRes.body.error.code, 'TASK_NOT_FOUND');
  });

  test('400 for invalid note length and percent range', async () => {
    const longNote = 'x'.repeat(2001);
    const longNoteRes = await jsonRequest(progressUrl(taskId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: longNote, percent: 10 }),
      jar: member.jar,
    });
    assert.equal(longNoteRes.status, 400, JSON.stringify(longNoteRes.body));

    const emptyNoteRes = await jsonRequest(progressUrl(taskId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: '   ', percent: 10 }),
      jar: member.jar,
    });
    assert.equal(emptyNoteRes.status, 400, JSON.stringify(emptyNoteRes.body));

    const overPercentRes = await jsonRequest(progressUrl(taskId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: 'ok', percent: 101 }),
      jar: member.jar,
    });
    assert.equal(overPercentRes.status, 400, JSON.stringify(overPercentRes.body));

    const underPercentRes = await jsonRequest(progressUrl(taskId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: 'ok', percent: -1 }),
      jar: member.jar,
    });
    assert.equal(underPercentRes.status, 400, JSON.stringify(underPercentRes.body));
  });

  test('cursor pagination returns newest first with nextCursor', async () => {
    const created = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Pagination task', assigneeIds: [member.id] }),
      jar: pm.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const paginatedTaskId = (created.body.data as { id: string }).id;
    await db.prisma.task.update({ where: { id: paginatedTaskId }, data: { status: 'IN_PROGRESS' } });

    for (let i = 1; i <= 3; i++) {
      const res = await jsonRequest(progressUrl(paginatedTaskId), {
        method: 'POST',
        headers: auth(member),
        body: JSON.stringify({ note: `Page note ${i}`, percent: i * 10 }),
        jar: member.jar,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }

    const firstPage = await jsonRequest(progressUrl(paginatedTaskId) + '?limit=2', {
      headers: auth(member),
      jar: member.jar,
    });
    assert.equal(firstPage.status, 200, JSON.stringify(firstPage.body));
    const firstData = firstPage.body.data as { items: { id: string; note: string }[]; nextCursor: string | null };
    assert.equal(firstData.items.length, 2);
    assert.equal(firstData.items[0].note, 'Page note 3');
    assert.equal(firstData.items[1].note, 'Page note 2');
    assert.ok(typeof firstData.nextCursor === 'string');

    const secondPage = await jsonRequest(`${progressUrl(paginatedTaskId)}?limit=2&cursor=${encodeURIComponent(firstData.nextCursor)}`, {
      headers: auth(member),
      jar: member.jar,
    });
    assert.equal(secondPage.status, 200, JSON.stringify(secondPage.body));
    const secondData = secondPage.body.data as { items: { id: string; note: string }[]; nextCursor: string | null };
    assert.equal(secondData.items.length, 1);
    assert.equal(secondData.items[0].note, 'Page note 1');
    assert.equal(secondData.nextCursor, null);
  });

  test('task status and server-computed progress unchanged after posting', async () => {
    const stable = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Status stable task', assigneeIds: [member.id] }),
      jar: pm.jar,
    });
    assert.equal(stable.status, 201);
    const stableId = (stable.body.data as { id: string }).id;
    await db.prisma.task.update({ where: { id: stableId }, data: { status: 'IN_PROGRESS' } });

    await jsonRequest(progressUrl(stableId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: 'progress note', percent: 77 }),
      jar: member.jar,
    });

    const ws = await jsonRequest(`${taskUrl(stableId)}/workspace`, {
      headers: auth(member),
      jar: member.jar,
    });
    assert.equal(ws.status, 200, JSON.stringify(ws.body));
    const task = (ws.body.data as { task: { id: string; status: string }; progress: { percent: number } }).task;
    assert.equal(task.status, 'IN_PROGRESS');
    // Self-reported percent never changes computeProgress; no subtasks => 0%.
    assert.equal((ws.body.data as { progress: { percent: number } }).progress.percent, 0);
  });

  test('audit row written and no notification rows created', async () => {
    const notificationsBefore = await db.prisma.notification.count();

    const res = await jsonRequest(progressUrl(taskId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: 'audit check', percent: 40 }),
      jar: member.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const updateId = (res.body.data as { update: { id: string } }).update.id;

    const audit = await db.prisma.auditLog.findFirst({
      where: { action: 'task.progress_updated', targetType: 'TaskProgressUpdate', targetId: updateId },
    });
    assert.ok(audit, 'expected task.progress_updated audit row');
    assert.equal(audit.actorId, member.id);
    assert.equal(audit.workspaceId, workspaceId);
    assert.equal((audit.metadata as { taskId: string; projectId: string; percent: number | null }).taskId, taskId);
    assert.equal((audit.metadata as { projectId: string }).projectId, projectId);
    assert.equal((audit.metadata as { percent: number | null }).percent, 40);

    const notificationsAfter = await db.prisma.notification.count();
    assert.equal(notificationsAfter, notificationsBefore);
  });

  test('GET progress updates is readable by anyone with task view', async () => {
    await jsonRequest(progressUrl(taskId), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ note: 'readable', percent: 10 }),
      jar: member.jar,
    });

    for (const user of [pm, member, manager, viewer]) {
      const res = await jsonRequest(progressUrl(taskId), { headers: auth(user), jar: user.jar });
      assert.equal(res.status, 200, `${user.email} ${JSON.stringify(res.body)}`);
      assert.ok(Array.isArray((res.body.data as { items: unknown[] }).items));
    }

    const realOutsider = await register('RealOutsider', 'realoutsider-progress');
    const outsiderRes = await jsonRequest(progressUrl(taskId), { headers: auth(realOutsider), jar: realOutsider.jar });
    assert.ok([403, 404].includes(outsiderRes.status), JSON.stringify(outsiderRes.body));
  });

  test('PostgreSQL CHECK constraints reject out-of-range values directly', async () => {
    await assert.rejects(
      db.prisma.taskProgressUpdate.create({
        data: { taskId, authorId: member.id, note: 'x'.repeat(2001) },
      }),
      /invalid input syntax|violates check constraint|check constraint/,
    );
    await assert.rejects(
      db.prisma.taskProgressUpdate.create({
        data: { taskId, authorId: member.id, note: 'ok', percent: 150 },
      }),
      /violates check constraint|check constraint/,
    );
    await assert.rejects(
      db.prisma.taskProgressUpdate.create({
        data: { taskId, authorId: member.id, note: 'ok', percent: -5 },
      }),
      /violates check constraint|check constraint/,
    );
  });
}
