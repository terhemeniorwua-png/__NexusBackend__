import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { installOutboxEmailSender, resetEmailServices } from '../src/services/email';
import { loadTestConfig } from './helpers/test-config';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_TASK_ASSIGNEE_ELIGIBILITY_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Task assignee eligibility DB tests', () =>
    test('skipped — set RUN_TASK_ASSIGNEE_ELIGIBILITY_DB_TESTS=true to run', () => {}));
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
  let eligibleMember: TestUser;
  let workspaceOnlyMember: TestUser;
  let suspendedMember: TestUser;
  let outsideUser: TestUser;
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

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `tae-${suffix}-${tag}@test.example`;
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

  async function addWorkspaceMember(user: TestUser, role: 'MEMBER' | 'PROJECT_MANAGER' = 'MEMBER'): Promise<void> {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/members`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ email: user.email, role }),
      jar: pm.jar,
    });
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
      RATE_LIMIT_NAMESPACE: `task-assignee-eligibility-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    installOutboxEmailSender(config);
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    pm = await register('PM', 'pm');
    eligibleMember = await register('Eligible', 'eligible');
    workspaceOnlyMember = await register('WorkspaceOnly', 'wsonly');
    suspendedMember = await register('Suspended', 'suspended');
    outsideUser = await register('Outside', 'outside');

    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ name: `TAE WS ${tag}`, type: 'COMPANY' }),
      jar: pm.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);

    await addWorkspaceMember(eligibleMember, 'MEMBER');
    await addWorkspaceMember(workspaceOnlyMember, 'MEMBER');
    await addWorkspaceMember(suspendedMember, 'MEMBER');

    const projectResponse = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/projects`,
      {
        method: 'POST',
        headers: auth(pm),
        body: JSON.stringify({
          name: 'Assignee Eligibility Project',
          key: `AE${String(tag).slice(-4)}`,
          visibility: 'WORKSPACE',
        }),
        jar: pm.jar,
      },
    );
    assert.equal(projectResponse.status, 201, JSON.stringify(projectResponse.body));
    projectId = (projectResponse.body.data as { id: string }).id;

    await addProjectMember(eligibleMember, 'MEMBER');

    const db2 = await connectTestDatabase(rawDbUrl);
    await db2.prisma.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: suspendedMember.id } },
      data: { status: 'SUSPENDED' },
    });
    await db2.prisma.$disconnect();
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

  test('create allows eligible active project member as assignee', async () => {
    const res = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Eligible create', assigneeIds: [eligibleMember.id] }),
      jar: pm.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const data = res.body.data as { assignees: Array<{ userId: string }> };
    assert.ok(data.assignees.some((a) => a.userId === eligibleMember.id));
  });

  test('create allows eligible workspace member on WORKSPACE-visibility project without explicit project membership', async () => {
    const res = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Workspace-visible eligible', assigneeIds: [workspaceOnlyMember.id] }),
      jar: pm.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const data = res.body.data as { assignees: Array<{ userId: string }> };
    assert.ok(data.assignees.some((a) => a.userId === workspaceOnlyMember.id));
  });

  test('create rejects non-member assignee with ASSIGNEE_NOT_PROJECT_MEMBER', async () => {
    const res = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Non-member create', assigneeIds: [outsideUser.id] }),
      jar: pm.jar,
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error?.code, 'ASSIGNEE_NOT_PROJECT_MEMBER');
  });

  test('create rejects suspended workspace member assignee with ASSIGNEE_NOT_PROJECT_MEMBER', async () => {
    const res = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Suspended create', assigneeIds: [suspendedMember.id] }),
      jar: pm.jar,
    });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error?.code, 'ASSIGNEE_NOT_PROJECT_MEMBER');
  });

  test('addAssignee allows eligible member, rejects non-member and suspended member with ASSIGNEE_NOT_PROJECT_MEMBER', async () => {
    const created = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Add assignee target' }),
      jar: pm.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const taskId = (created.body.data as { id: string }).id;

    const ok = await jsonRequest(`${tasksUrl()}/${taskId}/assignees`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ targetUserId: eligibleMember.id }),
      jar: pm.jar,
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));

    const nonMember = await jsonRequest(`${tasksUrl()}/${taskId}/assignees`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ targetUserId: outsideUser.id }),
      jar: pm.jar,
    });
    assert.equal(nonMember.status, 403, JSON.stringify(nonMember.body));
    assert.equal(nonMember.body.error?.code, 'ASSIGNEE_NOT_PROJECT_MEMBER');

    const suspended = await jsonRequest(`${tasksUrl()}/${taskId}/assignees`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ targetUserId: suspendedMember.id }),
      jar: pm.jar,
    });
    assert.equal(suspended.status, 403, JSON.stringify(suspended.body));
    assert.equal(suspended.body.error?.code, 'ASSIGNEE_NOT_PROJECT_MEMBER');
  });
}
