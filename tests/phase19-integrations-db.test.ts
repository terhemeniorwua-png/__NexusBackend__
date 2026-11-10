import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { createIntegrationService } from '../src/modules/integrations/integration.service';
import type { ProviderLifecycle } from '../src/modules/integrations/provider-lifecycle';
import { decryptIntegrationToken } from '../src/modules/integrations/token-crypto';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

const DB_FLAG = 'RUN_PHASE19_DB_TESTS';
let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE19_DB_TESTS=true and an explicit loopback TEST_DATABASE_URL';
try {
  databaseUrl = resolveTestDatabaseUrl(DB_FLAG);
  if (databaseUrl) skipReason = '';
} catch (error) {
  if (process.env[DB_FLAG] === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database identity was rejected';
}

describe(
  'Phase 19 integration lifecycle database integration',
  { skip: skipReason || false },
  () => {
    let prisma: PrismaClient;
    let service: ReturnType<typeof createIntegrationService>;
    const userIds: string[] = [];
    const workspaceIds: string[] = [];
    let ownerId = '';
    let otherId = '';
    let workspaceId = '';
    let refreshCalls = 0;
    let revokeCalls = 0;
    let refreshFailure: Error | null = null;

    const lifecycle: ProviderLifecycle = {
      async refresh() {
        refreshCalls += 1;
        if (refreshFailure) throw refreshFailure;
        return {
          accessToken: `access-${refreshCalls}`,
          refreshToken: `refresh-${refreshCalls}`,
          tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        };
      },
      async revoke() {
        revokeCalls += 1;
        return { revoked: true };
      },
    };

    before(async () => {
      process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString('base64url');
      const database = await connectTestDatabase(databaseUrl as string);
      prisma = database.prisma;
      service = createIntegrationService(prisma, lifecycle);
      const suffix = `${process.pid}-${Date.now()}`;

      const owner = await prisma.user.create({
        data: {
          email: `int-owner-${suffix}@example.test`,
          name: 'Integration Owner',
          passwordHash: 'x',
          status: 'ACTIVE',
        },
      });
      const other = await prisma.user.create({
        data: {
          email: `int-other-${suffix}@example.test`,
          name: 'Integration Other',
          passwordHash: 'x',
          status: 'ACTIVE',
        },
      });
      ownerId = owner.id;
      otherId = other.id;
      userIds.push(owner.id, other.id);

      const workspace = await prisma.workspace.create({
        data: { name: `Integration ${suffix}`, slug: `integration-${suffix}`, ownerId: owner.id },
      });
      workspaceId = workspace.id;
      workspaceIds.push(workspace.id);
      await prisma.workspaceMembership.create({
        data: { workspaceId, userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
      });
    });

    after(async () => {
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.$disconnect();
    });

    async function connectPersonal(
      provider: 'GMAIL' | 'DROPBOX',
      expiresInMs = 60_000,
    ): Promise<string> {
      const connected = await service.connect({
        userId: ownerId,
        provider,
        accessToken: 'initial-access',
        refreshToken: 'initial-refresh',
        tokenExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
        scopes: ['read'],
      });
      return connected.id;
    }

    test('refresh rotates the encrypted access token and records the timestamp', async () => {
      const integrationId = await connectPersonal('GMAIL');
      refreshCalls = 0;
      refreshFailure = null;
      const refreshed = await service.refresh({ userId: ownerId, integrationId });
      assert.equal(refreshed.status, 'ACTIVE');
      assert.ok(refreshed.lastRefreshedAt);
      assert.equal(refreshCalls, 1);

      const row = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
      assert.equal(decryptIntegrationToken(row.accessTokenCiphertext), 'access-1');
      assert.equal(decryptIntegrationToken(row.refreshTokenCiphertext as string), 'refresh-1');
    });

    test('enable/disable controls gate sync and can be toggled back', async () => {
      const integrationId = await connectPersonal('GMAIL');
      const disabled = await service.setEnabled({ userId: ownerId, integrationId, enabled: false });
      assert.equal(disabled.enabled, false);
      await assert.rejects(
        () => service.enqueueSync({ userId: ownerId, integrationId }),
        (error: unknown) => (error as { code?: string }).code === 'INTEGRATION_DISABLED',
      );
      const enabled = await service.setEnabled({ userId: ownerId, integrationId, enabled: true });
      assert.equal(enabled.enabled, true);
    });

    test('a queued sync refreshes an expiring token and completes durably', async () => {
      const integrationId = await connectPersonal('GMAIL', 60_000);
      refreshCalls = 0;
      refreshFailure = null;
      const job = await service.enqueueSync({ userId: ownerId, integrationId });
      assert.equal(job.status, 'PENDING');

      const result = await service.processSyncJobs({ now: new Date(), limit: 10 });
      assert.ok(result.claimed >= 1);
      assert.ok(result.succeeded >= 1);

      const stored = await prisma.integrationSyncJob.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(stored.status, 'SUCCEEDED');
      const integration = await prisma.integration.findUniqueOrThrow({
        where: { id: integrationId },
      });
      assert.ok(integration.lastSyncedAt);
      assert.equal(integration.status, 'ACTIVE');
      assert.equal(refreshCalls, 1);
    });

    test('a permanent provider failure marks the job and integration failed', async () => {
      const integrationId = await connectPersonal('DROPBOX', 60_000);
      refreshFailure = new Error('provider rejected the refresh');
      const job = await service.enqueueSync({ userId: ownerId, integrationId });
      await prisma.integrationSyncJob.update({ where: { id: job.id }, data: { maxRetries: 1 } });

      const result = await service.processSyncJobs({ now: new Date(), limit: 10 });
      assert.ok(result.failed >= 1);

      const stored = await prisma.integrationSyncJob.findUniqueOrThrow({ where: { id: job.id } });
      assert.equal(stored.status, 'FAILED');
      assert.match(stored.lastError ?? '', /provider rejected/);
      const integration = await prisma.integration.findUniqueOrThrow({
        where: { id: integrationId },
      });
      assert.equal(integration.status, 'ERROR');
      assert.match(integration.lastError ?? '', /provider rejected/);

      const retried = await service.retrySyncJob({ userId: ownerId, integrationId, jobId: job.id });
      assert.equal(retried.status, 'PENDING');
      assert.equal(retried.attempts, 0);
      refreshFailure = null;
    });

    test('disconnect revokes the provider token and records the local state', async () => {
      const integrationId = await connectPersonal('GMAIL');
      revokeCalls = 0;
      const result = await service.disconnect({ userId: ownerId, integrationId });
      assert.equal(result.providerRevoked, true);
      assert.equal(revokeCalls, 1);
      const row = await prisma.integration.findUniqueOrThrow({ where: { id: integrationId } });
      assert.equal(row.status, 'DISCONNECTED');
      assert.equal(row.enabled, false);
      assert.ok(row.revokedAt);
    });

    test('another user cannot manage a personal integration', async () => {
      const integrationId = await connectPersonal('GMAIL');
      await assert.rejects(
        () => service.refresh({ userId: otherId, integrationId }),
        (error: unknown) => (error as { code?: string }).code === 'INTEGRATION_NOT_FOUND',
      );
      await assert.rejects(
        () => service.listSyncJobs({ userId: otherId, integrationId }),
        (error: unknown) => (error as { code?: string }).code === 'INTEGRATION_NOT_FOUND',
      );
    });

    test('personal integrations remain isolated in list()', async () => {
      const integrationId = await connectPersonal('GMAIL');
      const ownerList = await service.list({ userId: ownerId, workspaceId });
      assert.ok(ownerList.some((item) => item.id === integrationId));
      const otherList = await service.list({ userId: otherId });
      assert.equal(
        otherList.some((item) => item.id === integrationId),
        false,
      );
    });
  },
);
