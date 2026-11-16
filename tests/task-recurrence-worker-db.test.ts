import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { Logger } from '../src/utils/logger';
import { createTaskRecurrenceWorker } from '../src/services/workers/task-recurrence.worker';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_TASK_RECURRENCE_WORKER_DB_TESTS=true and a test DATABASE_URL to run this suite';

try {
  databaseUrl = resolveTestDatabaseUrl('RUN_TASK_RECURRENCE_WORKER_DB_TESTS');
  if (databaseUrl) skipReason = '';
} catch (error) {
  if (process.env.RUN_TASK_RECURRENCE_WORKER_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database could not be resolved';
}

const baseNow = new Date('2026-11-16T12:00:00.000Z');

describe('Task recurrence worker', { skip: skipReason || false }, () => {
  let prisma: PrismaClient;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const projectIds: string[] = [];
  const taskIds: string[] = [];

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);
    prisma = database.prisma;
  });

  after(async () => {
    if (prisma) {
      await prisma.taskRecurrenceRule.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskCustomFieldValue.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskAssignee.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.task.deleteMany({ where: { OR: [{ id: { in: taskIds } }, { recurrenceSourceId: { in: taskIds } }] } });
      await prisma.projectMembership.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.workspaceMembership.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    }
  });

  async function createUser(name: string, suffix: string): Promise<string> {
    const email = `rec-${suffix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const user = await prisma.user.create({
      data: { email, passwordHash: 'not-used', name, status: 'ACTIVE', emailVerifiedAt: baseNow },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function createWorkspaceProject(ownerId: string) {
    const ws = await prisma.workspace.create({
      data: { name: 'Rec WS', slug: `rec-ws-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`, ownerId },
    });
    workspaceIds.push(ws.id);
    await prisma.workspaceMembership.create({ data: { workspaceId: ws.id, userId: ownerId, role: 'OWNER' } });
    const project = await prisma.project.create({
      data: { workspaceId: ws.id, name: 'Rec Project', key: `R${Date.now().toString().slice(-4)}`, ownerId },
    });
    projectIds.push(project.id);
    await prisma.projectMembership.create({ data: { projectId: project.id, userId: ownerId, role: 'PROJECT_MANAGER' } });
    return { workspaceId: ws.id, projectId: project.id };
  }

  test('running recurrence worker twice does not create duplicate instances', async () => {
    const owner = await createUser('Owner', 'dedupe');
    const { projectId } = await createWorkspaceProject(owner);

    const task = await prisma.task.create({
      data: {
        projectId,
        key: `RKEY-${Date.now().toString().slice(-4)}`,
        title: 'Recurring task',
        creatorId: owner,
        dueDate: new Date('2026-11-16T10:00:00.000Z'),
        status: 'ASSIGNED',
      },
    });
    taskIds.push(task.id);

    await prisma.taskRecurrenceRule.create({
      data: {
        taskId: task.id,
        frequency: 'DAILY',
        interval: 1,
        nextRunAt: new Date('2026-11-16T10:00:00.000Z'),
        active: true,
        occurrenceCount: 0,
      },
    });

    const worker = createTaskRecurrenceWorker({ prisma, logger: new Logger('silent'), pollIntervalMs: 60_000 });

    const res1 = await worker.runOnce(baseNow);
    assert.equal(res1.generated, 1);

    const res2 = await worker.runOnce(baseNow);
    assert.equal(res2.generated, 0);

    const created = await prisma.task.findMany({ where: { recurrenceSourceId: task.id } });
    assert.equal(created.length, 1);

    // verify rule advanced
    const rule = await prisma.taskRecurrenceRule.findUnique({ where: { taskId: task.id } });
    assert.ok(rule);
    assert.equal(rule.occurrenceCount, 1);
    assert.ok(rule.nextRunAt && rule.nextRunAt > baseNow);
  });
});
