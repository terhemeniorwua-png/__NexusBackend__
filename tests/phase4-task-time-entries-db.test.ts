import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { installOutboxEmailSender, resetEmailServices } from '../src/services/email';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { loadTestConfig } from './helpers/test-config';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE4_TASK_TIME_ENTRIES_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  test('Phase 4 task time entries PostgreSQL tests skipped — set RUN_PHASE4_TASK_TIME_ENTRIES_DB_TESTS=true to run', () => {});
} else {
  runTests(databaseUrl);
}

interface TestUser { id: string; email: string; token: string; jar: CookieJar; }

function runTests(rawDbUrl: string): void {
  let server: RunningServer;
  let baseUrl: string;
  let pm: TestUser;
  let memberAssignee: TestUser;
  let memberOther: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let workspaceId: string;
  let projectId: string;
  let taskId: string;
  let entryId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}`, 'x-csrf-token': user.jar.get('nexus_csrf') ?? '' });
  const timeUrl = (suffix = '') => `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}/time-entries${suffix}`;

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `p4c-${suffix}-${tag}@test.example`;
    const password = 'TestPass123!';
    const jar = new CookieJar();
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, { method: 'POST', body: JSON.stringify({ name, email, password }), jar });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const db = await connectTestDatabase(rawDbUrl);
    const user = await db.prisma.user.findUniqueOrThrow({ where: { email } });
    await db.prisma.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', emailVerifiedAt: new Date() } });
    await db.prisma.authToken.updateMany({ where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', usedAt: null }, data: { usedAt: new Date() } });
    await db.prisma.$disconnect();
    const login = await jsonRequest<{ accessToken: string }>(`${baseUrl}/api/v1/auth/login`, { method: 'POST', body: JSON.stringify({ email, password }), jar });
    assert.equal(login.status, 200);
    const token = (login.body.data as { accessToken: string }).accessToken;
    const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` }, jar });
    const id = (me.body.data as { user: { id: string } }).user.id;
    userIds.push(id);
    return { id, email, token, jar };
  }

  async function addWorkspaceMember(user: TestUser): Promise<void> {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/members`, {
      method: 'POST', headers: auth(pm), body: JSON.stringify({ email: user.email, role: 'MEMBER' }), jar: pm.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  async function addProjectMember(user: TestUser, role: 'PROJECT_MANAGER' | 'MEMBER' | 'COLLABORATOR' | 'VIEWER') {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/members`, {
      method: 'POST', headers: auth(pm), body: JSON.stringify({ userId: user.id, role }), jar: pm.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = loadTestConfig({
      RATE_LIMIT_NAMESPACE: `phase4-task-time-db-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    installOutboxEmailSender(config);
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    pm = await register('PM', 'pm');
    memberAssignee = await register('Assignee', 'assignee');
    memberOther = await register('Other', 'other');
    viewer = await register('Viewer', 'viewer');
    outsider = await register('Outsider', 'outsider');

    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST', headers: auth(pm), body: JSON.stringify({ name: `P4C WS ${tag}`, type: 'COMPANY' }), jar: pm.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);

    await addWorkspaceMember(memberAssignee);
    await addWorkspaceMember(memberOther);
    await addWorkspaceMember(viewer);
    // outsider is intentionally NOT a workspace member (true outsider)

    const projectResponse = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects`, {
      method: 'POST', headers: auth(pm), body: JSON.stringify({ name: 'Phase 4C Project', key: `P4C${String(tag).slice(-4)}`, visibility: 'WORKSPACE' }), jar: pm.jar,
    });
    assert.equal(projectResponse.status, 201, JSON.stringify(projectResponse.body));
    projectId = (projectResponse.body.data as { id: string }).id;

    await addProjectMember(memberAssignee, 'MEMBER');
    await addProjectMember(memberOther, 'MEMBER');
    await addProjectMember(viewer, 'VIEWER');

    const taskRes = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`, {
      method: 'POST', headers: auth(pm), body: JSON.stringify({ title: 'Timed Task', assigneeIds: [memberAssignee.id] }), jar: pm.jar,
    });
    assert.equal(taskRes.status, 201, JSON.stringify(taskRes.body));
    taskId = (taskRes.body.data as { id: string }).id;
  });

  after(async () => {
    await server.close();
    await disconnectRedis();
    await resetEmailServices();
    const db = await connectTestDatabase(rawDbUrl);
    await db.prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.prisma.taskTimeEntry.deleteMany({ where: { taskId } });
    await db.prisma.task.deleteMany({ where: { projectId } });
    await db.prisma.project.deleteMany({ where: { id: projectId } });
    await db.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
  });

  test('all time entry endpoints rejected when time tracking is off', async () => {
    const list = await jsonRequest(timeUrl(), { headers: auth(memberAssignee), jar: memberAssignee.jar });
    assert.equal(list.status, 409, JSON.stringify(list.body));
    assert.equal((list.body.error as { code: string }).code, 'TIME_TRACKING_DISABLED');

    const log = await jsonRequest(timeUrl(), {
      method: 'POST', headers: auth(memberAssignee), jar: memberAssignee.jar,
      body: JSON.stringify({ startedAt: new Date().toISOString(), durationMinutes: 30 }),
    });
    assert.equal(log.status, 409, JSON.stringify(log.body));
  });

  test('workspace toggle enables time tracking and exposes setting', async () => {
    const offGet = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}`, { headers: auth(pm), jar: pm.jar });
    assert.equal(offGet.status, 200);
    assert.equal((offGet.body.data as { timeTrackingEnabled: boolean }).timeTrackingEnabled, false);

    const updated = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}`, {
      method: 'PATCH', headers: auth(pm), jar: pm.jar,
      body: JSON.stringify({ timeTrackingEnabled: true }),
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal((updated.body.data as { timeTrackingEnabled: boolean }).timeTrackingEnabled, true);
  });

  test('list and log when enabled; role/permission checks', async () => {
    const viewerList = await jsonRequest(timeUrl(), { headers: auth(viewer), jar: viewer.jar });
    assert.equal(viewerList.status, 200, JSON.stringify(viewerList.body));
    const empty = viewerList.body.data as { items: unknown[]; totalMinutes: number };
    assert.equal(empty.totalMinutes, 0);
    assert.equal(empty.items.length, 0);

    const outsiderList = await jsonRequest(timeUrl(), { headers: auth(outsider), jar: outsider.jar });
    console.log(`OUTSIDER_TIME_ENTRIES status=${outsiderList.status} body=${JSON.stringify(outsiderList.body)}`);
    assert.ok([403, 404].includes(outsiderList.status), JSON.stringify(outsiderList.body));

    // viewer cannot log (not assignee, no task update)
    const viewerLog = await jsonRequest(timeUrl(), {
      method: 'POST', headers: auth(viewer), jar: viewer.jar,
      body: JSON.stringify({ startedAt: new Date().toISOString(), durationMinutes: 15, note: 'x' }),
    });
    assert.equal(viewerLog.status, 403, JSON.stringify(viewerLog.body));

    // assignee can log
    const assigneeLog = await jsonRequest(timeUrl(), {
      method: 'POST', headers: auth(memberAssignee), jar: memberAssignee.jar,
      body: JSON.stringify({ startedAt: new Date().toISOString(), durationMinutes: 45, note: 'work' }),
    });
    assert.equal(assigneeLog.status, 201, JSON.stringify(assigneeLog.body));
    entryId = (assigneeLog.body.data as { id: string; userId: string; durationMinutes: number }).id;
    assert.equal((assigneeLog.body.data as { userId: string }).userId, memberAssignee.id);
    assert.equal((assigneeLog.body.data as { durationMinutes: number }).durationMinutes, 45);

    // PM/manager with task update can log own time
    const pmLog = await jsonRequest(timeUrl(), {
      method: 'POST', headers: auth(pm), jar: pm.jar,
      body: JSON.stringify({ startedAt: new Date().toISOString(), durationMinutes: 20 }),
    });
    assert.equal(pmLog.status, 201, JSON.stringify(pmLog.body));

    const list = await jsonRequest(timeUrl(), { headers: auth(viewer), jar: viewer.jar });
    assert.equal(list.status, 200);
    const data = list.body.data as { items: Array<{ id: string }>; totalMinutes: number };
    assert.equal(data.totalMinutes, 65);
    assert.ok(data.items.some((i) => i.id === entryId));
  });

  test('edit/delete own only; others (including PM) cannot modify another user entry', async () => {
    const pmEdit = await jsonRequest(timeUrl(`/${entryId}`), {
      method: 'PATCH', headers: auth(pm), jar: pm.jar,
      body: JSON.stringify({ durationMinutes: 60 }),
    });
    assert.equal(pmEdit.status, 403, JSON.stringify(pmEdit.body));

    const otherEdit = await jsonRequest(timeUrl(`/${entryId}`), {
      method: 'PATCH', headers: auth(memberOther), jar: memberOther.jar,
      body: JSON.stringify({ durationMinutes: 60 }),
    });
    assert.equal(otherEdit.status, 403, JSON.stringify(otherEdit.body));

    const ownEdit = await jsonRequest(timeUrl(`/${entryId}`), {
      method: 'PATCH', headers: auth(memberAssignee), jar: memberAssignee.jar,
      body: JSON.stringify({ durationMinutes: 50, note: 'updated' }),
    });
    assert.equal(ownEdit.status, 200, JSON.stringify(ownEdit.body));
    assert.equal((ownEdit.body.data as { durationMinutes: number }).durationMinutes, 50);

    const pmDelete = await jsonRequest(timeUrl(`/${entryId}`), {
      method: 'DELETE', headers: auth(pm), jar: pm.jar,
    });
    assert.equal(pmDelete.status, 403, JSON.stringify(pmDelete.body));

    const ownDelete = await jsonRequest(timeUrl(`/${entryId}`), {
      method: 'DELETE', headers: auth(memberAssignee), jar: memberAssignee.jar,
    });
    assert.equal(ownDelete.status, 200, JSON.stringify(ownDelete.body));
    assert.deepEqual(ownDelete.body.data, { id: entryId, deleted: true });

    const list = await jsonRequest(timeUrl(), { headers: auth(viewer), jar: viewer.jar });
    assert.equal(list.status, 200);
    const data = list.body.data as { items: Array<{ id: string }>; totalMinutes: number };
    assert.ok(!data.items.some((i) => i.id === entryId));
    assert.equal(data.totalMinutes, 20);
  });
}
