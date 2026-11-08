import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createAuthService } from '../src/modules/auth/auth.service';
import { parseEnv, type AppConfig } from '../src/config/env';
import { getPrismaClient } from '../src/db/prisma';
import type { PrismaClient } from '@prisma/client';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE3_DB_TESTS=true and an explicit loopback TEST_DATABASE_URL';
try {
  databaseUrl = resolveTestDatabaseUrl('RUN_PHASE3_DB_TESTS');
  if (databaseUrl) skipReason = '';
} catch (error) {
  if (process.env.RUN_PHASE3_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'Test database configuration is invalid';
}

describe('Google OAuth account lifecycle database tests', { skip: skipReason || false }, () => {
  let prisma: PrismaClient;
  let auth: ReturnType<typeof createAuthService>;
  const userIds = new Set<string>();
  let counter = 0;

  function config(): AppConfig {
    return parseEnv({
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl as string,
      REDIS_URL: 'redis://localhost:6379/15',
      JWT_ACCESS_SECRET: 'google-oauth-db-test-access-secret',
      TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'),
      BCRYPT_SALT_ROUNDS: '4',
      FRONTEND_URL: 'http://localhost:3000',
    });
  }

  function email(): string {
    counter += 1;
    return `google.${process.pid}.${Date.now()}.${counter}@example.com`;
  }

  before(async () => {
    assert.ok(databaseUrl);
    await connectTestDatabase(databaseUrl);
    prisma = getPrismaClient(databaseUrl);
    auth = createAuthService(config(), prisma);
  });

  after(async () => {
    if (!prisma) return;
    const ids = [...userIds];
    if (ids.length) {
      const workspaces = await prisma.workspace.findMany({
        where: { ownerId: { in: ids } },
        select: { id: true },
      });
      await prisma.workspace.deleteMany({ where: { id: { in: workspaces.map((row) => row.id) } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
  });

  test('creates one active user, verified email, Google identity and personal workspace', async () => {
    const address = email();
    const first = await auth.ensureGoogleAccount({
      subject: `subject-${address}`,
      email: address,
      name: 'Ada',
    });
    userIds.add(first.id);
    const row = await prisma.user.findUnique({
      where: { id: first.id },
      include: { externalIdentities: true, ownedWorkspaces: true },
    });
    assert.equal(row?.email, address);
    assert.equal(row?.status, 'ACTIVE');
    assert.ok(row?.emailVerifiedAt);
    assert.equal(row?.externalIdentities.length, 1);
    assert.equal(row?.ownedWorkspaces.filter((workspace) => workspace.isPersonal).length, 1);
  });

  test('returning Google subject resolves the same user and normal login creates a session', async () => {
    const address = email();
    const subject = `subject-${address}`;
    const created = await auth.ensureGoogleAccount({ subject, email: address, name: 'Grace' });
    userIds.add(created.id);
    const returning = await auth.ensureGoogleAccount({ subject, email: address, name: 'Ignored' });
    assert.equal(returning.id, created.id);
    const result = await auth.loginGoogleAccount(created.id, {
      ip: '127.0.0.1',
      userAgent: 'db-test',
    });
    assert.ok('refreshToken' in result);
    assert.equal(result.user.id, created.id);
    const session = await prisma.session.findFirst({ where: { userId: created.id } });
    assert.ok(session?.refreshTokenHash);
    const loginAudit = await prisma.auditLog.findFirst({
      where: { actorId: created.id, action: 'auth.login_succeeded' },
    });
    assert.ok(loginAudit);
  });

  test('refuses automatic linking when a Nexus account already owns the verified email', async () => {
    const address = email();
    const existing = await prisma.user.create({
      data: {
        email: address,
        name: 'Existing',
        passwordHash: 'test-hash',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    userIds.add(existing.id);
    await assert.rejects(
      auth.ensureGoogleAccount({ subject: `subject-${address}`, email: address, name: 'Existing' }),
      (error: { code?: string }) => error.code === 'GOOGLE_ACCOUNT_LINK_REQUIRED',
    );
    assert.equal(
      await prisma.externalIdentity.count({ where: { userId: existing.id, provider: 'google' } }),
      0,
    );
  });

  test('refuses deactivated accounts with an existing Google identity', async () => {
    const address = email();
    const account = await auth.ensureGoogleAccount({
      subject: `subject-${address}`,
      email: address,
      name: 'User',
    });
    userIds.add(account.id);
    await prisma.user.update({ where: { id: account.id }, data: { status: 'DEACTIVATED' } });
    await assert.rejects(
      auth.ensureGoogleAccount({ subject: `subject-${address}`, email: address, name: 'User' }),
      (error: { code?: string }) => error.code === 'ACCOUNT_DEACTIVATED',
    );
  });

  test('concurrent first sign-ins for one Google subject produce one account and identity', async () => {
    const address = email();
    const subject = `subject-${address}`;
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        auth.ensureGoogleAccount({ subject, email: address, name: 'Race' }),
      ),
    );
    userIds.add(results[0]!.id);
    assert.equal(results[0]!.id, results[1]!.id);
    assert.equal(await prisma.user.count({ where: { email: address } }), 1);
    assert.equal(
      await prisma.externalIdentity.count({
        where: { provider: 'google', providerSubjectId: subject },
      }),
      1,
    );
  });
});
