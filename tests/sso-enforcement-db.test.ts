import type { AppConfig } from '../src/config/env';
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { getPrismaClient } from '../src/db/prisma';
import { connectRedis, disconnectRedis, getRedisClient } from '../src/db/redis';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { loadTestConfig } from './helpers/test-config';
import { createApp } from '../src/app';
import { startServer, jsonRequest, type RunningServer } from './helpers/test-server';
import { hashPassword } from '../src/services/password';
import { hashSecret } from '../src/utils/crypto';
import { requireWorkspaceAccess, WorkspaceCapability } from '../src/modules/authorization/workspace.policy';

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_SSO_DB_TESTS=true and an explicit loopback TEST_DATABASE_URL';
try {
  databaseUrl = resolveTestDatabaseUrl('RUN_SSO_DB_TESTS');
  if (databaseUrl) skipReason = '';
} catch (error) {
  if (process.env.RUN_SSO_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database identity was rejected';
}

describe('SSO enforcement (DB-gated)', { skip: skipReason || false }, () => {
  let prisma: ReturnType<typeof getPrismaClient> | null = null;
  let server: RunningServer | null = null;
  let config: AppConfig;
  const cleanup = { userIds: [] as string[], workspaceIds: [] as string[] };

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);
    prisma = getPrismaClient(database.url);
    config = loadTestConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database.url,
      TEST_DATABASE_URL: database.url,
      SSO_ENABLED: 'true',
      FRONTEND_URL: 'http://localhost:3000',
      JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123456789abcdef',
      JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef0123456789abcdef',
    });
    process.env.SSO_ENABLED = 'true';
    await connectRedis({
      redisUrl: process.env.REDIS_URL?.trim() || 'redis://localhost:6379/15',
    });
    // CI db-tests loop shares one Redis service across files; clear only rate-limit keys
    // (rl:*) to avoid collisions (same IP/endpoint patterns) without flushing unrelated data.
    // rl: prefix quoted from src/services/cache/rate-limit-store.ts: `rl:${namespace}:${key}`
    const redis = getRedisClient();
    const rlKeys: string[] = [];
    for await (const batch of redis.scanIterator({ MATCH: 'rl:*', COUNT: 200 })) {
      const keys = Array.isArray(batch) ? batch : [batch];
      for (const key of keys) rlKeys.push(String(key));
    }
    if (rlKeys.length > 0) {
      await redis.del(rlKeys);
    }
    server = await startServer(createApp({ config }));
  });

  after(async () => {
    if (server) await server.close();
    await disconnectRedis().catch(() => {});
    if (prisma) {
      for (const wid of cleanup.workspaceIds) {
        await prisma.session.deleteMany({ where: { user: { memberships: { some: { workspaceId: wid } } } } }).catch(() => {});
        await prisma.workspace.deleteMany({ where: { id: wid } }).catch(() => {});
      }
      if (cleanup.userIds.length) {
        await prisma.session.deleteMany({ where: { userId: { in: cleanup.userIds } } }).catch(() => {});
        await prisma.user.deleteMany({ where: { id: { in: cleanup.userIds } } }).catch(() => {});
      }
      await prisma.$disconnect();
    }
  });

  async function seedRequireSsoWorkspace(opts?: { breakGlassEnabled?: boolean }) {
    const db = prisma!;
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const domain = `corp-${suffix}.example.test`;
    const password = 'StrongPass123!';
    const passwordHash = await hashPassword(password, 4);
    const owner = await db.user.create({
      data: { email: `owner-${suffix}@${domain}`, name: 'Owner', passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    const member = await db.user.create({
      data: { email: `member-${suffix}@${domain}`, name: 'Member', passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    cleanup.userIds.push(owner.id, member.id);
    const workspace = await db.workspace.create({
      data: { name: `SSO WS ${suffix}`, slug: `sso-ws-${suffix}`, ownerId: owner.id, type: 'COMPANY' },
    });
    cleanup.workspaceIds.push(workspace.id);
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId: workspace.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
        { workspaceId: workspace.id, userId: member.id, role: 'MEMBER', status: 'ACTIVE' },
      ],
    });
    const ssoConfig = await db.workspaceSsoConfig.create({
      data: {
        workspaceId: workspace.id,
        providerType: 'OIDC',
        providerName: 'test-idp',
        issuer: 'https://idp.example.test',
        clientId: 'client',
        redirectUri: 'https://app.example.test/callback',
        isEnabled: true,
        requireSso: true,
        breakGlassEnabled: Boolean(opts?.breakGlassEnabled),
        status: 'ACTIVE',
        createdById: owner.id,
      },
    });
    await db.workspaceSsoDomain.create({
      data: {
        workspaceId: workspace.id,
        configId: ssoConfig.id,
        domain,
        verificationToken: 'tok',
        txtRecordName: `_nexus-sso-verification.${domain}`,
        verifiedAt: new Date(),
      },
    });
    return { domain, password, owner, member, workspace, ssoConfig };
  }

  test('password login is refused when user email domain belongs to a require-SSO workspace', async () => {
    const { member, password } = await seedRequireSsoWorkspace();
    const res = await jsonRequest(`${server!.baseUrl}${config.apiPrefix}/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email: member.email, password }),
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error?.code, 'SSO_REQUIRED');
  });

  test('password reset request is refused when user belongs to a require-SSO domain/workspace', async () => {
    const { member } = await seedRequireSsoWorkspace();
    const res = await jsonRequest(`${server!.baseUrl}${config.apiPrefix}/auth/password/forgot`, {
      method: 'POST',
      body: JSON.stringify({ email: member.email }),
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error?.code, 'SSO_REQUIRED');
  });

  test('break-glass login (owner, email+password+one-time recovery code) creates limited break_glass session, is audited and notifies other owners', async () => {
    const db = prisma!;
    const seeded = await seedRequireSsoWorkspace({ breakGlassEnabled: true });
    // add second owner to receive notification
    const otherOwner = await db.user.create({
      data: { email: `other-owner-${Date.now()}@${seeded.domain}`, name: 'Other Owner', passwordHash: await hashPassword('StrongPass123!', 4), status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    cleanup.userIds.push(otherOwner.id);
    await db.workspaceMembership.create({ data: { workspaceId: seeded.workspace.id, userId: otherOwner.id, role: 'OWNER', status: 'ACTIVE' } });

    const code = 'recovery-code-once-123456';
    await db.workspaceSsoConfig.update({
      where: { id: seeded.ssoConfig.id },
      data: { breakGlassCodeHashes: [hashSecret(code)], breakGlassEnabled: true },
    });

    const res = await jsonRequest(`${server!.baseUrl}${config.apiPrefix}/sso/workspaces/${seeded.workspace.id}/break-glass/login`, {
      method: 'POST',
      body: JSON.stringify({ email: seeded.owner.email, password: seeded.password, code }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'authenticated');
    assert.equal(res.body.session?.authMethod, 'break_glass');
    assert.ok(res.body.session?.authMethodExpiresAt);

    const sessionId = res.body.session?.id;
    const session = await db.session.findUnique({ where: { id: sessionId } });
    assert.equal(session?.authMethod, 'BREAK_GLASS');
    assert.ok(session?.authMethodExpiresAt);

    const audit = await db.auditLog.findFirst({
      where: { action: 'workspace.sso_break_glass_used', targetId: seeded.ssoConfig.id },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(audit, 'expected break-glass use to be audited');

    const notif = await db.notification.findFirst({
      where: { userId: otherOwner.id },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(notif, 'expected other owner to be notified');
  });

  test('member removal revokes sessions and removed member loses access immediately with unexpired access token context', async () => {
    const db = prisma!;
    const seeded = await seedRequireSsoWorkspace();
    // simulate SSO session creation
    const { createSession } = await import('../src/modules/auth/session.service');
    const issued = await createSession(db, {
      userId: seeded.member.id,
      ttlSeconds: 3600,
      authMethod: 'sso',
      userAgent: 'test',
      ip: '127.0.0.1',
    });
    assert.ok(!issued.session.revokedAt);

    // remove membership (service path that wires revocation)
    const { createWorkspaceService } = await import('../src/modules/workspaces/workspace.service');
    const wsService = createWorkspaceService(config, db);
    await wsService.removeMember(
      { userId: seeded.owner.id, workspaceId: seeded.workspace.id, targetUserId: seeded.member.id },
      { ip: '127.0.0.1', userAgent: 'test' },
    );

    const revoked = await db.session.findUnique({ where: { id: issued.session.id } });
    assert.ok(revoked?.revokedAt, 'expected member session to be revoked on removal in require-SSO workspace');

    // membership checked on every request: even with unexpired token/session context, access denied
    await assert.rejects(
      () => requireWorkspaceAccess(db, {
        userId: seeded.member.id,
        workspaceId: seeded.workspace.id,
        capability: WorkspaceCapability.ViewWorkspace,
        auth: { authMethod: 'sso', sessionId: issued.session.id },
      }),
      (err: { code?: string; statusCode?: number; message?: string }) => err?.code === 'WORKSPACE_ACCESS_DENIED' || err?.statusCode === 403,
    );
  });
});
