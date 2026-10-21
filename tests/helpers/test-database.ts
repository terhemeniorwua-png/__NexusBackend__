import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/**
 * Test database helper for the Phase 3 authentication suite.
 *
 * The suite creates and deletes real accounts, so it only runs against a
 * database that is explicitly marked as a test database. The guard below
 * refuses to touch a database whose name does not contain "test".
 */

export interface TestDatabase {
  url: string;
  prisma: PrismaClient;
}

export function resolveTestDatabaseUrl(flag = 'RUN_PHASE3_DB_TESTS'): string | null {
  if (process.env[flag] !== 'true') {
    return null;
  }

  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!url) {
    return null;
  }

  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error(
      'Refusing to run the Phase 3 database tests: the database name must contain "test".',
    );
  }

  return url;
}

async function schemaIsPresent(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('User', 'Session', 'AuthToken', 'AuditLog', 'EmailDelivery')
  `;

  return rows.length === 5;
}

export async function connectTestDatabase(url: string): Promise<TestDatabase> {
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  await prisma.$connect();

  if (!(await schemaIsPresent(prisma))) {
    // Bring the schema up to date so the suite can run from a clean database.
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'ignore',
    });

    if (!(await schemaIsPresent(prisma))) {
      throw new Error('The test database does not have the Nexus schema applied.');
    }
  }

  return { url, prisma };
}
