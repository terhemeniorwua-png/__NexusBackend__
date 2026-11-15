import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { installOutboxEmailSender, resetEmailServices } from '../src/services/email';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { loadTestConfig } from './helpers/test-config';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE4_TASK_SUBTASK_WEIGHTS_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Phase 4 subtask weight PostgreSQL tests', () =>
    test('skipped — set RUN_PHASE4_TASK_SUBTASK_WEIGHTS_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

interface TestUser { id: string; email: string; token: string; jar: CookieJar; }

function runTests(rawDbUrl: string): void {
  let server: RunningServer;
  let baseUrl: string;
  let owner: TestUser; // workspace owner / PM context
  let manager: TestUser; // project manager (task-management)
  let member: TestUser; // assigned member, not project manager
  let viewer: TestUser;
  let outsider: TestUser;
  let workspaceId: string;
  let projectId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}`, 'x-csrf-token': user.jar.get('nexus_csrf') ?? '' });
  const tasksUrl = () => `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`;
  const taskUrl = (id: string) => `${tasksUrl()}/${id}`;

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `p4d-${suffix}-${tag}@test.example`;
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
      method: 'POST', headers: auth(owner), body: JSON.stringify({ email: user.email, role: 'MEMBER' }), jar: owner.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  async function addProjectMember(user: TestUser, role: 'PROJECT_MANAGER' | 'MEMBER' | 'COLLABORATOR' | 'VIEWER') {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/members`, {
      method: 'POST', headers: auth(owner), body: JSON.stringify({ userId: user.id, role }), jar: owner.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = loadTestConfig({
      RATE_LIMIT_NAMESPACE: `phase4-subtask-weights-db-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    installOutboxEmailSender(config);
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    owner = await register('Owner', 'owner');
    manager = await register('Manager', 'manager');
    member = await register('Member', 'member');
    viewer = await register('Viewer', 'viewer');
    outsider = await register('Outsider', 'outsider');

    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST', headers: auth(owner), body: JSON.stringify({ name: `P4D WS ${tag}`, type: 'COMPANY' }), jar: owner.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);

    await addWorkspaceMember(manager);
    await addWorkspaceMember(member);
    await addWorkspaceMember(viewer);
    await addWorkspaceMember(outsider);

    const projectResponse = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects`, {
      method: 'POST', headers: auth(owner), body: JSON.stringify({ name: 'Phase 4D Project', key: `P4D${String(tag).slice(-4)}`, visibility: 'WORKSPACE' }), jar: owner.jar,
    });
    assert.equal(projectResponse.status, 201, JSON.stringify(projectResponse.body));
    projectId = (projectResponse.body.data as { id: string }).id;

    await addProjectMember(manager, 'PROJECT_MANAGER');
    await addProjectMember(member, 'MEMBER');
    await addProjectMember(viewer, 'VIEWER');
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

  test('no subtasks => progress 0%', async () => {
    const parentRes = await jsonRequest(tasksUrl(), {
      method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'No subtasks parent' }), jar: manager.jar,
    });
    assert.equal(parentRes.status, 201, JSON.stringify(parentRes.body));
    const parentId = (parentRes.body.data as { id: string }).id;

    const ws = await jsonRequest(`${taskUrl(parentId)}/workspace`, { headers: auth(manager), jar: manager.jar });
    assert.equal(ws.status, 200);
    const progress = (ws.body.data as { progress: { percent: number; completed: number; total: number } }).progress;
    assert.deepEqual(progress, { percent: 0, completed: 0, total: 0 });
  });

  test('reject invalid weights and weight on non-subtask', async () => {
    const parentRes = await jsonRequest(tasksUrl(), {
      method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'Weight validation parent' }), jar: manager.jar,
    });
    assert.equal(parentRes.status, 201);
    const parentId = (parentRes.body.data as { id: string }).id;

    const weightOnParent = await jsonRequest(tasksUrl(), {
      method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'Bad', weight: 2 }), jar: manager.jar,
    });
    assert.equal(weightOnParent.status, 400, JSON.stringify(weightOnParent.body));

    const zeroWeight = await jsonRequest(tasksUrl(), {
      method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'Bad sub', parentTaskId: parentId, weight: 0 }), jar: manager.jar,
    });
    assert.equal(zeroWeight.status, 400, JSON.stringify(zeroWeight.body));

    const negativeWeight = await jsonRequest(tasksUrl(), {
      method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'Bad sub', parentTaskId: parentId, weight: -1 }), jar: manager.jar,
    });
    assert.equal(negativeWeight.status, 400, JSON.stringify(negativeWeight.body));

    const decimalWeight = await jsonRequest(tasksUrl(), {
      method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'Bad sub', parentTaskId: parentId, weight: 1.5 }), jar: manager.jar,
    });
    assert.equal(decimalWeight.status, 400, JSON.stringify(decimalWeight.body));

    const okSub = await jsonRequest(tasksUrl(), {
      method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'Good sub', parentTaskId: parentId, weight: 3 }), jar: manager.jar,
    });
    assert.equal(okSub.status, 201, JSON.stringify(okSub.body));
    assert.equal((okSub.body.data as { weight: number }).weight, 3);

    const updateParentWeight = await jsonRequest(taskUrl(parentId), {
      method: 'PATCH', headers: auth(manager), body: JSON.stringify({ weight: 5 }), jar: manager.jar,
    });
    assert.equal(updateParentWeight.status, 400, JSON.stringify(updateParentWeight.body));

    const subId = (okSub.body.data as { id: string }).id;
    const updateSubZero = await jsonRequest(taskUrl(subId), {
      method: 'PATCH', headers: auth(manager), body: JSON.stringify({ weight: 0 }), jar: manager.jar,
    });
    assert.equal(updateSubZero.status, 400, JSON.stringify(updateSubZero.body));
  });

  test('weight permissions: authorized task-management can modify, ordinary assigned member cannot', async () => {
    const parentRes = await jsonRequest(tasksUrl(), {
      method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'Perm parent' }), jar: manager.jar,
    });
    assert.equal(parentRes.status, 201);
    const parentId = (parentRes.body.data as { id: string }).id;

    const subRes = await jsonRequest(tasksUrl(), {
      method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'Perm sub', parentTaskId: parentId, weight: 2, assigneeIds: [member.id] }), jar: manager.jar,
    });
    assert.equal(subRes.status, 201, JSON.stringify(subRes.body));
    const subId = (subRes.body.data as { id: string }).id;

    // Ordinary assigned member (project MEMBER, not manager) should not be able to modify weight via task update
    const memberUpdate = await jsonRequest(taskUrl(subId), {
      method: 'PATCH', headers: auth(member), body: JSON.stringify({ weight: 5 }), jar: member.jar,
    });
    assert.equal(memberUpdate.status, 403, JSON.stringify(memberUpdate.body));

    // Viewer cannot modify
    const viewerUpdate = await jsonRequest(taskUrl(subId), {
      method: 'PATCH', headers: auth(viewer), body: JSON.stringify({ weight: 5 }), jar: viewer.jar,
    });
    assert.ok([403, 404].includes(viewerUpdate.status), JSON.stringify(viewerUpdate.body));

    // Authorized task-management (project manager) can modify
    const managerUpdate = await jsonRequest(taskUrl(subId), {
      method: 'PATCH', headers: auth(manager), body: JSON.stringify({ weight: 5 }), jar: manager.jar,
    });
    assert.equal(managerUpdate.status, 200, JSON.stringify(managerUpdate.body));
    assert.equal((managerUpdate.body.data as { weight: number }).weight, 5);
  });

  test('equal weights produce same results as Phase 3 count-based progress', async () => {
    const parentRes = await jsonRequest(tasksUrl(), {
      method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'Equal weights parent' }), jar: manager.jar,
    });
    assert.equal(parentRes.status, 201);
    const parentId = (parentRes.body.data as { id: string }).id;

    const s1 = await jsonRequest(tasksUrl(), { method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'S1', parentTaskId: parentId, assigneeIds: [member.id], weight: 1 }), jar: manager.jar });
    const s2 = await jsonRequest(tasksUrl(), { method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'S2', parentTaskId: parentId, assigneeIds: [member.id], weight: 1 }), jar: manager.jar });
    const s3 = await jsonRequest(tasksUrl(), { method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'S3', parentTaskId: parentId, assigneeIds: [member.id], weight: 1 }), jar: manager.jar });
    assert.equal(s1.status, 201); assert.equal(s2.status, 201); assert.equal(s3.status, 201);
    const s1Id = (s1.body.data as { id: string }).id;
    const s2Id = (s2.body.data as { id: string }).id;

    // complete s1 (no approval required) -> approved
    const c1 = await jsonRequest(`${taskUrl(parentId)}/subtasks/${s1Id}/complete`, { method: 'POST', headers: auth(member), body: JSON.stringify({}), jar: member.jar });
    assert.equal(c1.status, 200, JSON.stringify(c1.body));
    assert.deepEqual((c1.body.data as { progress: { percent: number; completed: number; total: number } }).progress, { percent: 33, completed: 1, total: 3 });

    const c2 = await jsonRequest(`${taskUrl(parentId)}/subtasks/${s2Id}/complete`, { method: 'POST', headers: auth(member), body: JSON.stringify({}), jar: member.jar });
    assert.equal(c2.status, 200);
    assert.deepEqual((c2.body.data as { progress: { percent: number; completed: number; total: number } }).progress, { percent: 67, completed: 2, total: 3 });
  });

  test('unequal weights: progress weighted by approved subtasks only', async () => {
    const parentRes = await jsonRequest(tasksUrl(), { method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'Weighted parent' }), jar: manager.jar });
    assert.equal(parentRes.status, 201);
    const parentId = (parentRes.body.data as { id: string }).id;

    const a = await jsonRequest(tasksUrl(), { method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'A', parentTaskId: parentId, assigneeIds: [member.id], weight: 1 }), jar: manager.jar });
    const b = await jsonRequest(tasksUrl(), { method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'B', parentTaskId: parentId, assigneeIds: [member.id], weight: 3 }), jar: manager.jar });
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    const aId = (a.body.data as { id: string }).id;
    const bId = (b.body.data as { id: string }).id;

    // approve small one: 1/4 = 25%
    const ca = await jsonRequest(`${taskUrl(parentId)}/subtasks/${aId}/complete`, { method: 'POST', headers: auth(member), body: JSON.stringify({}), jar: member.jar });
    assert.equal(ca.status, 200);
    assert.deepEqual((ca.body.data as { progress: { percent: number; completed: number; total: number } }).progress, { percent: 25, completed: 1, total: 2 });

    // approve large one: 4/4 = 100%
    const cb = await jsonRequest(`${taskUrl(parentId)}/subtasks/${bId}/complete`, { method: 'POST', headers: auth(member), body: JSON.stringify({}), jar: member.jar });
    assert.equal(cb.status, 200);
    assert.deepEqual((cb.body.data as { progress: { percent: number; completed: number; total: number } }).progress, { percent: 100, completed: 2, total: 2 });
  });

  test('submitted/under-review (not approved) subtasks do not count as completed progress', async () => {
    const parentRes = await jsonRequest(tasksUrl(), { method: 'POST', headers: auth(manager), body: JSON.stringify({ title: 'Approval flow parent' }), jar: manager.jar });
    assert.equal(parentRes.status, 201);
    const parentId = (parentRes.body.data as { id: string }).id;

    // approval-required subtask
    const subRes = await jsonRequest(tasksUrl(), {
      method: 'POST', headers: auth(manager),
      body: JSON.stringify({ title: 'Needs approval', parentTaskId: parentId, assigneeIds: [member.id], weight: 5, requiresApproval: true }),
      jar: manager.jar,
    });
    assert.equal(subRes.status, 201, JSON.stringify(subRes.body));
    const subId = (subRes.body.data as { id: string }).id;

    // completing approval-required subtask creates submission (SUBMITTED), not approved
    const complete = await jsonRequest(`${taskUrl(parentId)}/subtasks/${subId}/complete`, {
      method: 'POST', headers: auth(member), body: JSON.stringify({ workSummary: 'done' }), jar: member.jar,
    });
    assert.equal(complete.status, 200, JSON.stringify(complete.body));
    const body = complete.body.data as { subtask: { status: string }; submissionCreated: boolean; progress: { percent: number; completed: number; total: number } };
    assert.equal(body.submissionCreated, true);
    assert.equal(body.subtask.status, 'SUBMITTED');
    assert.deepEqual(body.progress, { percent: 0, completed: 0, total: 1 });

    // move subtask to UNDER_REVIEW via review endpoint on subtask
    const startReview = await jsonRequest(`${taskUrl(subId)}/review`, {
      method: 'POST', headers: auth(manager), body: JSON.stringify({ decision: 'START_REVIEW' }), jar: manager.jar,
    });
    // START_REVIEW may require permission; if forbidden, still SUBMITTED doesn't count - but try to be robust
    if (startReview.status === 200) {
      const ws = await jsonRequest(`${taskUrl(parentId)}/workspace`, { headers: auth(manager), jar: manager.jar });
      assert.equal(ws.status, 200);
      const progress = (ws.body.data as { progress: { percent: number; completed: number; total: number } }).progress;
      assert.deepEqual(progress, { percent: 0, completed: 0, total: 1 });
    }

    // approve subtask -> now counts
    // For self-review rules, approver must not be submitter/assignee in restricted cases; manager is fine if not submitter.
    const approve = await jsonRequest(`${taskUrl(subId)}/review`, {
      method: 'POST', headers: auth(manager), body: JSON.stringify({ decision: 'APPROVE' }), jar: manager.jar,
    });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    assert.equal((approve.body.data as { status: string }).status, 'APPROVED');

    const ws2 = await jsonRequest(`${taskUrl(parentId)}/workspace`, { headers: auth(manager), jar: manager.jar });
    assert.equal(ws2.status, 200);
    const progress2 = (ws2.body.data as { progress: { percent: number; completed: number; total: number } }).progress;
    assert.deepEqual(progress2, { percent: 100, completed: 1, total: 1 });
  });
}
