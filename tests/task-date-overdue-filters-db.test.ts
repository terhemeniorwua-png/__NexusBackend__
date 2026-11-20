import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { installOutboxEmailSender, resetEmailServices } from '../src/services/email';
import { loadTestConfig } from './helpers/test-config';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';
import { isTaskOverdue } from '../src/modules/tasks/task-overdue';

const DB_FLAG = 'RUN_TASK_DATE_OVERDUE_FILTERS_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Task date and overdue filters DB tests', () =>
    test('skipped — set RUN_TASK_DATE_OVERDUE_FILTERS_DB_TESTS=true to run', () => {}));
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
  const taskIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });
  const tasksUrl = () => `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`;
  const mineUrl = () => `${baseUrl}/api/v1/workspaces/${workspaceId}/tasks/mine`;
  const taskUrl = (id: string) => `${tasksUrl()}/${id}`;
  const workspaceUrl = (id: string) => `${taskUrl(id)}/workspace`;

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `tdf-${suffix}-${tag}@test.example`;
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

  async function createTask(
    title: string,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; status: string; dueDate: string | null; archivedAt?: string | null }> {
    const res = await jsonRequest(tasksUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title, ...body }),
      jar: pm.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const data = res.body.data as {
      id: string;
      status: string;
      dueDate: string | null;
      archivedAt?: string | null;
    };
    taskIds.push(data.id);
    return data;
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = loadTestConfig({
      RATE_LIMIT_NAMESPACE: `task-date-overdue-filters-${tag}`,
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
      body: JSON.stringify({ name: `TDF WS ${tag}`, type: 'COMPANY' }),
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
          name: 'Date Overdue Filters Project',
          key: `DF${String(tag).slice(-4)}`,
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

  test('rejects dueFrom after dueTo on list and listMine', async () => {
    const dueFrom = '2026-11-20T12:00:00.000Z';
    const dueTo = '2026-11-19T12:00:00.000Z';

    const listRes = await jsonRequest(
      `${tasksUrl()}?dueFrom=${encodeURIComponent(dueFrom)}&dueTo=${encodeURIComponent(dueTo)}`,
      { headers: auth(pm), jar: pm.jar },
    );
    assert.equal(listRes.status, 400, JSON.stringify(listRes.body));
    assert.equal(listRes.body.error?.code, 'VALIDATION_ERROR');

    const mineRes = await jsonRequest(
      `${mineUrl()}?dueFrom=${encodeURIComponent(dueFrom)}&dueTo=${encodeURIComponent(dueTo)}`,
      { headers: auth(pm), jar: pm.jar },
    );
    assert.equal(mineRes.status, 400, JSON.stringify(mineRes.body));
    assert.equal(mineRes.body.error?.code, 'VALIDATION_ERROR');
  });

  test('filters by dueFrom/dueTo and overdue on list and listMine', async () => {
    const pastDue = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const inRangeDue = '2026-12-10T12:00:00.000Z';
    const futureDue = '2027-01-10T12:00:00.000Z';

    const overdueTask = await createTask('Overdue filter task', {
      dueDate: pastDue,
      assigneeIds: [pm.id],
    });
    const inRangeTask = await createTask('In-range future task', {
      dueDate: inRangeDue,
      assigneeIds: [pm.id],
    });
    await createTask('Out-of-range future task', {
      dueDate: futureDue,
      assigneeIds: [pm.id],
    });
    const approvedPastTask = await createTask('Approved past task', {
      dueDate: pastDue,
      assigneeIds: [pm.id],
    });
    const completeApproved = await jsonRequest(`${taskUrl(approvedPastTask.id)}/complete`, {
      method: 'POST',
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.equal(completeApproved.status, 200, JSON.stringify(completeApproved.body));

    const rangeList = await jsonRequest(
      `${tasksUrl()}?dueFrom=${encodeURIComponent('2026-12-01T00:00:00.000Z')}&dueTo=${encodeURIComponent('2026-12-31T23:59:59.999Z')}`,
      { headers: auth(pm), jar: pm.jar },
    );
    assert.equal(rangeList.status, 200, JSON.stringify(rangeList.body));
    const rangeListItems = (rangeList.body.data as { items: Array<{ id: string }> }).items;
    assert.deepEqual(
      rangeListItems.map((i) => i.id),
      [inRangeTask.id],
    );

    const overdueTrueList = await jsonRequest(`${tasksUrl()}?overdue=true`, {
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.equal(overdueTrueList.status, 200, JSON.stringify(overdueTrueList.body));
    const overdueTrueIds = (overdueTrueList.body.data as { items: Array<{ id: string }> }).items.map(
      (i) => i.id,
    );
    assert.ok(overdueTrueIds.includes(overdueTask.id));
    assert.ok(!overdueTrueIds.includes(approvedPastTask.id));

    const overdueFalseList = await jsonRequest(`${tasksUrl()}?overdue=false`, {
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.equal(overdueFalseList.status, 200, JSON.stringify(overdueFalseList.body));
    const overdueFalseIds = (overdueFalseList.body.data as { items: Array<{ id: string }> }).items.map(
      (i) => i.id,
    );
    assert.ok(!overdueFalseIds.includes(overdueTask.id));
    assert.ok(overdueFalseIds.includes(inRangeTask.id));

    const mineOverdue = await jsonRequest(`${mineUrl()}?overdue=true`, {
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.equal(mineOverdue.status, 200, JSON.stringify(mineOverdue.body));
    const mineOverdueIds = (mineOverdue.body.data as { items: Array<{ id: string }> }).items.map(
      (i) => i.id,
    );
    assert.ok(mineOverdueIds.includes(overdueTask.id));

    const mineRange = await jsonRequest(
      `${mineUrl()}?dueFrom=${encodeURIComponent('2026-12-01T00:00:00.000Z')}&dueTo=${encodeURIComponent('2026-12-31T23:59:59.999Z')}`,
      { headers: auth(pm), jar: pm.jar },
    );
    assert.equal(mineRange.status, 200, JSON.stringify(mineRange.body));
    const mineRangeIds = (mineRange.body.data as { items: Array<{ id: string }> }).items.map(
      (i) => i.id,
    );
    assert.ok(mineRangeIds.includes(inRangeTask.id));
  });

  test('getWorkspace schedule.overdue agrees with shared overdue definition', async () => {
    const pastDue = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const overdueTask = await createTask('Workspace overdue task', { dueDate: pastDue });

    const ws = await jsonRequest(workspaceUrl(overdueTask.id), { headers: auth(pm), jar: pm.jar });
    assert.equal(ws.status, 200, JSON.stringify(ws.body));
    const data = ws.body.data as {
      schedule: { overdue: boolean };
      task: { status: string; dueDate: string | null; archivedAt?: string | null; deletedAt?: string | null };
    };
    assert.equal(data.schedule.overdue, true);
    assert.equal(
      data.schedule.overdue,
      isTaskOverdue({
        dueDate: data.task.dueDate ? new Date(data.task.dueDate) : null,
        status: data.task.status as any,
        archivedAt: data.task.archivedAt ? new Date(data.task.archivedAt) : null,
        deletedAt: data.task.deletedAt ? new Date(data.task.deletedAt) : null,
      }),
    );

    const complete = await jsonRequest(`${taskUrl(overdueTask.id)}/complete`, {
      method: 'POST',
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.equal(complete.status, 200, JSON.stringify(complete.body));
    const wsApproved = await jsonRequest(workspaceUrl(overdueTask.id), { headers: auth(pm), jar: pm.jar });
    assert.equal(wsApproved.status, 200, JSON.stringify(wsApproved.body));
    const approvedData = wsApproved.body.data as { schedule: { overdue: boolean } };
    assert.equal(approvedData.schedule.overdue, false);
  });

  test('supports pagination with due/overdue filters on list', async () => {
    // Create several overdue tasks to paginate through
    const overdueIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const due = new Date(Date.now() - (5 + i) * 24 * 60 * 60 * 1000).toISOString();
      const t = await createTask(`Paginated overdue ${i}`, { dueDate: due });
      overdueIds.push(t.id);
    }

    const page1 = await jsonRequest(`${tasksUrl()}?overdue=true&limit=2`, {
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.equal(page1.status, 200, JSON.stringify(page1.body));
    const p1 = page1.body.data as { items: Array<{ id: string }>; nextCursor: string | null };
    assert.equal(p1.items.length, 2);
    assert.ok(p1.nextCursor, JSON.stringify(page1.body));

    // ensure all returned are overdue by definition
    for (const item of p1.items) {
      const ws = await jsonRequest(workspaceUrl(item.id), { headers: auth(pm), jar: pm.jar });
      assert.equal(ws.status, 200, JSON.stringify(ws.body));
      const sched = (ws.body.data as { schedule: { overdue: boolean } }).schedule;
      assert.equal(sched.overdue, true);
    }

    const page2 = await jsonRequest(`${tasksUrl()}?overdue=true&limit=2&cursor=${encodeURIComponent(p1.nextCursor as string)}`, {
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.equal(page2.status, 200, JSON.stringify(page2.body));
    const p2 = page2.body.data as { items: Array<{ id: string }>; nextCursor: string | null };
    assert.ok(p2.items.length >= 1);
    const seen = new Set([...p1.items.map((i) => i.id), ...p2.items.map((i) => i.id)]);
    assert.equal(seen.size, p1.items.length + p2.items.length);
  });
}
