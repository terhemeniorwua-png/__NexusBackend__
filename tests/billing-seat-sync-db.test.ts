import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { getPrismaClient } from '../src/db/prisma';
import { enqueueWorkspaceSeatReduction } from '../src/modules/billing/membership-billing';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_BILLING_DB_TESTS=true and an explicit loopback TEST_DATABASE_URL';
try {
  databaseUrl = resolveTestDatabaseUrl('RUN_BILLING_DB_TESTS');
  if (databaseUrl) skipReason = '';
} catch (error) {
  if (process.env.RUN_BILLING_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database identity was rejected';
}

describe('billing seat sync database integration', { skip: skipReason || false }, () => {
  let prisma: ReturnType<typeof getPrismaClient> | null = null;
  const userIds: string[] = [];
  let workspaceId = '';

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);
    assert.equal(database.url, databaseUrl);
    prisma = getPrismaClient(database.url);
  });

  after(async () => {
    if (workspaceId) await prisma?.workspace.deleteMany({ where: { id: workspaceId } });
    if (userIds.length) await prisma?.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma?.$disconnect();
  });

  test('member reductions persist the current billable seat target transactionally', async () => {
    const db = prisma!;
    const owner = await db.user.create({
      data: {
        email: `billing-owner-${process.pid}@example.test`,
        name: 'Billing Owner',
        passwordHash: 'test-hash',
        status: 'ACTIVE',
      },
    });
    userIds.push(owner.id);
    const first = await db.user.create({
      data: {
        email: `billing-member-a-${process.pid}@example.test`,
        name: 'Billing Member A',
        passwordHash: 'test-hash',
        status: 'ACTIVE',
      },
    });
    const second = await db.user.create({
      data: {
        email: `billing-member-b-${process.pid}@example.test`,
        name: 'Billing Member B',
        passwordHash: 'test-hash',
        status: 'ACTIVE',
      },
    });
    userIds.push(first.id, second.id);
    const workspace = await db.workspace.create({
      data: {
        name: 'Billing seat sync test',
        slug: `billing-seat-sync-${process.pid}`,
        ownerId: owner.id,
      },
    });
    workspaceId = workspace.id;
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId, userId: owner.id, status: 'ACTIVE' },
        { workspaceId, userId: first.id, status: 'ACTIVE' },
        { workspaceId, userId: second.id, status: 'ACTIVE' },
      ],
    });
    await db.subscription.create({
      data: {
        workspaceId,
        plan: 'PRO',
        interval: 'MONTHLY',
        status: 'ACTIVE',
        billableSeats: 4,
        currentPeriodStart: new Date('2026-11-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z'),
      },
    });

    await db.$transaction(async (tx) => {
      await tx.workspaceMembership.delete({
        where: { workspaceId_userId: { workspaceId, userId: second.id } },
      });
      await enqueueWorkspaceSeatReduction(tx, workspaceId);
    });

    const queued = await db.billingSeatSync.findUnique({ where: { workspaceId } });
    assert.equal(queued?.requestedSeats, 2);
    assert.equal(queued?.status, 'PENDING');
  });
});
