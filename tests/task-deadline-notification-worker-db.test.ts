import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { NotificationType, Prisma, PrismaClient } from '@prisma/client';
import { Logger } from '../src/utils/logger';
import { createTaskDeadlineNotificationWorker } from '../src/services/workers/task-deadline-notification.worker';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

function hasTaskId(data: Prisma.JsonValue | null | undefined, taskId: string): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  return (data as Record<string, unknown>).taskId === taskId;
}

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_TASK_DEADLINE_NOTIFICATION_DB_TESTS=true and a test DATABASE_URL to run this suite';

try {
  databaseUrl = resolveTestDatabaseUrl('RUN_TASK_DEADLINE_NOTIFICATION_DB_TESTS');
  if (databaseUrl) skipReason = '';
} catch (error) {
  if (process.env.RUN_TASK_DEADLINE_NOTIFICATION_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database could not be resolved';
}

const baseNow = new Date('2026-11-16T12:00:00.000Z');

describe('Task deadline notification worker', { skip: skipReason || false }, () => {
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
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.notificationPreference.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.taskAssignee.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
      await prisma.projectMembership.deleteMany({ where: { projectId: { in: projectIds } } });
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
      await prisma.workspaceMembership.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    }
  });

  async function createUser(name: string, suffix: string): Promise<string> {
    const email = `p4e-${suffix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const user = await prisma.user.create({
      data: { email, passwordHash: 'not-used', name, status: 'ACTIVE', emailVerifiedAt: baseNow },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function createWorkspaceProject(ownerId: string): Promise<{ workspaceId: string; projectId: string }> {
    const ws = await prisma.workspace.create({
      data: { name: 'P4E WS', slug: `p4e-ws-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`, ownerId },
    });
    workspaceIds.push(ws.id);
    await prisma.workspaceMembership.create({ data: { workspaceId: ws.id, userId: ownerId, role: 'OWNER' } });
    const project = await prisma.project.create({
      data: { workspaceId: ws.id, name: 'P4E Project', key: `P4E${String(Date.now()).slice(-4)}`, ownerId },
    });
    projectIds.push(project.id);
    await prisma.projectMembership.create({ data: { projectId: project.id, userId: ownerId, role: 'PROJECT_MANAGER' } });
    return { workspaceId: ws.id, projectId: project.id };
  }

  async function createTask(input: {
    projectId: string;
    creatorId: string;
    title: string;
    key: string;
    dueDate?: Date | null;
    status?: 'ASSIGNED' | 'IN_PROGRESS' | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'CHANGES_REQUESTED';
    completedAt?: Date | null;
    archivedAt?: Date | null;
    deletedAt?: Date | null;
    assigneeIds?: string[];
    dueSoonNotifiedAt?: Date | null;
    overdueNotifiedAt?: Date | null;
  }): Promise<string> {
    const task = await prisma.task.create({
      data: {
        projectId: input.projectId,
        key: input.key,
        title: input.title,
        creatorId: input.creatorId,
        dueDate: input.dueDate ?? null,
        status: input.status ?? 'ASSIGNED',
        completedAt: input.completedAt ?? null,
        archivedAt: input.archivedAt ?? null,
        deletedAt: input.deletedAt ?? null,
        dueSoonNotifiedAt: input.dueSoonNotifiedAt ?? null,
        overdueNotifiedAt: input.overdueNotifiedAt ?? null,
      },
    });
    taskIds.push(task.id);
    if (input.assigneeIds?.length) {
      await prisma.taskAssignee.createMany({
        data: input.assigneeIds.map((userId) => ({ taskId: task.id, userId })),
        skipDuplicates: true,
      });
    }
    return task.id;
  }

  function makeWorker(now?: () => Date) {
    return createTaskDeadlineNotificationWorker({ prisma, logger: new Logger('silent'), pollIntervalMs: 60_000, now });
  }

  test('task outside 24-hour window receives no due-soon notification', async () => {
    const owner = await createUser('Owner', 'outside');
    const assignee = await createUser('Assignee', 'outside');
    const { projectId } = await createWorkspaceProject(owner);
    const due = new Date(baseNow.getTime() + 25 * 60 * 60 * 1000);
    const taskId = await createTask({ projectId, creatorId: owner, title: 'Outside', key: `O${Date.now()}`, dueDate: due, assigneeIds: [assignee] });

    const worker = makeWorker(() => baseNow);
    const res = await worker.runOnce(baseNow);
    assert.equal(res.dueSoon, 0);
    const notifs = await prisma.notification.findMany({ where: { userId: assignee, type: 'TASK_DUE_SOON' as NotificationType } });
    assert.equal(notifs.length, 0);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(task.dueSoonNotifiedAt, null);
  });

  test('task entering 24-hour window receives due-soon once; not repeated', async () => {
    const owner = await createUser('Owner', 'duesoon');
    const assignee = await createUser('Assignee', 'duesoon');
    const { projectId } = await createWorkspaceProject(owner);
    const due = new Date(baseNow.getTime() + 23 * 60 * 60 * 1000);
    const taskId = await createTask({ projectId, creatorId: owner, title: 'DueSoon', key: `DS${Date.now()}`, dueDate: due, assigneeIds: [assignee] });

    const worker = makeWorker();
    const r1 = await worker.runOnce(baseNow);
    assert.equal(r1.dueSoon, 1);
    const r2 = await worker.runOnce(new Date(baseNow.getTime() + 60_000));
    assert.equal(r2.dueSoon, 0);

    const notifs = await prisma.notification.findMany({ where: { userId: assignee, type: 'TASK_DUE_SOON' as NotificationType } });
    const filtered = notifs.filter((n) => hasTaskId(n.data, taskId));
    assert.equal(filtered.length, 1);
  });

  test('task reaching deadline receives overdue once; not repeated', async () => {
    const owner = await createUser('Owner', 'overdue');
    const assignee = await createUser('Assignee', 'overdue');
    const { projectId } = await createWorkspaceProject(owner);
    const due = new Date(baseNow.getTime() - 60_000);
    const taskId = await createTask({ projectId, creatorId: owner, title: 'Overdue', key: `OD${Date.now()}`, dueDate: due, assigneeIds: [assignee] });

    const worker = makeWorker();
    const r1 = await worker.runOnce(baseNow);
    assert.equal(r1.overdue, 1);
    const r2 = await worker.runOnce(new Date(baseNow.getTime() + 60_000));
    assert.equal(r2.overdue, 0);

    const notifs = await prisma.notification.findMany({ where: { userId: assignee, type: 'TASK_OVERDUE' as NotificationType } });
    const filtered = notifs.filter((n) => hasTaskId(n.data, taskId));
    assert.equal(filtered.length, 1);
  });

  test('due-soon and overdue can both be sent for same eligible task', async () => {
    const owner = await createUser('Owner', 'both');
    const assignee = await createUser('Assignee', 'both');
    const { projectId } = await createWorkspaceProject(owner);
    const due = new Date(baseNow.getTime() + 2 * 60 * 60 * 1000);
    const taskId = await createTask({ projectId, creatorId: owner, title: 'Both', key: `BT${Date.now()}`, dueDate: due, assigneeIds: [assignee] });

    const worker = makeWorker();
    const t1 = baseNow; // within 24h
    const r1 = await worker.runOnce(t1);
    assert.equal(r1.dueSoon, 1);
    const t2 = new Date(due.getTime() + 60_000); // overdue
    const r2 = await worker.runOnce(t2);
    assert.equal(r2.overdue, 1);

    const dueSoon = await prisma.notification.findMany({ where: { userId: assignee, type: 'TASK_DUE_SOON' as NotificationType } });
    const overdue = await prisma.notification.findMany({ where: { userId: assignee, type: 'TASK_OVERDUE' as NotificationType } });
    assert.equal(dueSoon.filter((n) => hasTaskId(n.data, taskId)).length, 1);
    assert.equal(overdue.filter((n) => hasTaskId(n.data, taskId)).length, 1);
  });

  test('notifies only current assignees; no assignees excluded', async () => {
    const owner = await createUser('Owner', 'assignees');
    const a1 = await createUser('A1', 'assignees');
    const a2 = await createUser('A2', 'assignees');
    const { projectId } = await createWorkspaceProject(owner);
    const due = new Date(baseNow.getTime() + 60 * 60 * 1000);
    const taskId = await createTask({ projectId, creatorId: owner, title: 'Multi', key: `MA${Date.now()}`, dueDate: due, assigneeIds: [a1, a2] });
    const noAssigneeTask = await createTask({ projectId, creatorId: owner, title: 'None', key: `NA${Date.now()}`, dueDate: due, assigneeIds: [] });

    const worker = makeWorker();
    await worker.runOnce(baseNow);

    const n1 = (await prisma.notification.findMany({ where: { userId: a1, type: 'TASK_DUE_SOON' as NotificationType } })).filter((n) => hasTaskId(n.data, taskId));
    const n2 = (await prisma.notification.findMany({ where: { userId: a2, type: 'TASK_DUE_SOON' as NotificationType } })).filter((n) => hasTaskId(n.data, taskId));
    assert.equal(n1.length, 1);
    assert.equal(n2.length, 1);
    const noneTask = await prisma.task.findUniqueOrThrow({ where: { id: noAssigneeTask } });
    assert.equal(noneTask.dueSoonNotifiedAt, null);
  });

  test('excluded: deleted, archived, approved, completedAt set, and awaiting approval behavior', async () => {
    const owner = await createUser('Owner', 'excluded');
    const assignee = await createUser('Assignee', 'excluded');
    const { projectId } = await createWorkspaceProject(owner);
    const dueSoon = new Date(baseNow.getTime() + 60 * 60 * 1000);
    const overdue = new Date(baseNow.getTime() - 60_000);

    const deleted = await createTask({ projectId, creatorId: owner, title: 'Del', key: `D${Date.now()}`, dueDate: overdue, assigneeIds: [assignee], deletedAt: baseNow });
    const archived = await createTask({ projectId, creatorId: owner, title: 'Arch', key: `A${Date.now()}1`, dueDate: overdue, assigneeIds: [assignee], archivedAt: baseNow });
    const approved = await createTask({ projectId, creatorId: owner, title: 'Appr', key: `AP${Date.now()}`, dueDate: overdue, assigneeIds: [assignee], status: 'APPROVED' });
    const completed = await createTask({ projectId, creatorId: owner, title: 'Comp', key: `C${Date.now()}`, dueDate: overdue, assigneeIds: [assignee], completedAt: baseNow });
    // submitted awaiting approval is not approved => eligible
    const submitted = await createTask({ projectId, creatorId: owner, title: 'Sub', key: `S${Date.now()}`, dueDate: dueSoon, assigneeIds: [assignee], status: 'SUBMITTED' });

    const worker = makeWorker();
    await worker.runOnce(baseNow);

    for (const id of [deleted, archived, approved, completed]) {
      const t = await prisma.task.findUniqueOrThrow({ where: { id } });
      assert.equal(t.overdueNotifiedAt, null);
      const n = (await prisma.notification.findMany({ where: { userId: assignee } })).filter((x) => hasTaskId(x.data, id));
      assert.equal(n.length, 0);
    }
    const subNotifs = (await prisma.notification.findMany({ where: { userId: assignee, type: 'TASK_DUE_SOON' as NotificationType } })).filter((x) => hasTaskId(x.data, submitted));
    assert.equal(subNotifs.length, 1);
  });

  test('notification preferences respected', async () => {
    const owner = await createUser('Owner', 'prefs');
    const assignee = await createUser('Assignee', 'prefs');
    const { workspaceId, projectId } = await createWorkspaceProject(owner);
    await prisma.workspaceMembership.create({
      data: { workspaceId, userId: assignee, role: 'MEMBER' },
    });
    await prisma.notificationPreference.create({
      data: { workspaceId, userId: assignee, type: 'TASK_DUE_SOON' as NotificationType, inAppEnabled: false },
    });
    const due = new Date(baseNow.getTime() + 60 * 60 * 1000);
    const taskId = await createTask({ projectId, creatorId: owner, title: 'Pref', key: `PR${Date.now()}`, dueDate: due, assigneeIds: [assignee] });

    const worker = makeWorker();
    const res = await worker.runOnce(baseNow);
    assert.equal(res.dueSoon, 1); // threshold claimed/sent processed
    const notifs = (await prisma.notification.findMany({ where: { userId: assignee, type: 'TASK_DUE_SOON' as NotificationType } })).filter((n) => hasTaskId(n.data, taskId));
    assert.equal(notifs.length, 0);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    assert.ok(task.dueSoonNotifiedAt !== null);
  });

  test('due date change does not resend same notification type', async () => {
    const owner = await createUser('Owner', 'resched');
    const assignee = await createUser('Assignee', 'resched');
    const { projectId } = await createWorkspaceProject(owner);
    const due = new Date(baseNow.getTime() + 60 * 60 * 1000);
    const taskId = await createTask({ projectId, creatorId: owner, title: 'Resched', key: `RS${Date.now()}`, dueDate: due, assigneeIds: [assignee] });

    const worker = makeWorker();
    await worker.runOnce(baseNow);
    // change due date to another time in window and run again
    await prisma.task.update({ where: { id: taskId }, data: { dueDate: new Date(baseNow.getTime() + 2 * 60 * 60 * 1000) } });
    await worker.runOnce(baseNow);

    const notifs = (await prisma.notification.findMany({ where: { userId: assignee, type: 'TASK_DUE_SOON' as NotificationType } })).filter((n) => hasTaskId(n.data, taskId));
    assert.equal(notifs.length, 1);
  });

  test('concurrent executions do not produce duplicate notifications', async () => {
    const owner = await createUser('Owner', 'concurrent');
    const assignee = await createUser('Assignee', 'concurrent');
    const { projectId } = await createWorkspaceProject(owner);
    const due = new Date(baseNow.getTime() + 60 * 60 * 1000);
    const taskId = await createTask({ projectId, creatorId: owner, title: 'Conc', key: `CC${Date.now()}`, dueDate: due, assigneeIds: [assignee] });

    const w1 = makeWorker();
    const w2 = makeWorker();
    await Promise.all([w1.runOnce(baseNow), w2.runOnce(baseNow), w1.runOnce(baseNow)]);

    const notifs = (await prisma.notification.findMany({ where: { userId: assignee, type: 'TASK_DUE_SOON' as NotificationType } })).filter((n) => hasTaskId(n.data, taskId));
    assert.equal(notifs.length, 1);
  });

  test('worker restart does not cause duplicate notifications', async () => {
    const owner = await createUser('Owner', 'restart');
    const assignee = await createUser('Assignee', 'restart');
    const { projectId } = await createWorkspaceProject(owner);
    const due = new Date(baseNow.getTime() + 60 * 60 * 1000);
    const taskId = await createTask({ projectId, creatorId: owner, title: 'Restart', key: `RE${Date.now()}`, dueDate: due, assigneeIds: [assignee] });

    const w1 = createTaskDeadlineNotificationWorker({ prisma, logger: new Logger('silent'), pollIntervalMs: 60_000 });
    w1.start();
    await w1.runOnce(baseNow);
    await w1.stop();

    const w2 = createTaskDeadlineNotificationWorker({ prisma, logger: new Logger('silent'), pollIntervalMs: 60_000 });
    await w2.runOnce(baseNow);
    await w2.stop();

    const notifs = (await prisma.notification.findMany({ where: { userId: assignee, type: 'TASK_DUE_SOON' as NotificationType } })).filter((n) => hasTaskId(n.data, taskId));
    assert.equal(notifs.length, 1);
  });
});
