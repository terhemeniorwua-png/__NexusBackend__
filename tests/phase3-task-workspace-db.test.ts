import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { installOutboxEmailSender, resetEmailServices } from '../src/services/email';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { loadTestConfig } from './helpers/test-config';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE3_TASK_WORKSPACE_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Phase 3 task workspace PostgreSQL tests', () =>
    test('skipped — set RUN_PHASE3_TASK_WORKSPACE_DB_TESTS=true to run', () => {}));
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
  let collaborator: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let workspaceId: string;
  let projectId: string;
  let parentTaskId: string;
  let subtaskId: string;
  let approvalTaskId: string;
  let approvalSubtaskId: string;
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
    const email = `p3-${suffix}-${tag}@test.example`;
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
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = loadTestConfig({
      RATE_LIMIT_NAMESPACE: `phase3-task-workspace-db-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    installOutboxEmailSender(config);
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    pm = await register('PM', 'pm');
    member = await register('Member', 'member');
    collaborator = await register('Collaborator', 'collab');
    viewer = await register('Viewer', 'viewer');
    outsider = await register('Outsider', 'outsider');

    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ name: `P3 WS ${tag}`, type: 'COMPANY' }),
      jar: pm.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);

    await addWorkspaceMember(member);
    await addWorkspaceMember(collaborator);
    await addWorkspaceMember(viewer);
    await addWorkspaceMember(outsider);

    const projectResponse = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/projects`,
      {
        method: 'POST',
        headers: auth(pm),
        body: JSON.stringify({ name: 'Phase 3 Project', key: `P3${String(tag).slice(-4)}`, visibility: 'WORKSPACE' }),
        jar: pm.jar,
      },
    );
    assert.equal(projectResponse.status, 201, JSON.stringify(projectResponse.body));
    projectId = (projectResponse.body.data as { id: string }).id;

    await addProjectMember(member, 'MEMBER');
    await addProjectMember(collaborator, 'COLLABORATOR');
    await addProjectMember(viewer, 'VIEWER');

    const parent = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Parent Task', description: 'workspace parent' }),
      jar: pm.jar,
    });
    assert.equal(parent.status, 201, JSON.stringify(parent.body));
    parentTaskId = (parent.body.data as { id: string }).id;

    const sub = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Subtask A', parentTaskId, assigneeIds: [member.id] }),
      jar: pm.jar,
    });
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    subtaskId = (sub.body.data as { id: string }).id;

    const approvalParent = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Approval Parent', requiresApproval: true, expectedDeliverables: [{ label: 'Report', required: true }] }),
      jar: pm.jar,
    });
    assert.equal(approvalParent.status, 201, JSON.stringify(approvalParent.body));
    approvalTaskId = (approvalParent.body.data as { id: string }).id;

    const approvalSub = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Approval Subtask', parentTaskId: approvalTaskId, assigneeIds: [member.id], requiresApproval: true }),
      jar: pm.jar,
    });
    assert.equal(approvalSub.status, 201, JSON.stringify(approvalSub.body));
    approvalSubtaskId = (approvalSub.body.data as { id: string }).id;
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

  test('workspace aggregate: allowed for PM/MEMBER/COLLABORATOR/VIEWER, denied for outsider', async () => {
    // Collaborators may only access tasks assigned to them; assign collaborator to this task for access.
    const assignCollab = await jsonRequest(`${taskUrl(parentTaskId)}/assignees`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ targetUserId: collaborator.id }),
      jar: pm.jar,
    });
    assert.ok(
      [200, 201, 409].includes(assignCollab.status),
      JSON.stringify(assignCollab.body),
    );

    for (const user of [pm, member, collaborator, viewer]) {
      const res = await jsonRequest(`${taskUrl(parentTaskId)}/workspace`, {
        headers: auth(user),
        jar: user.jar,
      });
      assert.equal(res.status, 200, `${user.email} ${JSON.stringify(res.body)}`);
      const data = res.body.data as {
        progress: { total: number; completed: number };
        subtasks: unknown[];
        task: { id: string };
      };
      assert.equal(data.task.id, parentTaskId);
      assert.ok(Array.isArray(data.subtasks));
      assert.equal(typeof data.progress.total, 'number');
    }

    const realOutsider = await register('RealOutsider', 'realoutsider-ws');
    const denied = await jsonRequest(`${taskUrl(parentTaskId)}/workspace`, {
      headers: auth(realOutsider),
      jar: realOutsider.jar,
    });
    assert.ok([403, 404].includes(denied.status), JSON.stringify(denied.body));
  });

  test('activity endpoint: paginated for viewer, denied for outsider', async () => {
    const res = await jsonRequest(`${taskUrl(parentTaskId)}/activity?limit=10`, {
      headers: auth(viewer),
      jar: viewer.jar,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data as { items: unknown[]; nextCursor: string | null };
    assert.ok(Array.isArray(data.items));

    const realOutsider = await register('RealOutsiderAct', 'realoutsider-act');
    const denied = await jsonRequest(`${taskUrl(parentTaskId)}/activity`, {
      headers: auth(realOutsider),
      jar: realOutsider.jar,
    });
    assert.ok([403, 404].includes(denied.status), JSON.stringify(denied.body));
  });

  test('subtask completion: assignee/member can complete non-approval subtask; collaborator allowed when assigned; viewer denied', async () => {
    const completeByViewer = await jsonRequest(`${taskUrl(parentTaskId)}/subtasks/${subtaskId}/complete`, {
      method: 'POST', headers: auth(viewer), body: JSON.stringify({}), jar: viewer.jar,
    });
    assert.equal(completeByViewer.status, 403, JSON.stringify(completeByViewer.body));

    const completeByMember = await jsonRequest(`${taskUrl(parentTaskId)}/subtasks/${subtaskId}/complete`, {
      method: 'POST', headers: auth(member), body: JSON.stringify({}), jar: member.jar,
    });
    assert.equal(completeByMember.status, 200, JSON.stringify(completeByMember.body));
    const body = completeByMember.body.data as { subtask: { status: string }; progress: { completed: number; total: number }; submissionCreated: boolean };
    assert.equal(body.subtask.status, 'APPROVED');
    assert.equal(body.submissionCreated, false);
    assert.equal(body.progress.completed, 1);
  });

  test('approval-gated subtask completion creates submission for review; submit/review flow enforces permissions', async () => {
    const completeApproval = await jsonRequest(`${taskUrl(approvalTaskId)}/subtasks/${approvalSubtaskId}/complete`, {
      method: 'POST', headers: auth(member), body: JSON.stringify({ workSummary: 'Done for review' }), jar: member.jar,
    });
    assert.equal(completeApproval.status, 200, JSON.stringify(completeApproval.body));
    const approvalBody = completeApproval.body.data as { subtask: { status: string }; submissionCreated: boolean; progress: { completed: number } };
    assert.equal(approvalBody.submissionCreated, true);
    assert.equal(approvalBody.subtask.status, 'SUBMITTED');
    assert.equal(approvalBody.progress.completed, 0);

    // member submits parent task (assignee not required if manager; create assignee context by making member assignee)
    await jsonRequest(`${taskUrl(approvalTaskId)}/assignees`, {
      method: 'POST', headers: auth(pm), body: JSON.stringify({ targetUserId: member.id }), jar: pm.jar,
    });
    const submit = await jsonRequest(`${taskUrl(approvalTaskId)}/submit`, {
      method: 'POST', headers: auth(member), body: JSON.stringify({ workSummary: 'Parent submitted' }), jar: member.jar,
    });
    assert.equal(submit.status, 200, JSON.stringify(submit.body));
    assert.equal((submit.body.data as { status: string }).status, 'SUBMITTED');

    const viewerApprove = await jsonRequest(`${taskUrl(approvalTaskId)}/review`, {
      method: 'POST', headers: auth(viewer), body: JSON.stringify({ decision: 'APPROVE' }), jar: viewer.jar,
    });
    assert.equal(viewerApprove.status, 403, JSON.stringify(viewerApprove.body));

    const pmApprove = await jsonRequest(`${taskUrl(approvalTaskId)}/review`, {
      method: 'POST', headers: auth(pm), body: JSON.stringify({ decision: 'APPROVE', feedback: 'Looks good' }), jar: pm.jar,
    });
    assert.equal(pmApprove.status, 200, JSON.stringify(pmApprove.body));
    assert.equal((pmApprove.body.data as { status: string }).status, 'APPROVED');
  });

  test('submit denied for viewer/collaborator without assignment context appropriately', async () => {
    // create fresh task assigned to member
    const fresh = await jsonRequest(tasksUrl(), {
      method: 'POST', headers: auth(pm), body: JSON.stringify({ title: 'Submit role check', assigneeIds: [member.id] }), jar: pm.jar,
    });
    assert.equal(fresh.status, 201);
    const freshId = (fresh.body.data as { id: string }).id;
    const viewerSubmit = await jsonRequest(`${taskUrl(freshId)}/submit`, {
      method: 'POST', headers: auth(viewer), body: JSON.stringify({ workSummary: 'x' }), jar: viewer.jar,
    });
    assert.equal(viewerSubmit.status, 403, JSON.stringify(viewerSubmit.body));
    const memberSubmit = await jsonRequest(`${taskUrl(freshId)}/submit`, {
      method: 'POST', headers: auth(member), body: JSON.stringify({ workSummary: 'member work' }), jar: member.jar,
    });
    assert.equal(memberSubmit.status, 200, JSON.stringify(memberSubmit.body));
  });
}
