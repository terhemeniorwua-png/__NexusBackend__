import assert from 'node:assert/strict';
import test from 'node:test';
import type { BillingService } from '../src/modules/billing/billing.service';
import { createBillingSeatSyncWorker } from '../src/modules/billing/seat-sync.worker';
import type { PrismaClient } from '@prisma/client';

function workerFixture(process: () => Promise<void>) {
  const now = new Date('2026-11-04T12:00:00.000Z');
  const row = {
    id: 'sync-1',
    workspaceId: 'workspace-1',
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: now,
    updatedAt: now,
    createdAt: now,
  };
  const prisma = {
    billingSeatSync: {
      findMany: async () => (row.status === 'PENDING' ? [{ ...row }] : []),
      updateMany: async (args: {
        where: { id: string; status: string };
        data: Record<string, unknown>;
      }) => {
        if (args.where.id !== row.id || args.where.status !== row.status) return { count: 0 };
        for (const [key, value] of Object.entries(args.data)) {
          if (
            key === 'attempts' &&
            typeof value === 'object' &&
            value !== null &&
            'increment' in value
          ) {
            row.attempts += Number((value as { increment: number }).increment);
          } else {
            Object.assign(row, { [key]: value });
          }
        }
        row.updatedAt = now;
        return { count: 1 };
      },
    },
    billingCancellation: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
  } as unknown as PrismaClient;
  const service = {
    synchronizeSeatReduction: async () => process(),
    synchronizeDeletionCancellation: async () => {},
    reconcileProviderState: async () => ({ checked: 0, repairedCheckouts: 0, mismatches: 0 }),
  } as unknown as BillingService;
  return { worker: createBillingSeatSyncWorker({ prisma, service, now: () => now }), row, now };
}

test('billing seat sync completes a queued reduction once the provider update succeeds', async () => {
  const { worker, row } = workerFixture(async () => {});
  assert.deepEqual(await worker.runOnce(), { claimed: 1, completed: 1, retried: 0 });
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.attempts, 1);
});

test('billing worker retries queued account-deletion provider cancellation', async () => {
  const now = new Date('2026-11-04T12:00:00.000Z');
  const cancellation = {
    id: 'cancellation-1',
    workspaceId: 'workspace-1',
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: now,
    updatedAt: now,
    createdAt: now,
  };
  let attempts = 0;
  const prisma = {
    billingSeatSync: { findMany: async () => [] },
    billingCancellation: {
      findMany: async () => (cancellation.status === 'PENDING' ? [{ ...cancellation }] : []),
      updateMany: async (args: {
        where: { id: string; status: string };
        data: Record<string, unknown>;
      }) => {
        if (args.where.id !== cancellation.id || args.where.status !== cancellation.status)
          return { count: 0 };
        for (const [key, value] of Object.entries(args.data)) {
          if (
            key === 'attempts' &&
            typeof value === 'object' &&
            value !== null &&
            'increment' in value
          ) {
            cancellation.attempts += Number((value as { increment: number }).increment);
          } else {
            Object.assign(cancellation, { [key]: value });
          }
        }
        cancellation.updatedAt = now;
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
  const service = {
    synchronizeSeatReduction: async () => {},
    synchronizeDeletionCancellation: async () => {
      attempts += 1;
      throw new Error('provider unavailable');
    },
    reconcileProviderState: async () => ({ checked: 0, repairedCheckouts: 0, mismatches: 0 }),
  } as unknown as BillingService;
  const worker = createBillingSeatSyncWorker({ prisma, service, now: () => now });

  assert.deepEqual(await worker.runOnce(), { claimed: 1, completed: 0, retried: 1 });
  assert.equal(attempts, 1);
  assert.equal(cancellation.status, 'PENDING');
  assert.equal(cancellation.attempts, 1);
});

test('billing seat sync retries provider failures and records a future retry time', async () => {
  const { worker, row, now } = workerFixture(async () => {
    throw new Error('temporary provider failure');
  });
  assert.deepEqual(await worker.runOnce(), { claimed: 1, completed: 0, retried: 1 });
  assert.equal(row.status, 'PENDING');
  assert.equal(row.attempts, 1);
  assert.ok(row.nextAttemptAt instanceof Date);
  assert.ok(row.nextAttemptAt.getTime() > now.getTime());
});
