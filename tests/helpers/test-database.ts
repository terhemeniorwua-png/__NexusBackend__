import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

/**
 * Test database helper for database-backed suites.
 *
 * The suite creates and deletes real accounts, so it only runs against a
 * database that is explicitly marked as a test database. The guard below
 * requires an explicit TEST_DATABASE_URL, a loopback host, and a database
 * name containing "test". It never falls back to DATABASE_URL or dotenv.
 */

export interface TestDatabase {
  url: string;
  prisma: PrismaClient;
}

export function resolveTestDatabaseUrl(flag = 'RUN_PHASE3_DB_TESTS'): string | null {
  if (process.env[flag] !== 'true') {
    return null;
  }

  const url = process.env.TEST_DATABASE_URL;

  if (!url) {
    return null;
  }

  const parsed = new URL(url);
  if (
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) ||
    !/test/i.test(parsed.pathname)
  ) {
    throw new Error(
      'Refusing database tests: TEST_DATABASE_URL must target a loopback host and a database name containing "test".',
    );
  }

  return url;
}

async function schemaIsPresent(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'User', 'Session', 'AuthToken', 'AuditLog', 'EmailDelivery',
        'Subscription', 'BillingCheckout', 'BillingPayment',
        'BillingWebhookEvent', 'BillingSeatSync'
      )
  `;

  return rows.length === 10;
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
