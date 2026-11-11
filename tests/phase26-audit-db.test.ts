import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { parseEnv, type AppConfig } from '../src/config/env';
import { recordAuditEvent, isSecurityEvent } from '../src/services/audit';
import {
  createAuditPruneWorker,
  type AuditPruneWorker,
} from '../src/services/workers/audit-prune.worker';
import { Logger } from '../src/utils/logger';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

/**
 * Phase 26 database-backed audit tests.
 *
 * The real PostgreSQL schema is used. These tests verify that security-relevant
 * audit actions are classified and that the retention pruning worker removes
 * only entries older than the retention window.
 */

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE26_DB_TESTS=true and a test DATABASE_URL to run this suite';

try {
  databaseUrl = resolveTestDatabaseUrl('RUN_PHASE26_DB_TESTS');

  if (databaseUrl) {
    skipReason = '';
  }
} catch (error) {
  if (process.env.RUN_PHASE26_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database could not be resolved';
}

const now = new Date('2026-11-11T00:00:00.000Z');

describe('Phase 26 audit logging and retention', { skip: skipReason || false }, () => {
  let prisma: PrismaClient;
  let config: AppConfig;
  let pruneWorker: AuditPruneWorker;
  const workspaceIds: string[] = [];
  const userIds: string[] = [];

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);

    prisma = database.prisma;
    config = parseEnv({
      NODE_ENV: 'test',
      PORT: '4000',
      DATABASE_URL: databaseUrl as string,
      REDIS_URL: 'redis://localhost:6379/15',
      FRONTEND_URL: 'https://app.example.com',
      JWT_ACCESS_SECRET: 'phase26-integration-test-access-secret-value',
      BCRYPT_SALT_ROUNDS: '4',
      // Retain entries for 30 days so the prune boundary is controllable.
      AUDIT_RETENTION_DAYS: '30',
      AUDIT_PRUNE_BATCH_SIZE: '10',
    });

    const log = new Logger('silent');
    pruneWorker = createAuditPruneWorker({ prisma, config, logger: log });
  });

  after(async () => {
    if (prisma) {
      await prisma.auditLog.deleteMany({});
      if (workspaceIds.length > 0) {
        await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      }
      if (userIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
      await prisma.$disconnect();
    }
  });

  async function createActor(name: string): Promise<string> {
    const email = `phase26-audit.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`;
    const user = await prisma.user.create({
      data: { email, passwordHash: 'not-used', name, status: 'ACTIVE', emailVerifiedAt: now },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function createWorkspace(ownerId: string): Promise<string> {
    const workspace = await prisma.workspace.create({
      data: { name: 'Phase26 Audit WS', slug: `phase26-audit-ws-${Date.now()}`, ownerId },
    });
    workspaceIds.push(workspace.id);
    await prisma.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: ownerId, role: 'OWNER' },
    });
    return workspace.id;
  }

  test('recordAuditEvent classifies security and routine events correctly', async () => {
    const actorId = await createActor('Ada');
    const workspaceId = await createWorkspace(actorId);

    await recordAuditEvent(prisma, {
      workspaceId,
      actorId,
      action: 'workspace.member_removed',
      targetType: 'WorkspaceMembership',
      targetId: 'membership-1',
    });
    await recordAuditEvent(prisma, {
      workspaceId,
      actorId,
      action: 'task.created',
      targetType: 'Task',
      targetId: 'task-1',
    });

    const security = await prisma.auditLog.findMany({
      where: { workspaceId, securityEvent: true },
    });
    const routine = await prisma.auditLog.findMany({
      where: { workspaceId, securityEvent: false },
    });

    assert.equal(security.length, 1);
    assert.equal(security[0]?.action, 'workspace.member_removed');
    assert.equal(routine.length, 1);
    assert.equal(routine[0]?.action, 'task.created');
  });

  test('isSecurityEvent classification matches recorded flag', async () => {
    assert.equal(isSecurityEvent('workspace.member_removed'), true);
    assert.equal(isSecurityEvent('task.created'), false);
  });

  test('prune worker deletes entries older than the retention window', async () => {
    const actorId = await createActor('Grace');
    const workspaceId = await createWorkspace(actorId);

    const cutoff = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const oldDate = new Date(cutoff.getTime() - 1000);
    const recentDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

    await prisma.auditLog.createMany({
      data: [
        {
          workspaceId,
          actorId,
          action: 'workspace.created',
          targetType: 'Workspace',
          targetId: 't1',
          createdAt: oldDate,
        },
        {
          workspaceId,
          actorId,
          action: 'workspace.created',
          targetType: 'Workspace',
          targetId: 't2',
          createdAt: oldDate,
        },
        {
          workspaceId,
          actorId,
          action: 'workspace.created',
          targetType: 'Workspace',
          targetId: 't3',
          createdAt: recentDate,
        },
      ],
    });

    const result = await pruneWorker.runOnce();
    assert.equal(result.deleted, 2);
    assert.equal(result.scanned, 2);

    const remaining = await prisma.auditLog.count({ where: { workspaceId } });
    assert.equal(remaining, 1);
    const survivor = await prisma.auditLog.findFirst({ where: { workspaceId } });
    assert.equal(survivor?.targetId, 't3');
  });

  test('prune worker keeps entries within the retention window', async () => {
    const actorId = await createActor('Kate');
    const workspaceId = await createWorkspace(actorId);

    const recentDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    await prisma.auditLog.create({
      data: {
        workspaceId,
        actorId,
        action: 'workspace.created',
        targetType: 'Workspace',
        targetId: 't-recent',
        createdAt: recentDate,
      },
    });

    const result = await pruneWorker.runOnce();
    assert.equal(result.deleted, 0);
    assert.equal(result.scanned, 0);

    const remaining = await prisma.auditLog.count({ where: { workspaceId } });
    assert.equal(remaining, 1);
  });

  test('prune worker batches deletions larger than the batch size', async () => {
    const actorId = await createActor('Alan');
    const workspaceId = await createWorkspace(actorId);

    const cutoff = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const oldDate = new Date(cutoff.getTime() - 1000);
    // 25 old entries with a batch size of 10 -> 3 passes (10, 10, 5).
    await prisma.auditLog.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        workspaceId,
        actorId,
        action: 'workspace.created',
        targetType: 'Workspace',
        targetId: `t-old-${i}`,
        createdAt: oldDate,
      })),
    });

    const result = await pruneWorker.runOnce();
    assert.equal(result.deleted, 25);
    assert.equal(result.scanned, 25);

    const remaining = await prisma.auditLog.count({ where: { workspaceId } });
    assert.equal(remaining, 0);
  });
});
