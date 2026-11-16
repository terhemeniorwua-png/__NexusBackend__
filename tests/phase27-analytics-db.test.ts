import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { parseEnv, type AppConfig } from '../src/config/env';
import { createAnalyticsService } from '../src/modules/analytics/analytics.service';
import { AppError } from '../src/utils/errors';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

/**
 * Phase 27 database-backed analytics tests.
 *
 * The real PostgreSQL schema is used. These tests verify that analytics
 * snapshots are permission-filtered by workspace membership and respect the
 * requested date range.
 */

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE27_DB_TESTS=true and a test DATABASE_URL to run this suite';

try {
  databaseUrl = resolveTestDatabaseUrl('RUN_PHASE27_DB_TESTS');

  if (databaseUrl) {
    skipReason = '';
  }
} catch (error) {
  if (process.env.RUN_PHASE27_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database could not be resolved';
}

const now = new Date('2026-11-11T00:00:00.000Z');

describe('Phase 27 reporting and analytics', { skip: skipReason || false }, () => {
  let prisma: PrismaClient;
  let config: AppConfig;
  const workspaceIds: string[] = [];
  const userIds: string[] = [];

  async function createUser(name: string): Promise<string> {
    const email = `phase27-analytics.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`;
    const user = await prisma.user.create({
      data: { email, passwordHash: 'not-used', name, status: 'ACTIVE', emailVerifiedAt: now },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function createWorkspace(ownerId: string, name: string): Promise<string> {
    const workspace = await prisma.workspace.create({
      data: { name, slug: `phase27-${Date.now()}-${Math.random().toString(36).slice(2)}`, ownerId },
    });
    workspaceIds.push(workspace.id);
    await prisma.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: ownerId, role: 'OWNER' },
    });
    return workspace.id;
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
      JWT_ACCESS_SECRET: 'phase27-integration-test-access-secret-value',
      BCRYPT_SALT_ROUNDS: '4',
      ANALYTICS_CACHE_TTL_SECONDS: '60',
      ANALYTICS_MAX_RANGE_DAYS: '366',
    });
  });

  after(async () => {
    if (prisma) {
      await prisma.fileAttachment.deleteMany({});
      await prisma.meeting.deleteMany({});
      await prisma.task.deleteMany({});
      await prisma.project.deleteMany({});
      await prisma.subscription.deleteMany({});
      await prisma.workspaceMembership.deleteMany({});
      if (workspaceIds.length > 0) {
        await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      }
      if (userIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
      await prisma.$disconnect();
    }
  });

  test('returns permission-filtered snapshot for a single workspace', async () => {
    const ownerId = await createUser('Owner');
    const workspaceId = await createWorkspace(ownerId, 'Analytics WS');

    const service = createAnalyticsService({ prisma, config, now: () => now });

    const snapshot = await service.getSnapshot({
      userId: ownerId,
      workspaceId,
      range: '30d',
    });

    assert.equal(snapshot.rangeDays, 30);
    assert.equal(snapshot.workspaces.length, 1);
    assert.equal(snapshot.workspaces[0]?.id, workspaceId);
    assert.equal(snapshot.workspaces[0]?.name, 'Analytics WS');
    assert.equal(snapshot.activity.tasksCreated, 0);
    assert.equal(snapshot.activity.tasksCompleted, 0);
    assert.equal(snapshot.subscription, null);
  });

  test('denies analytics for a workspace the user is not a member of', async () => {
    const ownerId = await createUser('Owner Two');
    const outsiderId = await createUser('Outsider');
    const workspaceId = await createWorkspace(ownerId, 'Private WS');

    const service = createAnalyticsService({ prisma, config, now: () => now });

    await assert.rejects(
      service.getSnapshot({ userId: outsiderId, workspaceId, range: '30d' }),
      (error: unknown) => error instanceof AppError && (error as AppError).statusCode === 403,
    );
  });

  test('counts tasks and projects created within the date range', async () => {
    const ownerId = await createUser('Owner Three');
    const workspaceId = await createWorkspace(ownerId, 'Counting WS');

    const project = await prisma.project.create({
      data: { workspaceId, name: 'Project A', key: 'PROJ-A', ownerId: ownerId, status: 'ACTIVE' },
    });
    await prisma.task.create({
      data: {
        projectId: project.id,
        key: 'OLD-1',
        title: 'Old task',
        creatorId: ownerId,
        status: 'ASSIGNED',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        completedAt: new Date('2026-09-02T00:00:00.000Z'),
      },
    });
    await prisma.task.create({
      data: {
        projectId: project.id,
        key: 'NEW-1',
        title: 'New task',
        creatorId: ownerId,
        status: 'ASSIGNED',
        createdAt: new Date('2026-11-05T00:00:00.000Z'),
      },
    });

    const service = createAnalyticsService({ prisma, config, now: () => now });

    const snapshot = await service.getSnapshot({
      userId: ownerId,
      workspaceId,
      range: '30d',
    });

    // Only the new task falls in the 30d window ending 2026-11-11.
    assert.equal(snapshot.activity.tasksCreated, 1);
    assert.equal(snapshot.activity.tasksCompleted, 0);
    assert.equal(snapshot.activity.projectsCreated, 1);
    assert.equal(snapshot.tasks.byStatus.find((t) => t.status === 'ASSIGNED')?.count, 1);
    assert.equal(snapshot.workspaces[0]?.memberCount, 1);
  });

  test('enforces the maximum date range', async () => {
    const ownerId = await createUser('Owner Four');
    const workspaceId = await createWorkspace(ownerId, 'Range WS');

    const service = createAnalyticsService({
      prisma,
      config: { ...config, analyticsMaxRangeDays: 7 },
      now: () => now,
    });

    await assert.rejects(
      service.getSnapshot({
        userId: ownerId,
        workspaceId,
        range: 'custom',
        startDate: new Date('2026-10-01T00:00:00.000Z'),
        endDate: new Date('2026-11-11T00:00:00.000Z'),
      }),
      (error: unknown) => error instanceof AppError && (error as AppError).statusCode === 400,
    );
  });

  test('aggregates across all accessible workspaces when none is specified', async () => {
    const ownerId = await createUser('Owner Five');
    await createWorkspace(ownerId, 'Multi WS A');
    await createWorkspace(ownerId, 'Multi WS B');

    const service = createAnalyticsService({ prisma, config, now: () => now });

    const snapshot = await service.getSnapshot({ userId: ownerId, range: '30d' });

    assert.equal(snapshot.workspaces.length, 2);
    assert.equal(snapshot.activity.membersJoined, 0);
  });

  test('workspace aggregates hide private projects from non-managers', async () => {
    const ownerId = await createUser('Scoped Owner');
    const memberId = await createUser('Scoped Member');
    const workspaceId = await createWorkspace(ownerId, 'Scoped WS');
    await prisma.workspaceMembership.create({
      data: { workspaceId, userId: memberId, role: 'MEMBER', status: 'ACTIVE' },
    });

    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const shared = await prisma.project.create({
      data: {
        workspaceId,
        name: 'Shared project',
        key: `SH-${suffix}`,
        ownerId,
        visibility: 'WORKSPACE',
      },
    });
    const hidden = await prisma.project.create({
      data: {
        workspaceId,
        name: 'Private project',
        key: `PR-${suffix}`,
        ownerId,
        visibility: 'PRIVATE',
      },
    });
    const createdAt = new Date('2026-11-01T00:00:00.000Z');
    await prisma.task.create({
      data: {
        projectId: shared.id,
        key: 'S-1',
        title: 'Shared task',
        creatorId: ownerId,
        status: 'IN_PROGRESS',
        createdAt,
      },
    });
    await prisma.task.create({
      data: {
        projectId: hidden.id,
        key: 'P-1',
        title: 'Private task',
        creatorId: ownerId,
        status: 'IN_PROGRESS',
        createdAt,
      },
    });

    const service = createAnalyticsService({ prisma, config, now: () => now });

    const memberStatus = await service.tasksByStatus({
      userId: memberId,
      workspaceId,
      range: '30d',
    });
    assert.equal(
      memberStatus.items.find((item) => item.status === 'IN_PROGRESS')?.count,
      1,
    );

    // Legacy workspace managers still see every project in their workspace.
    const ownerStatus = await service.tasksByStatus({
      userId: ownerId,
      workspaceId,
      range: '30d',
    });
    assert.equal(
      ownerStatus.items.find((item) => item.status === 'IN_PROGRESS')?.count,
      2,
    );

    const memberSnapshot = await service.getSnapshot({
      userId: memberId,
      workspaceId,
      range: '30d',
    });
    assert.equal(memberSnapshot.activity.tasksCreated, 1);

    await prisma.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: memberId } },
      data: { joinedAt: new Date('2026-11-02T00:00:00.000Z') },
    });
    const ownerSnapshot = await service.getSnapshot({
      userId: ownerId,
      workspaceId,
      range: '30d',
    });
    assert.equal(ownerSnapshot.activity.membersJoined, 1);
    assert.equal(ownerSnapshot.members.recentlyJoinedCount, 1);

    await assert.rejects(
      service.tasksByStatus({
        userId: memberId,
        workspaceId,
        projectId: hidden.id,
        range: '30d',
      }),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    );
  });

  test('tasks by assignee counts multi-assignee tasks once per assignee', async () => {
    const ownerId = await createUser('Assignee Owner');
    const memberId = await createUser('Assignee Member');
    const workspaceId = await createWorkspace(ownerId, 'Assignee WS');
    await prisma.workspaceMembership.create({
      data: { workspaceId, userId: memberId, role: 'MEMBER', status: 'ACTIVE' },
    });
    const project = await prisma.project.create({
      data: {
        workspaceId,
        name: 'Assignee project',
        key: `AS-${Date.now()}`,
        ownerId,
        visibility: 'WORKSPACE',
      },
    });
    const createdAt = new Date('2026-11-02T00:00:00.000Z');
    const shared = await prisma.task.create({
      data: {
        projectId: project.id,
        key: 'A-1',
        title: 'Shared assignment',
        creatorId: ownerId,
        status: 'IN_PROGRESS',
        createdAt,
      },
    });
    await prisma.taskAssignee.createMany({
      data: [
        { taskId: shared.id, userId: ownerId },
        { taskId: shared.id, userId: memberId },
      ],
    });
    await prisma.task.create({
      data: {
        projectId: project.id,
        key: 'A-2',
        title: 'Unassigned task',
        creatorId: ownerId,
        status: 'ASSIGNED',
        createdAt,
      },
    });

    const service = createAnalyticsService({ prisma, config, now: () => now });
    const result = await service.tasksByAssignee({ userId: ownerId, workspaceId, range: '30d' });

    assert.equal(result.items.find((item) => item.assigneeId === ownerId)?.count, 1);
    assert.equal(result.items.find((item) => item.assigneeId === memberId)?.count, 1);
    assert.equal(result.items.find((item) => item.assigneeId === null)?.count, 1);
  });

  test('task throughput buckets created and completed work by day', async () => {
    const ownerId = await createUser('Throughput Owner');
    const workspaceId = await createWorkspace(ownerId, 'Throughput WS');
    const project = await prisma.project.create({
      data: {
        workspaceId,
        name: 'Throughput project',
        key: `TP-${Date.now()}`,
        ownerId,
        visibility: 'WORKSPACE',
      },
    });
    await prisma.task.create({
      data: {
        projectId: project.id,
        key: 'T-1',
        title: 'Created and completed',
        creatorId: ownerId,
        status: 'APPROVED',
        createdAt: new Date('2026-11-05T09:00:00.000Z'),
        completedAt: new Date('2026-11-06T10:00:00.000Z'),
      },
    });
    await prisma.task.create({
      data: {
        projectId: project.id,
        key: 'T-2',
        title: 'Created only',
        creatorId: ownerId,
        status: 'IN_PROGRESS',
        createdAt: new Date('2026-11-06T11:00:00.000Z'),
      },
    });

    const service = createAnalyticsService({ prisma, config, now: () => now });
    const result = await service.tasksThroughput({ userId: ownerId, workspaceId, range: '30d' });

    assert.equal(result.created, 2);
    assert.equal(result.completed, 1);
    assert.equal(result.items.length, 30);
    assert.deepEqual(
      result.items.find((item) => item.date === '2026-11-05'),
      { date: '2026-11-05', created: 1, completed: 0 },
    );
    assert.deepEqual(
      result.items.find((item) => item.date === '2026-11-06'),
      { date: '2026-11-06', created: 1, completed: 1 },
    );
  });

  test('workload reports open and overdue tasks per assignee', async () => {
    const ownerId = await createUser('Workload Owner');
    const memberId = await createUser('Workload Member');
    const workspaceId = await createWorkspace(ownerId, 'Workload WS');
    await prisma.workspaceMembership.create({
      data: { workspaceId, userId: memberId, role: 'MEMBER', status: 'ACTIVE' },
    });
    const project = await prisma.project.create({
      data: {
        workspaceId,
        name: 'Workload project',
        key: `WL-${Date.now()}`,
        ownerId,
        visibility: 'WORKSPACE',
      },
    });
    const open = await prisma.task.create({
      data: {
        projectId: project.id,
        key: 'W-1',
        title: 'Overdue open task',
        creatorId: ownerId,
        status: 'IN_PROGRESS',
        dueDate: new Date('2026-11-01T00:00:00.000Z'),
      },
    });
    await prisma.taskAssignee.create({
      data: { taskId: open.id, userId: memberId },
    });
    const approved = await prisma.task.create({
      data: {
        projectId: project.id,
        key: 'W-2',
        title: 'Approved task',
        creatorId: ownerId,
        status: 'APPROVED',
        dueDate: new Date('2026-11-01T00:00:00.000Z'),
      },
    });
    await prisma.taskAssignee.create({
      data: { taskId: approved.id, userId: memberId },
    });
    await prisma.task.create({
      data: {
        projectId: project.id,
        key: 'W-3',
        title: 'Unassigned open task',
        creatorId: ownerId,
        status: 'ASSIGNED',
      },
    });

    const service = createAnalyticsService({ prisma, config, now: () => now });
    const result = await service.tasksWorkload({ userId: ownerId, workspaceId, range: '30d' });

    assert.deepEqual(
      result.items.find((item) => item.assigneeId === memberId),
      {
        assigneeId: memberId,
        assigneeName: 'Workload Member',
        openTasks: 1,
        overdueTasks: 1,
      },
    );
    assert.deepEqual(
      result.items.find((item) => item.assigneeId === null),
      { assigneeId: null, assigneeName: null, openTasks: 1, overdueTasks: 0 },
    );
  });

  test('time logged aggregates minutes per user', async () => {
    const ownerId = await createUser('Time Owner');
    const memberId = await createUser('Time Member');
    const workspaceId = await createWorkspace(ownerId, 'Time WS');
    await prisma.workspaceMembership.create({
      data: { workspaceId, userId: memberId, role: 'MEMBER', status: 'ACTIVE' },
    });
    const project = await prisma.project.create({
      data: {
        workspaceId,
        name: 'Time project',
        key: `TL-${Date.now()}`,
        ownerId,
        visibility: 'WORKSPACE',
      },
    });
    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        key: 'L-1',
        title: 'Tracked work',
        creatorId: ownerId,
        status: 'IN_PROGRESS',
      },
    });
    await prisma.taskTimeEntry.createMany({
      data: [
        {
          taskId: task.id,
          userId: ownerId,
          startedAt: new Date('2026-11-05T09:00:00.000Z'),
          durationMinutes: 90,
        },
        {
          taskId: task.id,
          userId: memberId,
          startedAt: new Date('2026-11-06T09:00:00.000Z'),
          durationMinutes: 30,
        },
      ],
    });

    const service = createAnalyticsService({ prisma, config, now: () => now });
    const result = await service.timeLogged({ userId: ownerId, workspaceId, range: '30d' });

    assert.equal(result.totalMinutes, 120);
    assert.deepEqual(
      result.items.map((item) => [item.userId, item.minutes]),
      [
        [ownerId, 90],
        [memberId, 30],
      ],
    );
  });
});
