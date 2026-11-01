import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { PrismaClient, UserStatus } from '@prisma/client';
import { parseEnv, type AppConfig } from '../src/config/env';
import { createEmailDeliveryService, type EmailDeliveryService } from '../src/services/email';
import {
  createTaskAssignmentNotifier,
  taskAssignmentIdempotencyKey,
  type TaskAssignmentNotifier,
} from '../src/services/task-assignment-notifier';
import type { EmailTransport } from '../src/services/providers/email';
import { Logger } from '../src/utils/logger';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

/**
 * Phase 4.3 task assignment email integration tests.
 *
 * The real PostgreSQL schema and the real transactional outbox are used. A
 * fake transport only satisfies the delivery service contract: the tests never
 * contact a provider because no worker claims the queued rows.
 */

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE4_DB_TESTS=true and a test DATABASE_URL to run this suite';

try {
  databaseUrl = resolveTestDatabaseUrl('RUN_PHASE4_DB_TESTS');

  if (databaseUrl) {
    skipReason = '';
  }
} catch (error) {
  skipReason = error instanceof Error ? error.message : 'The test database could not be resolved';
}

let uniqueCounter = 0;

function uniqueValue(prefix: string): string {
  uniqueCounter += 1;

  return `${prefix}.${process.pid}.${uniqueCounter}.${Date.now()}`;
}

function uniqueEmail(prefix: string): string {
  return `${uniqueValue(prefix)}@example.com`;
}

const neverCalledTransport: EmailTransport = {
  provider: 'phase4.3-test',
  async send() {
    throw new Error('The test transport must not be called without a worker');
  },
  async verify(): Promise<void> {
    // Nothing to verify.
  },
  async close(): Promise<void> {
    // Nothing to close.
  },
};

describe('Phase 4.3 task assignment email notifier', { skip: skipReason || false }, () => {
  let prisma: PrismaClient;
  let config: AppConfig;
  let delivery: EmailDeliveryService;
  let notifier: TaskAssignmentNotifier;
  const workspaceIds: string[] = [];
  const userIds: string[] = [];
  const emailAddresses: string[] = [];

  interface Fixture {
    workspaceId: string;
    workspaceName: string;
    projectId: string;
    taskId: string;
    ownerId: string;
    assigneeId: string;
    assigneeEmail: string;
    assignedAt: Date;
  }

  async function createFixture(options: { assigneeStatus?: UserStatus } = {}): Promise<Fixture> {
    const now = new Date();
    const ownerEmail = uniqueEmail('task-owner');
    const assigneeEmail = uniqueEmail('task-assignee');

    emailAddresses.push(ownerEmail, assigneeEmail);

    const owner = await prisma.user.create({
      data: {
        email: ownerEmail,
        passwordHash: 'not-used',
        name: 'Ada Lovelace',
        status: 'ACTIVE',
        emailVerifiedAt: now,
      },
    });
    const assignee = await prisma.user.create({
      data: {
        email: assigneeEmail,
        passwordHash: 'not-used',
        name: 'Grace Hopper',
        status: options.assigneeStatus ?? 'ACTIVE',
        emailVerifiedAt: now,
      },
    });

    userIds.push(owner.id, assignee.id);

    const workspaceName = uniqueValue('Analytical Engines');
    const workspace = await prisma.workspace.create({
      data: {
        name: workspaceName,
        slug: uniqueValue('engines'),
        ownerId: owner.id,
      },
    });

    workspaceIds.push(workspace.id);

    await prisma.workspaceMembership.createMany({
      data: [
        { workspaceId: workspace.id, userId: owner.id, role: 'OWNER' },
        { workspaceId: workspace.id, userId: assignee.id, role: 'MEMBER' },
      ],
    });

    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: 'Compiler',
        key: uniqueValue('ENG'),
        ownerId: owner.id,
        visibility: 'WORKSPACE',
      },
    });

    await prisma.projectMembership.create({
      data: { projectId: project.id, userId: assignee.id, role: 'MEMBER' },
    });

    const assignedAt = new Date('2026-11-01T10:00:00.000Z');
    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        key: uniqueValue('ENG-TASK'),
        title: 'Write the compiler',
        creatorId: owner.id,
        dueDate: new Date('2026-12-01T10:00:00.000Z'),
        assignees: {
          create: {
            userId: assignee.id,
            assignedBy: owner.id,
            assignedAt,
          },
        },
      },
    });

    return {
      workspaceId: workspace.id,
      workspaceName,
      projectId: project.id,
      taskId: task.id,
      ownerId: owner.id,
      assigneeId: assignee.id,
      assigneeEmail,
      assignedAt,
    };
  }

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);

    prisma = database.prisma;
    config = parseEnv({
      NODE_ENV: 'test',
      PORT: '4000',
      DATABASE_URL: databaseUrl as string,
      REDIS_URL: 'redis://localhost:6379/15',
      FRONTEND_URL: 'https://app.example.com',
      JWT_ACCESS_SECRET: 'phase4.3-integration-test-access-secret-value',
      BCRYPT_SALT_ROUNDS: '4',
      EMAIL_PROVIDER: 'disabled',
      EMAIL_FROM_ADDRESS: 'no-reply@example.com',
      EMAIL_FROM_NAME: 'Nexus',
    });

    const log = new Logger('silent');

    delivery = createEmailDeliveryService({
      prisma,
      transport: neverCalledTransport,
      config,
      logger: log,
    });

    notifier = createTaskAssignmentNotifier(config, {
      prisma,
      logger: log,
      send: (message) => delivery.enqueue(message),
    });
  });

  after(async () => {
    if (prisma) {
      await prisma.emailDelivery.deleteMany({
        where: { toAddress: { in: emailAddresses } },
      });
      await prisma.emailSuppression.deleteMany({
        where: { emailAddress: { in: emailAddresses.map((email) => email.toLowerCase()) } },
      });

      if (workspaceIds.length > 0) {
        await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      }

      if (userIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }

      await prisma.$disconnect();
    }
  });

  test('queues the task assignment template to the assigned project member', async () => {
    const fixture = await createFixture();
    const result = await notifier.notify({
      taskId: fixture.taskId,
      assigneeId: fixture.assigneeId,
    });

    assert.equal(result.status, 'queued');
    assert.equal(result.accepted, true);
    assert.ok(result.deliveryId);

    const row = await prisma.emailDelivery.findUnique({
      where: { id: result.deliveryId },
    });

    assert.ok(row);
    assert.equal(row.toAddress, fixture.assigneeEmail);
    assert.equal(row.template, 'task_assignment');
    assert.match(row.subject, /Ada Lovelace assigned you a task: Write the compiler/);
    assert.match(row.textBody, /Hi Grace Hopper/);
    assert.match(row.textBody, /Write the compiler/);
    assert.match(row.textBody, /Compiler/);
    assert.match(row.textBody, /Tue, 01 Dec 2026 10:00:00 GMT/);
    assert.match(
      row.textBody,
      new RegExp(
        `https://app\\.example\\.com/projects/${fixture.projectId}/tasks/${fixture.taskId}`,
      ),
    );
    assert.equal(
      row.idempotencyKey,
      taskAssignmentIdempotencyKey({
        taskId: fixture.taskId,
        assigneeId: fixture.assigneeId,
        assignedAt: fixture.assignedAt,
      }),
    );
    const metadata = row.metadata as Record<string, unknown>;

    assert.equal(metadata.taskTitle, 'Write the compiler');
    assert.equal(metadata.projectName, 'Compiler');
    assert.equal(metadata.taskId, fixture.taskId);
    assert.equal(metadata.projectId, fixture.projectId);
    assert.equal(metadata.workspaceId, fixture.workspaceId);
    assert.equal(metadata.workspaceName, fixture.workspaceName);
  });

  test('re-processing the same assignment event creates one delivery', async () => {
    const fixture = await createFixture();
    const first = await notifier.notify({
      taskId: fixture.taskId,
      assigneeId: fixture.assigneeId,
    });
    const duplicate = await notifier.notify({
      taskId: fixture.taskId,
      assigneeId: fixture.assigneeId,
    });

    assert.equal(first.status, 'queued');
    assert.equal(duplicate.status, 'queued');
    assert.equal(duplicate.deliveryId, first.deliveryId);

    const rows = await prisma.emailDelivery.findMany({
      where: { toAddress: fixture.assigneeEmail },
    });

    assert.equal(rows.length, 1);
  });

  test('reassignment notifies only the new assignee and ignores the stale event', async () => {
    const fixture = await createFixture();
    const first = await notifier.notify({
      taskId: fixture.taskId,
      assigneeId: fixture.assigneeId,
    });

    const nextEmail = uniqueEmail('task-next-assignee');
    emailAddresses.push(nextEmail);

    const next = await prisma.user.create({
      data: {
        email: nextEmail,
        passwordHash: 'not-used',
        name: 'Katherine Johnson',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    userIds.push(next.id);

    await prisma.workspaceMembership.create({
      data: { workspaceId: fixture.workspaceId, userId: next.id, role: 'MEMBER' },
    });
    await prisma.projectMembership.create({
      data: { projectId: fixture.projectId, userId: next.id, role: 'MEMBER' },
    });

    await prisma.taskAssignee.delete({
      where: {
        taskId_userId: { taskId: fixture.taskId, userId: fixture.assigneeId },
      },
    });
    await prisma.taskAssignee.create({
      data: {
        taskId: fixture.taskId,
        userId: next.id,
        assignedBy: fixture.ownerId,
        assignedAt: new Date('2026-11-02T10:00:00.000Z'),
      },
    });

    const reassigned = await notifier.notify({
      taskId: fixture.taskId,
      assigneeId: next.id,
    });
    const stale = await notifier.notify({
      taskId: fixture.taskId,
      assigneeId: fixture.assigneeId,
    });

    assert.equal(first.status, 'queued');
    assert.equal(reassigned.status, 'queued');
    assert.notEqual(reassigned.deliveryId, first.deliveryId);
    assert.equal(stale.status, 'not_found');

    const rows = await prisma.emailDelivery.findMany({
      where: { toAddress: { in: [fixture.assigneeEmail, nextEmail] } },
      orderBy: { createdAt: 'asc' },
    });

    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.toAddress),
      [fixture.assigneeEmail, nextEmail],
    );
  });

  test('a suppressed address is skipped before a delivery is created', async () => {
    const fixture = await createFixture();

    await prisma.emailSuppression.create({
      data: {
        emailAddress: fixture.assigneeEmail.toLowerCase(),
        reason: 'HARD_BOUNCE',
      },
    });

    const result = await notifier.notify({
      taskId: fixture.taskId,
      assigneeId: fixture.assigneeId,
    });

    assert.equal(result.status, 'suppressed');
    assert.equal(result.accepted, false);
    assert.equal(
      await prisma.emailDelivery.count({ where: { toAddress: fixture.assigneeEmail } }),
      0,
    );
  });

  test('an inactive assignee is not sent an email', async () => {
    const fixture = await createFixture({ assigneeStatus: 'SUSPENDED' });
    const result = await notifier.notify({
      taskId: fixture.taskId,
      assigneeId: fixture.assigneeId,
    });

    assert.equal(result.status, 'ineligible');
    assert.equal(
      await prisma.emailDelivery.count({ where: { toAddress: fixture.assigneeEmail } }),
      0,
    );
  });

  test('a user outside the workspace is not sent an email', async () => {
    const fixture = await createFixture();
    const outsiderEmail = uniqueEmail('task-outsider');
    emailAddresses.push(outsiderEmail);

    const outsider = await prisma.user.create({
      data: {
        email: outsiderEmail,
        passwordHash: 'not-used',
        name: 'Outside User',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    userIds.push(outsider.id);

    await prisma.taskAssignee.create({
      data: {
        taskId: fixture.taskId,
        userId: outsider.id,
        assignedBy: fixture.ownerId,
      },
    });

    const result = await notifier.notify({
      taskId: fixture.taskId,
      assigneeId: outsider.id,
    });

    assert.equal(result.status, 'ineligible');
    assert.equal(await prisma.emailDelivery.count({ where: { toAddress: outsiderEmail } }), 0);
  });

  test('a delivery failure leaves the committed task assignment intact', async () => {
    const fixture = await createFixture();
    const log = new Logger('silent');
    const failing = createTaskAssignmentNotifier(config, {
      prisma,
      logger: log,
      send: async () => {
        throw new Error(`SMTP rejected ${fixture.assigneeEmail}`);
      },
    });

    const result = await failing.notify({
      taskId: fixture.taskId,
      assigneeId: fixture.assigneeId,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.accepted, false);

    const task = await prisma.task.findUnique({ where: { id: fixture.taskId } });
    const assignment = await prisma.taskAssignee.findUnique({
      where: {
        taskId_userId: { taskId: fixture.taskId, userId: fixture.assigneeId },
      },
    });

    assert.equal(task?.deletedAt, null);
    assert.ok(assignment);
    assert.equal(assignment.assignedAt.toISOString(), fixture.assignedAt.toISOString());
    assert.equal(
      await prisma.emailDelivery.count({ where: { toAddress: fixture.assigneeEmail } }),
      0,
    );
  });
});
