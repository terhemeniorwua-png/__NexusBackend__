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
});
