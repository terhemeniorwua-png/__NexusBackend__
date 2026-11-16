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
});
