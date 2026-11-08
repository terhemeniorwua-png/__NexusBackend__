import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { parseEnv, type AppConfig } from '../src/config/env';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { getPrismaClient } from '../src/db/prisma';
import { setEmailSender } from '../src/services/email';
import type { EmailMessage } from '../src/services/email';
import { hashPassword } from '../src/services/password';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import {
  jsonRequest,
  startServer,
  type JsonResponse,
  type RunningServer,
} from './helpers/test-server';

const PASSWORD = 'Correct-Horse-9';
let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE5_DB_TESTS=true and a test DATABASE_URL to run this suite';

try {
  databaseUrl = resolveTestDatabaseUrl('RUN_PHASE5_DB_TESTS');
  if (databaseUrl) skipReason = '';
} catch (error) {
  if (process.env.RUN_PHASE5_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database could not be resolved';
}

describe(
  'Phase 5.1 member removal reassignment and email-domain isolation',
  { skip: skipReason || false },
  () => {
    let prisma: ReturnType<typeof getPrismaClient>;
    let server: RunningServer;
    let baseUrl: string;
    const userIds: string[] = [];
    const workspaceIds: string[] = [];

    before(async () => {
      const database = await connectTestDatabase(databaseUrl as string);
      prisma = getPrismaClient(database.url);
      const config: AppConfig = parseEnv({
        NODE_ENV: 'test',
        PORT: '4000',
        DATABASE_URL: databaseUrl as string,
        REDIS_URL: 'redis://localhost:6379/15',
        FRONTEND_URL: 'http://localhost:3000',
        CORS_ORIGINS: 'http://localhost:3000',
        LOG_LEVEL: 'info',
        JWT_ACCESS_SECRET: 'phase5-remediation-test-access-secret',
        BCRYPT_SALT_ROUNDS: '4',
        RATE_LIMIT_MAX: '100000',
        RATE_LIMIT_NAMESPACE: `nexus-phase5-remediation-${process.pid}-${Date.now()}`,
        AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
        AUTH_LOGIN_RATE_LIMIT_MAX: '1000',
        AUTH_VERIFICATION_RATE_LIMIT_MAX: '1000',
        AUTH_PASSWORD_RATE_LIMIT_MAX: '1000',
        EMAIL_PROVIDER: 'console',
        EMAIL_FROM_ADDRESS: 'no-reply@example.com',
        EMAIL_FROM_NAME: 'Nexus',
        WORKSPACE_JOIN_REQUEST_TTL_SECONDS: '604800',
      });

      await connectRedis(config);

      setEmailSender({
        async send(_message: EmailMessage) {
          return { accepted: true, providerMessageId: 'phase5-remediation-test' };
        },
      });
      server = await startServer(createApp({ config }));
      baseUrl = server.baseUrl;
    });

    after(async () => {
      await server?.close();
      await disconnectRedis();
      await prisma?.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma?.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await prisma?.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma?.$disconnect();
    });

    async function createUser(name: string, email: string): Promise<string> {
      const passwordHash = await hashPassword(PASSWORD, 4);
      const user = await prisma.user.create({
        data: {
          email,
          name,
          passwordHash,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
          profile: { create: {} },
        },
        select: { id: true },
      });
      userIds.push(user.id);
      return user.id;
    }

    async function api<T = unknown>(
      path: string,
      options: { method?: string; token?: string; body?: unknown } = {},
    ): Promise<{ status: number; body: JsonResponse<T>['body'] }> {
      const response = await jsonRequest<T>(`${baseUrl}/api/v1${path}`, {
        method: options.method ?? 'GET',
        ...(options.token ? { headers: { authorization: `Bearer ${options.token}` } } : {}),
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      return { status: response.status, body: response.body };
    }

    async function login(email: string): Promise<string> {
      const response = await api<{ accessToken: string }>('/auth/login', {
        method: 'POST',
        body: { email, password: PASSWORD },
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return (response.body.data as { accessToken: string }).accessToken;
    }

    test('transfers open tasks transactionally and never grants access by domain', async () => {
      const suffix = `${process.pid}.${Date.now()}`;
      const ownerEmail = `phase5.owner.${suffix}@example.com`;
      const formerEmail = `phase5.former.${suffix}@example.com`;
      const replacementEmail = `phase5.replacement.${suffix}@example.com`;
      const outsiderEmail = `phase5.outsider.${suffix}@example.com`;
      const ownerId = await createUser('Remediation Owner', ownerEmail);
      const formerId = await createUser('Former Assignee', formerEmail);
      const replacementId = await createUser('Replacement Assignee', replacementEmail);
      const outsiderId = await createUser('Same Domain Outsider', outsiderEmail);
      const ownerToken = await login(ownerEmail);
      const outsiderToken = await login(outsiderEmail);

      const created = await api<{ id: string }>('/workspaces', {
        method: 'POST',
        token: ownerToken,
        body: { name: `Remediation Workspace ${suffix}` },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const workspaceId = (created.body.data as { id: string }).id;
      workspaceIds.push(workspaceId);

      for (const email of [formerEmail, replacementEmail]) {
        const added = await api(`/workspaces/${workspaceId}/members`, {
          method: 'POST',
          token: ownerToken,
          body: { email, role: 'MEMBER' },
        });
        assert.equal(added.status, 201, JSON.stringify(added.body));
      }

      const project = await prisma.project.create({
        data: {
          workspaceId,
          name: `Reassignment ${suffix}`,
          key: `R${Date.now()}`,
          ownerId,
          status: 'ACTIVE',
        },
      });
      await prisma.projectMembership.createMany({
        data: [
          { projectId: project.id, userId: formerId, role: 'MEMBER' },
          { projectId: project.id, userId: replacementId, role: 'MEMBER' },
        ],
      });
      const task = await prisma.task.create({
        data: {
          projectId: project.id,
          key: `T${Date.now()}`,
          title: 'Transfer on member removal',
          creatorId: ownerId,
        },
      });
      await prisma.taskAssignee.create({
        data: { taskId: task.id, userId: formerId, assignedBy: ownerId },
      });

      const rejectedRemoval = await api(`/workspaces/${workspaceId}/members/${formerId}`, {
        method: 'DELETE',
        token: ownerToken,
      });
      assert.equal(rejectedRemoval.status, 409);
      assert.equal(rejectedRemoval.body.error?.code, 'TASK_REASSIGNMENT_REQUIRED');
      assert.equal(
        await prisma.workspaceMembership.count({ where: { workspaceId, userId: formerId } }),
        1,
      );

      const removed = await api(`/workspaces/${workspaceId}/members/${formerId}`, {
        method: 'DELETE',
        token: ownerToken,
        body: { reassignTasksToUserId: replacementId },
      });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.equal(
        await prisma.taskAssignee.count({ where: { taskId: task.id, userId: replacementId } }),
        1,
      );
      assert.equal(
        await prisma.workspaceMembership.count({ where: { workspaceId, userId: formerId } }),
        0,
      );
      assert.equal(
        await prisma.auditLog.count({
          where: { workspaceId, action: 'task.reassigned', targetId: task.id },
        }),
        1,
      );

      assert.equal(ownerEmail.split('@')[1], outsiderEmail.split('@')[1]);
      assert.equal(
        await prisma.workspaceMembership.count({ where: { workspaceId, userId: outsiderId } }),
        0,
      );
      assert.equal((await api(`/workspaces/${workspaceId}`, { token: outsiderToken })).status, 403);
    });
  },
);
