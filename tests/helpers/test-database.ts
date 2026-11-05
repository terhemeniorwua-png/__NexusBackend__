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

const migrationsByDatabase = new Map<string, Promise<void>>();

export function resolveTestDatabaseUrl(flag = 'RUN_PHASE3_DB_TESTS'): string | null {
  if (process.env[flag] !== 'true') {
    return null;
  }

  return validateTestDatabaseConfiguration(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
}

export function validateTestDatabaseConfiguration(
  testDatabaseUrl: string | undefined,
  databaseUrl: string | undefined,
): string {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Refusing database tests: NODE_ENV must be explicitly set to test.');
  }
  if (!testDatabaseUrl || !databaseUrl) {
    throw new Error(
      'Refusing database tests: both TEST_DATABASE_URL and DATABASE_URL must be explicitly configured.',
    );
  }
  if (testDatabaseUrl !== databaseUrl) {
    throw new Error('Refusing database tests: DATABASE_URL must exactly match TEST_DATABASE_URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(testDatabaseUrl);
  } catch {
    throw new Error('Refusing database tests: TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Refusing database tests: TEST_DATABASE_URL must use PostgreSQL.');
  }
  if (
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) ||
    !/test/i.test(decodeURIComponent(parsed.pathname))
  ) {
    throw new Error(
      'Refusing database tests: TEST_DATABASE_URL must target a loopback host and a database name containing "test".',
    );
  }

  return testDatabaseUrl;
}

async function schemaIsPresent(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'User', 'Session', 'AuthToken', 'AuditLog', 'EmailDelivery',
        'Subscription', 'BillingCheckout', 'BillingPayment',
        'BillingWebhookEvent', 'BillingSeatSync', 'CompanyProfile',
        'InstitutionProfile', 'InstitutionGroup', 'InstitutionGroupMembership',
        'NotificationPreference'
      )
  `;

  return rows.length === 15;
}

export async function connectTestDatabase(url: string): Promise<TestDatabase> {
  const validatedUrl = validateTestDatabaseConfiguration(
    process.env.TEST_DATABASE_URL,
    process.env.DATABASE_URL,
  );
  if (url !== validatedUrl) {
    throw new Error(
      'Refusing database tests: requested URL does not match the configured test database.',
    );
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.$connect();
    let migrations = migrationsByDatabase.get(validatedUrl);
    if (!migrations) {
      migrations = Promise.resolve().then(() => {
        // Always migrate the explicitly configured disposable database. Never
        // load dotenv or use a development URL as a fallback.
        execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
          env: {
            ...process.env,
            NODE_ENV: 'test',
            DATABASE_URL: validatedUrl,
            TEST_DATABASE_URL: validatedUrl,
          },
          stdio: 'ignore',
        });
      });
      migrationsByDatabase.set(validatedUrl, migrations);
      migrations.catch(() => migrationsByDatabase.delete(validatedUrl));
    }
    await migrations;

    if (!(await schemaIsPresent(prisma))) {
      throw new Error('The test database does not have the Nexus schema applied.');
    }

    return { url, prisma };
  } catch (error) {
    await prisma.$disconnect().catch(() => undefined);
    throw error;
  }
}
