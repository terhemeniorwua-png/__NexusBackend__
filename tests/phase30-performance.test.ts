import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

/**
 * Phase 30 database-backed tests.
 *
 * These verify that the performance indexes added for analytics and audit
 * query patterns exist in the database, so read-only aggregation queries
 * do not scan large tables as workspaces grow.
 */

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE30_DB_TESTS=true and a test DATABASE_URL to run this suite';

try {
  databaseUrl = resolveTestDatabaseUrl('RUN_PHASE30_DB_TESTS');

  if (databaseUrl) {
    skipReason = '';
  }
} catch (error) {
  if (process.env.RUN_PHASE30_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database could not be resolved';
}

const expectedIndexes = [
  { table: 'Task', index: 'Task_createdAt_idx' },
  { table: 'Task', index: 'Task_completedAt_idx' },
  { table: 'FileAttachment', index: 'FileAttachment_workspaceId_createdAt_idx' },
];

describe('Phase 30 performance indexes', { skip: skipReason || false }, () => {
  let prisma: PrismaClient;

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);
    prisma = database.prisma;
  });

  after(async () => {
    if (prisma) await prisma.$disconnect();
  });

  test('analytics and audit performance indexes exist', async () => {
    for (const { table, index } of expectedIndexes) {
      const row = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
        `SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname = $2`,
        table,
        index,
      );
      assert.equal(
        row.length,
        1,
        `Expected index ${index} on table ${table} to exist`,
      );
    }
  });
});
