import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { installOutboxEmailSender, resetEmailServices } from '../src/services/email';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { loadTestConfig } from './helpers/test-config';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE4_TASK_BLOCKERS_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  test('Phase 4 task blockers PostgreSQL tests skipped — set RUN_PHASE4_TASK_BLOCKERS_DB_TESTS=true to run', () => {});
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
  let collaborator: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let workspaceId: string;
  let projectId: string;
  let taskId: string;
  let blockerId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}`, 'x-csrf-token': user.jar.get('nexus_csrf') ?? '' });
  const blockersUrl = () => `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}/blockers`;

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `p4b-${suffix}-${tag}@test.example`;
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
      RATE_LIMIT_NAMESPACE: `phase4-task-blockers-db-${tag}`,
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
    collaborator = await register('Collab', 'collab');
    viewer = await register('Viewer', 'viewer');
    outsider = await register('Outsider', 'outsider');

    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST', headers: auth(pm), body: JSON.stringify({ name: `P4B WS ${tag}`, type: 'COMPANY' }), jar: pm.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);

    await addWorkspaceMember(memberAssignee);
    await addWorkspaceMember(memberOther);
    await addWorkspaceMember(collaborator);
    await addWorkspaceMember(viewer);
    await addWorkspaceMember(outsider);

    const projectResponse = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects`, {
      method: 'POST', headers: auth(pm), body: JSON.stringify({ name: 'Phase 4B Project', key: `P4B${String(tag).slice(-4)}`, visibility: 'WORKSPACE' }), jar: pm.jar,
    });
    assert.equal(projectResponse.status, 201, JSON.stringify(projectResponse.body));
    projectId = (projectResponse.body.data as { id: string }).id;

    await addProjectMember(memberAssignee, 'MEMBER');
    await addProjectMember(memberOther, 'MEMBER');
    await addProjectMember(collaborator, 'COLLABORATOR');
    await addProjectMember(viewer, 'VIEWER');

    const taskRes = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`, {
      method: 'POST', headers: auth(pm), body: JSON.stringify({ title: 'Blocked Task', assigneeIds: [memberAssignee.id, collaborator.id] }), jar: pm.jar,
    });
    assert.equal(taskRes.status, 201, JSON.stringify(taskRes.body));
    taskId = (taskRes.body.data as { id: string }).id;
  });

  after(async () => {
    await server.close();
    await disconnectRedis();
    await resetEmailServices();
    const db = await connectTestDatabase(rawDbUrl);
    await db.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await db.prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.prisma.taskBlocker.deleteMany({ where: { taskId } });
    await db.prisma.task.deleteMany({ where: { projectId } });
    await db.prisma.project.deleteMany({ where: { id: projectId } });
    await db.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
  });

  test('list blockers: allowed for viewer, denied for outsider', async () => {
    const ok = await jsonRequest(blockersUrl(), { headers: auth(viewer), jar: viewer.jar });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual((ok.body.data as { items: unknown[]; hasOpenBlocker: boolean }).items, []);
    const denied = await jsonRequest(blockersUrl(), { headers: auth(outsider), jar: outsider.jar });
    assert.ok([403, 404].includes(denied.status), JSON.stringify(denied.body));
  });

  test('report: only assigned member can report; notifies task owner and chosen user', async () => {
    const nonAssignee = await jsonRequest(blockersUrl(), {
      method: 'POST', headers: auth(memberOther), body: JSON.stringify({ description: 'Nope' }), jar: memberOther.jar,
    });
    assert.equal(nonAssignee.status, 403, JSON.stringify(nonAssignee.body));

    const viewerReport = await jsonRequest(blockersUrl(), {
      method: 'POST', headers: auth(viewer), body: JSON.stringify({ description: 'Nope' }), jar: viewer.jar,
    });
    assert.equal(viewerReport.status, 403, JSON.stringify(viewerReport.body));

    const reported = await jsonRequest(blockersUrl(), {
      method: 'POST', headers: auth(memberAssignee),
      body: JSON.stringify({ description: 'Waiting on API access', notifyUserId: pm.id }),
      jar: memberAssignee.jar,
    });
    assert.equal(reported.status, 201, JSON.stringify(reported.body));
    const body = reported.body.data as { id: string; status: string; hasOpenBlocker?: boolean };
    blockerId = body.id;
    assert.equal(body.status, 'OPEN');

    const list = await jsonRequest(blockersUrl(), { headers: auth(viewer), jar: viewer.jar });
    assert.equal(list.status, 200);
    const listData = list.body.data as { items: Array<{ id: string }>; hasOpenBlocker: boolean };
    assert.ok(listData.items.some((b) => b.id === blockerId));
    assert.equal(listData.hasOpenBlocker, true);

    const db = await connectTestDatabase(rawDbUrl);
    const pmNotifs = await db.prisma.notification.findMany({ where: { userId: pm.id, type: 'TASK_BLOCKER_REPORTED' } });
    assert.ok(pmNotifs.length >= 1);
    await db.prisma.$disconnect();
  });

  test('resolve: reporter can resolve and notifies? reporter resolving own should not self-notify; others restricted', async () => {
    // create another blocker reported by collaborator (assignee)
    const collabReport = await jsonRequest(blockersUrl(), {
      method: 'POST', headers: auth(collaborator), body: JSON.stringify({ description: 'Need design' }), jar: collaborator.jar,
    });
    assert.equal(collabReport.status, 201, JSON.stringify(collabReport.body));
    const collabBlockerId = (collabReport.body.data as { id: string }).id;

    const memberOtherResolve = await jsonRequest(`${blockersUrl()}/${collabBlockerId}/resolve`, {
      method: 'POST', headers: auth(memberOther), body: JSON.stringify({}), jar: memberOther.jar,
    });
    assert.equal(memberOtherResolve.status, 403, JSON.stringify(memberOtherResolve.body));

    // task owner/PM can resolve
    const pmResolve = await jsonRequest(`${blockersUrl()}/${collabBlockerId}/resolve`, {
      method: 'POST', headers: auth(pm), body: JSON.stringify({}), jar: pm.jar,
    });
    assert.equal(pmResolve.status, 200, JSON.stringify(pmResolve.body));
    assert.equal((pmResolve.body.data as { status: string }).status, 'RESOLVED');

    const db = await connectTestDatabase(rawDbUrl);
    const reporterNotifs = await db.prisma.notification.findMany({ where: { userId: collaborator.id, type: 'TASK_BLOCKER_RESOLVED' } });
    assert.ok(reporterNotifs.length >= 1);
    await db.prisma.$disconnect();

    // reporter can resolve own blocker
    const ownResolve = await jsonRequest(`${blockersUrl()}/${blockerId}/resolve`, {
      method: 'POST', headers: auth(memberAssignee), body: JSON.stringify({}), jar: memberAssignee.jar,
    });
    assert.equal(ownResolve.status, 200, JSON.stringify(ownResolve.body));
    assert.equal((ownResolve.body.data as { status: string }).status, 'RESOLVED');
  });

  test('workspace payload includes reported blockers and hasOpenBlocker additively', async () => {
    // create a fresh open blocker
    const reported = await jsonRequest(blockersUrl(), {
      method: 'POST', headers: auth(memberAssignee), body: JSON.stringify({ description: 'Still blocked' }), jar: memberAssignee.jar,
    });
    assert.equal(reported.status, 201);
    const ws = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}/workspace`, {
      headers: auth(memberAssignee), jar: memberAssignee.jar,
    });
    assert.equal(ws.status, 200, JSON.stringify(ws.body));
    const task = (ws.body.data as { task: { reportedBlockers?: unknown[]; hasOpenBlocker?: boolean } }).task;
    assert.equal(task.hasOpenBlocker, true);
    assert.ok(Array.isArray(task.reportedBlockers));
  });
}
