import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import type { PrismaClient, TaskStatus } from '@prisma/client';
import { createApp } from '../src/app';
import { getPrismaClient } from '../src/db/prisma';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { assertTaskStatusTransition } from '../src/modules/tasks/task-status';
import { installOutboxEmailSender, resetEmailServices } from '../src/services/email';
import { createTaskDeadlineNotificationWorker } from '../src/services/workers/task-deadline-notification.worker';
import type { AppConfig } from '../src/config/env';
import { loadTestConfig } from './helpers/test-config';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_BE7_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('BE-7 task clarification DB tests', () =>
    test('skipped — set RUN_BE7_DB_TESTS=true to run', () => {}));
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
  let prisma: PrismaClient;
  let server: RunningServer;
  let baseUrl: string;
  let config: AppConfig;
  let owner: TestUser;
  let reviewer: TestUser;
  let pm: TestUser;
  let assignee: TestUser;
  let otherAssignee: TestUser;
  let acceptedAssignee: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let workspaceId: string;
  let projectId: string;

  const tag = `${process.pid}-${Date.now()}`;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const projectIds: string[] = [];

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });
  const tasksUrl = () => `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`;
  const taskUrl = (id: string) => `${tasksUrl()}/${id}`;
  const projectUrl = () => `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}`;

  const errorCode = (response: { body: { error?: { code?: string } } }) =>
    response.body.error?.code ?? '';

  const isCheckViolation = (error: unknown): boolean => {
    const err = error as { code?: unknown; meta?: { code?: unknown } };
    return (
      err.code === '23514' ||
      err.meta?.code === 23514 ||
      err.meta?.code === '23514'
    );
  };

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `be7-${suffix}-${tag}@test.example`;
    const password = 'TestPass123!';
    const jar = new CookieJar();
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
      jar,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    await prisma.authToken.updateMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', usedAt: null },
      data: { usedAt: new Date() },
    });
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

  async function createDirectUser(name: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        name,
        email: `be7-direct-${randomUUID()}@test.example`,
        passwordHash: 'not-used',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function addWorkspaceMember(userId: string, role: 'MEMBER' | 'PROJECT_MANAGER' = 'MEMBER') {
    await prisma.workspaceMembership.create({
      data: { workspaceId, userId, role, status: 'ACTIVE' },
    });
  }

  async function addProjectMember(
    userId: string,
    role: 'PROJECT_MANAGER' | 'MEMBER' | 'COLLABORATOR' | 'VIEWER',
  ) {
    await prisma.projectMembership.create({ data: { projectId, userId, role } });
  }

  async function createTask(title: string, body: Record<string, unknown> = {}, actor: TestUser = owner) {
    const response = await jsonRequest<{ id: string }>(tasksUrl(), {
      method: 'POST',
      headers: auth(actor),
      body: JSON.stringify({ title, ...body }),
      jar: actor.jar,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return (response.body.data as { id: string }).id;
  }

  async function createTaskDirect(input: {
    title: string;
    creatorId?: string;
    status?: TaskStatus;
    dueDate?: Date | null;
    parentTaskId?: string | null;
    reviewerId?: string | null;
    assigneeIds?: Array<{ userId: string; acceptanceStatus?: 'PENDING' | 'ACCEPTED' | 'DECLINED' }>;
  }): Promise<string> {
    const task = await prisma.task.create({
      data: {
        projectId,
        key: `BE7-${randomUUID().slice(0, 8)}`,
        title: input.title,
        creatorId: input.creatorId ?? owner.id,
        status: input.status ?? 'ASSIGNED',
        dueDate: input.dueDate ?? null,
        parentTaskId: input.parentTaskId ?? null,
        ...(input.reviewerId ? { reviewerId: input.reviewerId } : {}),
      },
    });
    if (input.assigneeIds?.length) {
      await prisma.taskAssignee.createMany({
        data: input.assigneeIds.map((a) => ({
          taskId: task.id,
          userId: a.userId,
          acceptanceStatus: a.acceptanceStatus ?? 'PENDING',
        })),
      });
    }
    return task.id;
  }

  async function assign(taskId: string, userId: string, acceptanceStatus: 'PENDING' | 'ACCEPTED' | 'DECLINED' = 'PENDING') {
    await prisma.taskAssignee.create({
      data: { taskId, userId, acceptanceStatus },
    });
  }

  function askClarification(taskId: string, user: TestUser, question = 'Need one detail') {
    return jsonRequest(`${taskUrl(taskId)}/clarifications`, {
      method: 'POST',
      headers: auth(user),
      body: JSON.stringify({ question }),
      jar: user.jar,
    });
  }

  function answerClarification(
    taskId: string,
    clarificationId: string,
    user: TestUser,
    answer = 'Here is the detail',
  ) {
    return jsonRequest(`${taskUrl(taskId)}/clarifications/${clarificationId}/answer`, {
      method: 'POST',
      headers: auth(user),
      body: JSON.stringify({ answer }),
      jar: user.jar,
    });
  }

  function listClarifications(taskId: string, user: TestUser, query = '') {
    return jsonRequest(`${taskUrl(taskId)}/clarifications${query}`, {
      headers: auth(user),
      jar: user.jar,
    });
  }

  function openClarification(taskId: string) {
    return prisma.taskClarification.findFirst({
      where: { taskId, answeredAt: null, cancelledAt: null },
      orderBy: { round: 'desc' },
    });
  }

  async function notificationsOfType(type: 'TASK_CLARIFICATION_REQUESTED' | 'TASK_CLARIFICATION_ANSWERED', clarificationId: string) {
    const rows = await prisma.notification.findMany({ where: { type } });
    return rows.filter((row) => {
      const data = row.data as Record<string, unknown> | null;
      return data?.clarificationId === clarificationId;
    });
  }

  before(async () => {
    const database = await connectTestDatabase(rawDbUrl);
    prisma = database.prisma;
    getPrismaClient(database.url);
    config = loadTestConfig({
      RATE_LIMIT_NAMESPACE: `be7-clarification-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    installOutboxEmailSender(config);
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;

    owner = await register('BE7Owner', 'owner');
    reviewer = await register('BE7Reviewer', 'reviewer');
    pm = await register('BE7PM', 'pm');
    assignee = await register('BE7Assignee', 'assignee');
    otherAssignee = await register('BE7OtherAssignee', 'other');
    acceptedAssignee = await register('BE7AcceptedAssignee', 'accepted');
    viewer = await register('BE7Viewer', 'viewer');
    outsider = await register('BE7Outsider', 'outsider');

    const workspaceResponse = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: `BE7 WS ${tag}`, type: 'COMPANY' }),
      jar: owner.jar,
    });
    assert.equal(workspaceResponse.status, 201, JSON.stringify(workspaceResponse.body));
    workspaceId = (workspaceResponse.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);

    const projectResponse = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({
        name: 'BE7 Clarification Project',
        key: `B7${String(tag).slice(-5)}`,
        visibility: 'WORKSPACE',
      }),
      jar: owner.jar,
    });
    assert.equal(projectResponse.status, 201, JSON.stringify(projectResponse.body));
    projectId = (projectResponse.body.data as { id: string }).id;
    projectIds.push(projectId);

    await addWorkspaceMember(reviewer.id);
    await addWorkspaceMember(pm.id, 'PROJECT_MANAGER');
    await addWorkspaceMember(assignee.id);
    await addWorkspaceMember(otherAssignee.id);
    await addWorkspaceMember(acceptedAssignee.id);
    await addWorkspaceMember(viewer.id);
    await addProjectMember(reviewer.id, 'MEMBER');
    await addProjectMember(pm.id, 'PROJECT_MANAGER');
    await addProjectMember(assignee.id, 'MEMBER');
    await addProjectMember(otherAssignee.id, 'MEMBER');
    await addProjectMember(acceptedAssignee.id, 'MEMBER');
    await addProjectMember(viewer.id, 'VIEWER');
  });

  after(async () => {
    if (prisma) {
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.notificationPreference.deleteMany({ where: { workspaceId } });
      await prisma.auditLog.deleteMany({ where: { workspaceId } });
      await prisma.taskClarification.deleteMany({ where: { task: { projectId } } });
      await prisma.taskAssignee.deleteMany({ where: { task: { projectId } } });
      await prisma.task.deleteMany({ where: { projectId } });
      await prisma.projectMembership.deleteMany({ where: { projectId } });
      await prisma.workspaceMembership.deleteMany({ where: { workspaceId } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    }
    if (server) await server.close();
    await disconnectRedis();
    resetEmailServices();
  });

  test('permissions and validation error codes are enforced', async () => {
    const taskId = await createTask('Permission errors');
    await assign(taskId, assignee.id);
    await assign(taskId, acceptedAssignee.id, 'ACCEPTED');

    const outsiderAsk = await askClarification(taskId, outsider);
    assert.equal(outsiderAsk.status, 403);
    assert.equal(errorCode(outsiderAsk), 'WORKSPACE_ACCESS_DENIED');

    const viewerAsk = await askClarification(taskId, viewer);
    assert.equal(viewerAsk.status, 403);
    assert.equal(errorCode(viewerAsk), 'NOT_TASK_ASSIGNEE');

    const acceptedAsk = await askClarification(taskId, acceptedAssignee);
    assert.equal(acceptedAsk.status, 409);
    assert.equal(errorCode(acceptedAsk), 'INVALID_ACCEPTANCE_STATE');

    const invalidAsk = await askClarification(taskId, assignee, '   ');
    assert.equal(invalidAsk.status, 400);
    assert.equal(errorCode(invalidAsk), 'VALIDATION_ERROR');

    const nonAssignedTask = await createTask('Not assigned');
    await prisma.task.update({ where: { id: nonAssignedTask }, data: { status: 'IN_PROGRESS' } });
    await assign(nonAssignedTask, assignee.id);
    const badState = await askClarification(nonAssignedTask, assignee);
    assert.equal(badState.status, 409);
    assert.equal(errorCode(badState), 'INVALID_CLARIFICATION_STATE');

    const asked = await askClarification(taskId, assignee);
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const clarificationId = ((asked.body.data as { clarification: { id: string } }).clarification).id;

    const selfAnswer = await answerClarification(taskId, clarificationId, assignee);
    assert.equal(selfAnswer.status, 403);
    assert.equal(errorCode(selfAnswer), 'SELF_CLARIFICATION_FORBIDDEN');

    const viewerAnswer = await answerClarification(taskId, clarificationId, viewer);
    assert.equal(viewerAnswer.status, 403);
    assert.equal(errorCode(viewerAnswer), 'PERMISSION_DENIED');

    const invalidAnswer = await answerClarification(taskId, clarificationId, owner, '   ');
    assert.equal(invalidAnswer.status, 400);
    assert.equal(errorCode(invalidAnswer), 'VALIDATION_ERROR');

    const missingAnswer = await answerClarification(taskId, randomUUID(), owner);
    assert.equal(missingAnswer.status, 404);
    assert.equal(errorCode(missingAnswer), 'CLARIFICATION_NOT_FOUND');

    const invalidCursor = await listClarifications(taskId, owner, `?cursor=${randomUUID()}`);
    assert.equal(invalidCursor.status, 400);
    assert.equal(errorCode(invalidCursor), 'INVALID_CURSOR');

    const resolved = await answerClarification(taskId, clarificationId, owner);
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    const secondAnswer = await answerClarification(taskId, clarificationId, pm);
    assert.equal(secondAnswer.status, 409);
    assert.equal(errorCode(secondAnswer), 'INVALID_CLARIFICATION_STATE');
  });

  test('ask, cursor list and answer happy paths create append-only rounds', async () => {
    const taskId = await createTask('Happy path');
    await prisma.task.update({ where: { id: taskId }, data: { reviewerId: reviewer.id } });
    await assign(taskId, assignee.id);
    await assign(taskId, otherAssignee.id);

    const asked = await askClarification(taskId, assignee, '  First question  ');
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const data = asked.body.data as { clarification: { id: string; question: string; round: number }; task: { status: string } };
    assert.equal(data.clarification.question, 'First question');
    assert.equal(data.clarification.round, 1);
    assert.equal(data.task.status, 'AWAITING_CLARIFICATION');

    const answered = await answerClarification(taskId, data.clarification.id, reviewer, '  First answer  ');
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    const answeredData = answered.body.data as {
      clarification: { answer: string; answeredById: string; answeredAt: string | null };
      task: { status: string };
    };
    assert.equal(answeredData.clarification.answer, 'First answer');
    assert.equal(answeredData.clarification.answeredById, reviewer.id);
    assert.notEqual(answeredData.clarification.answeredAt, null);
    assert.equal(answeredData.task.status, 'ASSIGNED');

    const secondAsk = await askClarification(taskId, otherAssignee, 'Second question');
    assert.equal(secondAsk.status, 200, JSON.stringify(secondAsk.body));
    const second = (secondAsk.body.data as { clarification: { id: string; round: number } }).clarification;
    assert.equal(second.round, 2);

    const firstPage = await listClarifications(taskId, viewer, '?limit=1');
    assert.equal(firstPage.status, 200, JSON.stringify(firstPage.body));
    const firstPageData = firstPage.body.data as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    assert.equal(firstPageData.items.length, 1);
    assert.equal(firstPageData.items[0]?.id, second.id);
    assert.equal(firstPageData.nextCursor, second.id);

    const secondPage = await listClarifications(
      taskId,
      owner,
      `?limit=1&cursor=${encodeURIComponent(String(firstPageData.nextCursor))}`,
    );
    assert.equal(secondPage.status, 200, JSON.stringify(secondPage.body));
    const secondPageData = secondPage.body.data as { items: Array<{ id: string }>; nextCursor: string | null };
    assert.equal(secondPageData.items.length, 1);
    assert.equal(secondPageData.items[0]?.id, data.clarification.id);
    assert.equal(secondPageData.nextCursor, null);

    const secondAnswer = await answerClarification(taskId, second.id, pm);
    assert.equal(secondAnswer.status, 200, JSON.stringify(secondAnswer.body));

    const auditRows = await prisma.auditLog.findMany({ where: { workspaceId } });
    const actions = auditRows
      .filter((row) => (row.metadata as Record<string, unknown> | null)?.taskId === taskId)
      .map((row) => row.action);
    assert.ok(actions.includes('task.clarification_requested'));
    assert.ok(actions.includes('task.clarification_answered'));
    assert.ok(!actions.includes('task.updated'));
  });

  test('concurrent double-ask and double-answer yield one success and one conflict', async () => {
    const taskId = await createTask('Double ask');
    await assign(taskId, assignee.id);
    await assign(taskId, otherAssignee.id);

    const asks = await Promise.all([
      askClarification(taskId, assignee, 'From A'),
      askClarification(taskId, otherAssignee, 'From B'),
    ]);
    assert.deepEqual(asks.map((r) => r.status).sort(), [200, 409]);
    const open = await openClarification(taskId);
    assert.ok(open);
    const openCount = await prisma.taskClarification.count({
      where: { taskId, answeredAt: null, cancelledAt: null },
    });
    assert.equal(openCount, 1);
    const waiting = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(waiting.status, 'AWAITING_CLARIFICATION');

    const answers = await Promise.all([
      answerClarification(taskId, open.id, owner, 'Owner answer'),
      answerClarification(taskId, open.id, pm, 'PM answer'),
    ]);
    assert.deepEqual(answers.map((r) => r.status).sort(), [200, 409]);
    const answered = await prisma.taskClarification.findUniqueOrThrow({ where: { id: open.id } });
    assert.notEqual(answered.answeredAt, null);
    assert.ok(answered.answeredById === owner.id || answered.answeredById === pm.id);
    const done = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(done.status, 'ASSIGNED');
  });

  test('decline and assignee removal cancel the open clarification in one transaction', async () => {
    const declineTask = await createTask('Cancel by decline');
    await assign(declineTask, assignee.id);
    const asked = await askClarification(declineTask, assignee);
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const decline = await jsonRequest(`${taskUrl(declineTask)}/decline`, {
      method: 'POST',
      headers: auth(assignee),
      body: JSON.stringify({ reason: 'Not now' }),
      jar: assignee.jar,
    });
    assert.equal(decline.status, 200, JSON.stringify(decline.body));
    const declinedRow = await prisma.taskClarification.findFirstOrThrow({ where: { taskId: declineTask } });
    assert.notEqual(declinedRow.cancelledAt, null);
    assert.equal(declinedRow.answeredAt, null);
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: declineTask } })).status, 'ASSIGNED');

    const removedTask = await createTask('Cancel by removal');
    await assign(removedTask, otherAssignee.id);
    const askedAgain = await askClarification(removedTask, otherAssignee);
    assert.equal(askedAgain.status, 200, JSON.stringify(askedAgain.body));
    const removal = await jsonRequest(`${taskUrl(removedTask)}/assignees/${otherAssignee.id}`, {
      method: 'DELETE',
      headers: auth(owner),
      jar: owner.jar,
    });
    assert.equal(removal.status, 200, JSON.stringify(removal.body));
    const removedRow = await prisma.taskClarification.findFirstOrThrow({ where: { taskId: removedTask } });
    assert.notEqual(removedRow.cancelledAt, null);
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: removedTask } })).status, 'ASSIGNED');

    const cancellationAudit = await prisma.auditLog.findMany({
      where: { workspaceId, action: 'task.clarification_cancelled' },
    });
    assert.ok(cancellationAudit.length >= 2);
  });

  test('start and accept are blocked while waiting', async () => {
    const taskId = await createTask('Blocked actions');
    await assign(taskId, assignee.id);
    const asked = await askClarification(taskId, assignee);
    assert.equal(asked.status, 200, JSON.stringify(asked.body));

    const start = await jsonRequest(`${taskUrl(taskId)}/start`, {
      method: 'POST',
      headers: auth(assignee),
      body: JSON.stringify({}),
      jar: assignee.jar,
    });
    assert.equal(start.status, 409);
    assert.equal(errorCode(start), 'INVALID_STATUS_TRANSITION');

    const accept = await jsonRequest(`${taskUrl(taskId)}/accept`, {
      method: 'POST',
      headers: auth(assignee),
      body: JSON.stringify({}),
      jar: assignee.jar,
    });
    assert.equal(accept.status, 409);
    assert.equal(errorCode(accept), 'INVALID_ACCEPTANCE_STATE');

    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status, 'AWAITING_CLARIFICATION');
    const clarification = await openClarification(taskId);
    assert.ok(clarification);
    const answered = await answerClarification(taskId, clarification.id, owner);
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
  });

  test('status writers cannot move a waiting task', async () => {
    const taskId = await createTask('Status writers');
    await assign(taskId, assignee.id);
    await askClarification(taskId, assignee);

    const generic = await jsonRequest(taskUrl(taskId), {
      method: 'PATCH',
      headers: auth(owner),
      body: JSON.stringify({ status: 'IN_PROGRESS' }),
      jar: owner.jar,
    });
    assert.equal(generic.status, 409);
    assert.equal(errorCode(generic), 'INVALID_STATUS_TRANSITION');

    const subtaskId = await createTaskDirect({
      title: 'Waiting subtask',
      creatorId: owner.id,
      parentTaskId: taskId,
      assigneeIds: [{ userId: assignee.id }],
    });
    await askClarification(subtaskId, assignee);
    const subtaskComplete = await jsonRequest(`${taskUrl(taskId)}/subtasks/${subtaskId}/complete`, {
      method: 'POST',
      headers: auth(assignee),
      body: JSON.stringify({}),
      jar: assignee.jar,
    });
    assert.equal(subtaskComplete.status, 409);
    assert.equal(errorCode(subtaskComplete), 'INVALID_CLARIFICATION_STATE');

    for (const [to, transitionContext] of [
      ['IN_PROGRESS', 'update'],
      ['APPROVED', 'complete'],
      ['IN_PROGRESS', 'reopen'],
      ['SUBMITTED', 'submit'],
      ['APPROVED', 'review'],
      ['SUBMITTED', 'subtask_complete'],
      ['IN_PROGRESS', 'start'],
    ] as const) {
      assert.throws(() =>
        assertTaskStatusTransition('AWAITING_CLARIFICATION', to, transitionContext),
      );
    }
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status, 'AWAITING_CLARIFICATION');
    assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: subtaskId } })).status, 'AWAITING_CLARIFICATION');
  });

  test('notification fan-out dedupes, excludes actor and honours preferences', async () => {
    const taskId = await createTask('Notifications');
    await prisma.task.update({ where: { id: taskId }, data: { reviewerId: reviewer.id } });
    await assign(taskId, assignee.id);
    await prisma.notificationPreference.create({
      data: {
        workspaceId,
        userId: pm.id,
        type: 'TASK_CLARIFICATION_REQUESTED',
        inAppEnabled: false,
      },
    });

    const asked = await askClarification(taskId, assignee);
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const clarificationId = ((asked.body.data as { clarification: { id: string } }).clarification).id;
    const requested = await notificationsOfType('TASK_CLARIFICATION_REQUESTED', clarificationId);
    const recipients = requested.map((row) => row.userId).sort();
    assert.deepEqual(recipients, [owner.id, reviewer.id].sort());
    assert.ok(!recipients.includes(assignee.id));
    assert.ok(!recipients.includes(pm.id));

    const answered = await answerClarification(taskId, clarificationId, owner);
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    const answeredNotifications = await notificationsOfType('TASK_CLARIFICATION_ANSWERED', clarificationId);
    assert.equal(answeredNotifications.length, 1);
    assert.equal(answeredNotifications[0]?.userId, assignee.id);
  });

  test('fan-out is capped at 25 recipients', async () => {
    const extraIds: string[] = [];
    for (let index = 0; index < 26; index += 1) {
      const id = await createDirectUser(`BE7 Manager ${index}`);
      await addWorkspaceMember(id, 'PROJECT_MANAGER');
      extraIds.push(id);
    }
    const taskId = await createTask('Cap recipients');
    await assign(taskId, assignee.id);
    const asked = await askClarification(taskId, assignee);
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const clarificationId = ((asked.body.data as { clarification: { id: string } }).clarification).id;
    const requested = await notificationsOfType('TASK_CLARIFICATION_REQUESTED', clarificationId);
    assert.ok(requested.length <= 25, `received ${requested.length}`);
    assert.ok(requested.length > 0);
    assert.ok(!requested.some((row) => row.userId === assignee.id));
  });

  test('progress, workload, project counts and deadline eligibility include waiting tasks', async () => {
    const parentId = await createTaskDirect({ title: 'Progress parent' });
    await createTaskDirect({
      title: 'Approved subtask',
      parentTaskId: parentId,
      status: 'APPROVED',
    });
    await createTaskDirect({
      title: 'Waiting subtask',
      parentTaskId: parentId,
      status: 'AWAITING_CLARIFICATION',
    });
    const workspace = await jsonRequest(`${taskUrl(parentId)}/workspace`, {
      headers: auth(owner),
      jar: owner.jar,
    });
    assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
    const progress = (workspace.body.data as { progress: { completed: number; total: number; percent: number } }).progress;
    assert.equal(progress.completed, 1);
    assert.equal(progress.total, 2);
    assert.equal(progress.percent, 50);

    const deadlineTaskId = await createTaskDirect({
      title: 'Waiting with deadline',
      status: 'AWAITING_CLARIFICATION',
      dueDate: new Date(Date.now() + 60 * 60 * 1000),
      assigneeIds: [{ userId: assignee.id }],
    });
    const worker = createTaskDeadlineNotificationWorker({
      prisma,
      now: () => new Date(),
    });
    const result = await worker.runOnce();
    assert.ok(result.dueSoon >= 1);
    const deadlineTask = await prisma.task.findUniqueOrThrow({ where: { id: deadlineTaskId } });
    assert.equal(deadlineTask.status, 'AWAITING_CLARIFICATION');
    assert.notEqual(deadlineTask.dueSoonNotifiedAt, null);

    const byStatusUrl = `${baseUrl}/api/v1/analytics/tasks/by-status?workspaceId=${workspaceId}&projectId=${projectId}&range=30d`;
    const analytics = await jsonRequest(byStatusUrl, { headers: auth(owner), jar: owner.jar });
    assert.equal(analytics.status, 200, JSON.stringify(analytics.body));
    const statusItems = (analytics.body.data as { items: Array<{ status: string; count: number }> }).items;
    assert.ok(statusItems.some((item) => item.status === 'AWAITING_CLARIFICATION' && item.count > 0));

    const overview = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/resources/dashboard/overview`,
      { headers: auth(owner), jar: owner.jar },
    );
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    const workload = (overview.body.data as { workloadByStatus: Array<{ status: string }> }).workloadByStatus;
    assert.ok(workload.some((item) => item.status === 'AWAITING_CLARIFICATION'));

    const projectProgress = await jsonRequest(`${projectUrl()}/progress`, {
      headers: auth(owner),
      jar: owner.jar,
    });
    assert.equal(projectProgress.status, 200, JSON.stringify(projectProgress.body));
    const counts = (projectProgress.body.data as { taskCountsByStatus: Record<string, number> })
      .taskCountsByStatus;
    assert.ok(Object.prototype.hasOwnProperty.call(counts, 'AWAITING_CLARIFICATION'));
  });

  test('BE-6 merge transition condition leaves a waiting task unchanged', async () => {
    const taskId = await createTaskDirect({
      title: 'BE6 merge guard',
      status: 'AWAITING_CLARIFICATION',
    });
    const merged = await prisma.task.updateMany({
      where: { id: taskId, status: { in: ['IN_PROGRESS', 'CHANGES_REQUESTED'] } },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
    });
    assert.equal(merged.count, 0);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(task.status, 'AWAITING_CLARIFICATION');
    assert.equal(task.submittedAt, null);
  });

  test('PostgreSQL CHECK constraints reject partial and conflicting clarification rows', async () => {
    const taskId = await createTaskDirect({ title: 'Check constraints' });
    const clarificationId = randomUUID();
    await assert.rejects(
      prisma.$executeRaw`
        INSERT INTO "TaskClarification"
          ("id", "taskId", "round", "question", "askedById", "answer")
        VALUES
          (${clarificationId}, ${taskId}, 1, 'Question', ${assignee.id}, 'Partial answer')
      `,
      isCheckViolation,
    );

    const secondId = randomUUID();
    await assert.rejects(
      prisma.$executeRaw`
        INSERT INTO "TaskClarification"
          ("id", "taskId", "round", "question", "askedById", "answer", "answeredById", "answeredAt", "cancelledAt")
        VALUES
          (${secondId}, ${taskId}, 2, 'Question', ${assignee.id}, 'Answer', ${owner.id}, NOW(), NOW())
      `,
      isCheckViolation,
    );

    const remaining = await prisma.taskClarification.count({ where: { taskId } });
    assert.equal(remaining, 0);
  });
}
