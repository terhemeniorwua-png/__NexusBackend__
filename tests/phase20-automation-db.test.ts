import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { Automation, Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../src/db/prisma';
import {
  enqueueScheduledRuns,
  processPendingRuns,
} from '../src/modules/automation/automation.engine';
import { enqueueAutomationRuns } from '../src/modules/automation/automation.events';
import { createAutomationService } from '../src/modules/automation/automation.service';
import { createAutomationWorker } from '../src/modules/automation/automation.worker';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as never;

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE20_DB_TESTS=true and an explicit loopback TEST_DATABASE_URL';
try {
  databaseUrl = resolveTestDatabaseUrl('RUN_PHASE20_DB_TESTS');
  if (databaseUrl) skipReason = '';
} catch (error) {
  if (process.env.RUN_PHASE20_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database identity was rejected';
}

describe('Phase 20 automation database integration', { skip: skipReason || false }, () => {
  let prisma: PrismaClient;
  const userIds: string[] = [];
  let workspaceId = '';
  let ownerId = '';
  let memberId = '';
  let revokedId = '';
  let projectId = '';

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);
    prisma = getPrismaClient(database.url);

    const suffix = `${process.pid}-${Date.now()}`;
    const owner = await prisma.user.create({
      data: {
        email: `automation-owner-${suffix}@example.test`,
        name: 'Automation Owner',
        passwordHash: 'test-hash',
        status: 'ACTIVE',
      },
    });
    const member = await prisma.user.create({
      data: {
        email: `automation-member-${suffix}@example.test`,
        name: 'Automation Member',
        passwordHash: 'test-hash',
        status: 'ACTIVE',
      },
    });
    const revoked = await prisma.user.create({
      data: {
        email: `automation-revoked-${suffix}@example.test`,
        name: 'Automation Revoked',
        passwordHash: 'test-hash',
        status: 'ACTIVE',
      },
    });
    ownerId = owner.id;
    memberId = member.id;
    revokedId = revoked.id;
    userIds.push(owner.id, member.id, revoked.id);

    const workspace = await prisma.workspace.create({
      data: {
        name: 'Automation test workspace',
        slug: `automation-test-${suffix}`,
        ownerId: owner.id,
      },
    });
    workspaceId = workspace.id;
    await prisma.workspaceMembership.createMany({
      data: [
        { workspaceId, userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
        { workspaceId, userId: member.id, role: 'MEMBER', status: 'ACTIVE' },
        { workspaceId, userId: revoked.id, role: 'MEMBER', status: 'ACTIVE' },
      ],
    });
    const project = await prisma.project.create({
      data: {
        workspaceId,
        name: 'Automation project',
        key: 'AUT',
        ownerId: owner.id,
      },
    });
    projectId = project.id;
  });

  after(async () => {
    if (workspaceId) await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function createAutomation(
    overrides: Partial<Automation> & Pick<Automation, 'trigger' | 'action' | 'actionConfig'>,
  ): Promise<Automation> {
    return prisma.automation.create({
      data: {
        workspaceId,
        createdById: ownerId,
        name: 'Test automation',
        trigger: overrides.trigger,
        action: overrides.action,
        actionConfig: overrides.actionConfig as Prisma.InputJsonValue,
        condition: (overrides.condition ?? undefined) as Prisma.InputJsonValue | undefined,
        maxRetries: overrides.maxRetries ?? 3,
        enabled: overrides.enabled ?? true,
      },
    });
  }

  async function runById(id: string) {
    return prisma.automationRun.findUniqueOrThrow({ where: { id } });
  }

  test('enqueueing the same event twice creates one run per automation', async () => {
    const automation = await createAutomation({
      trigger: 'EVENT_TASK_CREATED',
      action: 'SEND_NOTIFICATION',
      actionConfig: { userIds: memberId, title: 'Task created' },
    });

    await enqueueAutomationRuns(
      {
        workspaceId,
        trigger: 'EVENT_TASK_CREATED',
        eventKey: `dedupe-${automation.id}`,
        payload: { workspaceId, projectId, taskId: 'task-1', priority: 'LOW' },
      },
      prisma,
      silentLogger,
    );
    await enqueueAutomationRuns(
      {
        workspaceId,
        trigger: 'EVENT_TASK_CREATED',
        eventKey: `dedupe-${automation.id}`,
        payload: { workspaceId, projectId, taskId: 'task-1', priority: 'LOW' },
      },
      prisma,
      silentLogger,
    );

    const runs = await prisma.automationRun.findMany({ where: { automationId: automation.id } });
    assert.equal(runs.length, 1);
  });

  test('a matching notification automation executes and records history', async () => {
    const automation = await createAutomation({
      trigger: 'EVENT_TASK_CREATED',
      action: 'SEND_NOTIFICATION',
      actionConfig: { userIds: memberId, title: 'A task was created', body: 'Automation body' },
    });
    await enqueueAutomationRuns(
      {
        workspaceId,
        trigger: 'EVENT_TASK_CREATED',
        eventKey: `notify-${automation.id}`,
        payload: { workspaceId, projectId, taskId: 'task-2' },
      },
      prisma,
      silentLogger,
    );

    await processPendingRuns({ prisma, logger: silentLogger });

    const run = await prisma.automationRun.findFirstOrThrow({
      where: { automationId: automation.id },
    });
    assert.equal(run.status, 'SUCCEEDED');
    assert.equal(run.attempts, 1);

    const notification = await prisma.notification.findFirst({
      where: { userId: memberId, title: 'A task was created' },
    });
    assert.ok(notification);
    assert.equal(notification?.body, 'Automation body');
  });

  test('a condition that does not match skips the run', async () => {
    const automation = await createAutomation({
      trigger: 'EVENT_TASK_CREATED',
      action: 'SEND_NOTIFICATION',
      actionConfig: { userIds: memberId, title: 'Urgent task' },
      condition: { priority: 'URGENT' },
    });
    await enqueueAutomationRuns(
      {
        workspaceId,
        trigger: 'EVENT_TASK_CREATED',
        eventKey: `condition-${automation.id}`,
        payload: { workspaceId, projectId, taskId: 'task-3', priority: 'LOW' },
      },
      prisma,
      silentLogger,
    );

    await processPendingRuns({ prisma, logger: silentLogger });

    const run = await prisma.automationRun.findFirstOrThrow({
      where: { automationId: automation.id },
    });
    assert.equal(run.status, 'SKIPPED');
  });

  test('CREATE_TASK creates a task in the target project', async () => {
    const automation = await createAutomation({
      trigger: 'EVENT_TASK_CREATED',
      action: 'CREATE_TASK',
      actionConfig: { projectId, title: 'Automated follow-up', priority: 'HIGH' },
    });
    await enqueueAutomationRuns(
      {
        workspaceId,
        trigger: 'EVENT_TASK_CREATED',
        eventKey: `create-task-${automation.id}`,
        payload: { workspaceId, projectId, taskId: 'task-4' },
      },
      prisma,
      silentLogger,
    );

    await processPendingRuns({ prisma, logger: silentLogger });

    const run = await prisma.automationRun.findFirstOrThrow({
      where: { automationId: automation.id },
    });
    assert.equal(run.status, 'SUCCEEDED');

    const task = await prisma.task.findFirst({
      where: { projectId, title: 'Automated follow-up' },
    });
    assert.ok(task);
    assert.equal(task?.priority, 'HIGH');
    assert.match(task?.key ?? '', /^AUT-\d+$/);
  });

  test('a failing webhook is retried with a bounded backoff and then fails', async () => {
    const automation = await createAutomation({
      trigger: 'EVENT_TASK_CREATED',
      action: 'SEND_WEBHOOK',
      actionConfig: { url: 'https://hooks.example.test/automation' },
      maxRetries: 1,
    });
    await enqueueAutomationRuns(
      {
        workspaceId,
        trigger: 'EVENT_TASK_CREATED',
        eventKey: `webhook-${automation.id}`,
        payload: { workspaceId, projectId, taskId: 'task-5' },
      },
      prisma,
      silentLogger,
    );

    const failingFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await processPendingRuns({
      prisma,
      logger: silentLogger,
      fetchImpl: failingFetch,
      resolveWebhookUrl: async () => new URL('https://hooks.example.test/automation'),
    });

    const firstRun = await prisma.automationRun.findFirstOrThrow({
      where: { automationId: automation.id },
    });
    assert.equal(firstRun.status, 'PENDING');
    assert.equal(firstRun.attempts, 1);
    assert.match(firstRun.error ?? '', /network down/);

    // The retry is scheduled in the future, so a second immediate pass must not
    // pick it up.
    const immediate = await processPendingRuns({
      prisma,
      logger: silentLogger,
      fetchImpl: failingFetch,
      resolveWebhookUrl: async () => new URL('https://hooks.example.test/automation'),
    });
    assert.equal(immediate.claimed, 0);

    await prisma.automationRun.update({
      where: { id: firstRun.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });

    await processPendingRuns({
      prisma,
      logger: silentLogger,
      fetchImpl: failingFetch,
      resolveWebhookUrl: async () => new URL('https://hooks.example.test/automation'),
    });

    const finalRun = await runById(firstRun.id);
    assert.equal(finalRun.status, 'FAILED');
    assert.equal(finalRun.attempts, 2);
    assert.ok(finalRun.completedAt);
  });

  test('a successful webhook receives a signed payload', async () => {
    const automation = await createAutomation({
      trigger: 'EVENT_TASK_CREATED',
      action: 'SEND_WEBHOOK',
      actionConfig: { url: 'https://hooks.example.test/signed', secret: 'test-secret' },
    });
    await enqueueAutomationRuns(
      {
        workspaceId,
        trigger: 'EVENT_TASK_CREATED',
        eventKey: `signed-webhook-${automation.id}`,
        payload: { workspaceId, projectId, taskId: 'task-6' },
      },
      prisma,
      silentLogger,
    );

    const captured: {
      value: { url: string; headers: Record<string, string>; body: string } | null;
    } = { value: null };
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.value = {
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ''),
      };
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await processPendingRuns({
      prisma,
      logger: silentLogger,
      fetchImpl,
      resolveWebhookUrl: async () => new URL('https://hooks.example.test/signed'),
    });

    const run = await prisma.automationRun.findFirstOrThrow({
      where: { automationId: automation.id },
    });
    assert.equal(run.status, 'SUCCEEDED');
    assert.ok(captured.value);
    assert.match(captured.value.headers['x-nexus-signature'] ?? '', /^sha256=[0-9a-f]{64}$/);
    assert.equal(JSON.parse(captured.value.body).automationId, automation.id);
  });

  test('a run fails when the automation owner loses workspace access', async () => {
    const automation = await prisma.automation.create({
      data: {
        workspaceId,
        createdById: revokedId,
        name: 'Revoked automation',
        trigger: 'EVENT_TASK_CREATED',
        action: 'SEND_NOTIFICATION',
        actionConfig: { userIds: memberId, title: 'Should not send' },
        maxRetries: 0,
      },
    });
    await prisma.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: revokedId } },
      data: { status: 'SUSPENDED' },
    });

    await enqueueAutomationRuns(
      {
        workspaceId,
        trigger: 'EVENT_TASK_CREATED',
        eventKey: `revoked-${automation.id}`,
        payload: { workspaceId, projectId, taskId: 'task-7' },
      },
      prisma,
      silentLogger,
    );

    await processPendingRuns({ prisma, logger: silentLogger });

    const run = await prisma.automationRun.findFirstOrThrow({
      where: { automationId: automation.id },
    });
    assert.equal(run.status, 'FAILED');
    assert.equal(run.attempts, 1);

    await prisma.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: revokedId } },
      data: { status: 'ACTIVE' },
    });
  });

  test('scheduled runs are created once per period', async () => {
    const automation = await createAutomation({
      trigger: 'SCHEDULED_DAILY',
      action: 'SEND_NOTIFICATION',
      actionConfig: { userIds: memberId, title: 'Daily digest' },
    });

    const first = await enqueueScheduledRuns(
      { prisma, logger: silentLogger },
      new Date('2026-11-10T00:00:00.000Z'),
    );
    const second = await enqueueScheduledRuns(
      { prisma, logger: silentLogger },
      new Date('2026-11-10T12:00:00.000Z'),
    );

    assert.equal(first.queued, 1);
    assert.equal(second.queued, 0);
    const runs = await prisma.automationRun.findMany({ where: { automationId: automation.id } });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.eventKey, 'schedule:daily:2026-11-10');
  });

  test('a failed run can be reset for a manual retry', async () => {
    const automation = await createAutomation({
      trigger: 'EVENT_TASK_CREATED',
      action: 'SEND_NOTIFICATION',
      actionConfig: { userIds: memberId, title: 'Retry me' },
    });
    const failed = await prisma.automationRun.create({
      data: {
        automationId: automation.id,
        status: 'FAILED',
        attempts: 3,
        error: 'previous failure',
        completedAt: new Date(),
      },
    });

    const service = createAutomationService(prisma);
    const retried = await service.retryRun({
      userId: ownerId,
      workspaceId,
      automationId: automation.id,
      runId: failed.id,
    });

    assert.equal(retried.status, 'PENDING');
    assert.equal(retried.attempts, 0);
    assert.equal(retried.error, null);
    assert.equal(retried.completedAt, null);
  });

  test('run history is workspace-scoped', async () => {
    const automation = await createAutomation({
      trigger: 'EVENT_TASK_CREATED',
      action: 'SEND_NOTIFICATION',
      actionConfig: { userIds: memberId, title: 'History' },
    });
    await prisma.automationRun.create({
      data: {
        automationId: automation.id,
        status: 'SUCCEEDED',
        attempts: 1,
        completedAt: new Date(),
      },
    });

    const service = createAutomationService(prisma);
    const runs = await service.listRuns({
      userId: memberId,
      workspaceId,
      automationId: automation.id,
    });
    assert.equal(runs.length, 1);

    await assert.rejects(
      () =>
        service.listRuns({
          userId: memberId,
          workspaceId: '00000000-0000-0000-0000-000000000000',
          automationId: automation.id,
        }),
      /workspace/i,
    );
  });

  test('SET_FIELD updates the payload task and records completion when approving', async () => {
    const task = await prisma.task.create({
      data: {
        projectId,
        key: `SET-${Date.now()}`,
        title: 'Field target',
        creatorId: ownerId,
        status: 'ASSIGNED',
      },
    });
    const automation = await createAutomation({
      trigger: 'EVENT_TASK_STATUS_CHANGED',
      action: 'SET_FIELD',
      actionConfig: { field: 'status', value: 'APPROVED' },
    });

    await enqueueAutomationRuns(
      {
        workspaceId,
        trigger: 'EVENT_TASK_STATUS_CHANGED',
        eventKey: `set-field-${automation.id}`,
        payload: { workspaceId, projectId, taskId: task.id, status: 'ASSIGNED' },
      },
      prisma,
      silentLogger,
    );
    await processPendingRuns({ prisma, logger: silentLogger });

    const run = await prisma.automationRun.findFirstOrThrow({
      where: { automationId: automation.id },
    });
    assert.equal(run.status, 'SUCCEEDED');

    const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(updated.status, 'APPROVED');
    assert.ok(updated.completedAt);
  });

  test('SET_FIELD rejects unsupported fields and records the failure reason', async () => {
    const task = await prisma.task.create({
      data: {
        projectId,
        key: `BADFIELD-${Date.now()}`,
        title: 'Field rejection target',
        creatorId: ownerId,
        status: 'ASSIGNED',
      },
    });
    const automation = await createAutomation({
      trigger: 'EVENT_TASK_STATUS_CHANGED',
      action: 'SET_FIELD',
      actionConfig: { field: 'creatorId', value: ownerId },
      maxRetries: 0,
    });

    await enqueueAutomationRuns(
      {
        workspaceId,
        trigger: 'EVENT_TASK_STATUS_CHANGED',
        eventKey: `set-field-invalid-${automation.id}`,
        payload: { workspaceId, projectId, taskId: task.id },
      },
      prisma,
      silentLogger,
    );
    await processPendingRuns({ prisma, logger: silentLogger });

    const run = await prisma.automationRun.findFirstOrThrow({
      where: { automationId: automation.id },
    });
    assert.equal(run.status, 'FAILED');
    assert.match(run.error ?? '', /AUTOMATION_UNSUPPORTED_FIELD/);

    const unchanged = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(unchanged.creatorId, ownerId);
  });

  test('ASSIGN adds the assignee and notifies them', async () => {
    const task = await prisma.task.create({
      data: {
        projectId,
        key: `ASSIGN-${Date.now()}`,
        title: 'Assignment target',
        creatorId: ownerId,
        status: 'ASSIGNED',
      },
    });
    const automation = await createAutomation({
      trigger: 'EVENT_TASK_STATUS_CHANGED',
      action: 'ASSIGN',
      actionConfig: { userIds: memberId },
    });

    await enqueueAutomationRuns(
      {
        workspaceId,
        trigger: 'EVENT_TASK_STATUS_CHANGED',
        eventKey: `assign-${automation.id}`,
        payload: { workspaceId, projectId, taskId: task.id },
      },
      prisma,
      silentLogger,
    );
    await processPendingRuns({ prisma, logger: silentLogger });

    const run = await prisma.automationRun.findFirstOrThrow({
      where: { automationId: automation.id },
    });
    assert.equal(run.status, 'SUCCEEDED');

    const assignee = await prisma.taskAssignee.findUnique({
      where: { taskId_userId: { taskId: task.id, userId: memberId } },
    });
    assert.ok(assignee);

    const notification = await prisma.notification.findFirst({
      where: { userId: memberId, type: 'TASK_ASSIGNED' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(notification);
    assert.equal(
      (notification?.data as Record<string, unknown> | null)?.taskId,
      task.id,
    );
  });

  test('POST_MESSAGE posts to the configured channel', async () => {
    const channel = await prisma.channel.create({
      data: {
        workspaceId,
        type: 'WORKSPACE',
        name: `automation-channel-${Date.now()}`,
        createdById: ownerId,
      },
    });
    const body = `Automation announcement ${Date.now()}`;
    const automation = await createAutomation({
      trigger: 'EVENT_TASK_CREATED',
      action: 'POST_MESSAGE',
      actionConfig: { channelId: channel.id, body },
    });

    await enqueueAutomationRuns(
      {
        workspaceId,
        trigger: 'EVENT_TASK_CREATED',
        eventKey: `post-message-${automation.id}`,
        payload: { workspaceId, projectId },
      },
      prisma,
      silentLogger,
    );
    await processPendingRuns({ prisma, logger: silentLogger });

    const run = await prisma.automationRun.findFirstOrThrow({
      where: { automationId: automation.id },
    });
    assert.equal(run.status, 'SUCCEEDED');

    const message = await prisma.message.findFirst({
      where: { channelId: channel.id, body },
    });
    assert.ok(message);
    assert.equal(message?.authorId, ownerId);
  });

  test('a disabled automation skips an already queued run', async () => {
    const automation = await createAutomation({
      trigger: 'EVENT_TASK_CREATED',
      action: 'SEND_NOTIFICATION',
      actionConfig: { userIds: memberId, title: 'Disabled automation notice' },
    });
    const queued = await prisma.automationRun.create({
      data: {
        automationId: automation.id,
        status: 'PENDING',
        payload: { workspaceId, projectId, taskId: 'task-disabled' },
      },
    });
    await prisma.automation.update({
      where: { id: automation.id },
      data: { enabled: false },
    });

    await processPendingRuns({ prisma, logger: silentLogger });

    const run = await runById(queued.id);
    assert.equal(run.status, 'SKIPPED');
    const notification = await prisma.notification.findFirst({
      where: { userId: memberId, title: 'Disabled automation notice' },
    });
    assert.equal(notification, null);
  });

  test('the worker queues one run per overdue task and does not duplicate it', async () => {
    const automation = await createAutomation({
      trigger: 'EVENT_TASK_DUE_DATE_PASSED',
      action: 'SEND_NOTIFICATION',
      actionConfig: { userIds: memberId, title: 'Task overdue notice' },
    });
    const dueDate = new Date('2026-01-01T00:00:00.000Z');
    const task = await prisma.task.create({
      data: {
        projectId,
        key: `DUE-${Date.now()}`,
        title: 'Overdue target',
        creatorId: ownerId,
        status: 'ASSIGNED',
        dueDate,
      },
    });

    const workerDeps = {
      prisma,
      logger: silentLogger,
      now: () => new Date('2026-12-01T00:00:00.000Z'),
    };
    const first = await createAutomationWorker(workerDeps).runOnce();
    assert.ok(first.dueDateQueued >= 1);

    const eventKey = `task.due_date_passed:${task.id}:${dueDate.toISOString()}`;
    const runs = await prisma.automationRun.findMany({
      where: { automationId: automation.id, eventKey },
    });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'SUCCEEDED');

    // A fresh worker performs another scan; the durable event key must prevent
    // a second run for the same overdue task.
    const second = await createAutomationWorker(workerDeps).runOnce();
    assert.equal(second.dueDateQueued, 0);
    assert.equal(
      await prisma.automationRun.count({
        where: { automationId: automation.id, eventKey },
      }),
      1,
    );
  });
});
