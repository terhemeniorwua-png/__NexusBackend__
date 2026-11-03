import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

/**
 * Phase 6 database integration tests — authorization enforcement.
 *
 * These tests drive the real HTTP application against a test PostgreSQL
 * database. They verify that:
 *
 * - Unauthorized users cannot access or modify workspace resources
 * - Role escalation is denied (e.g. MEMBER cannot update workspace)
 * - Cross-workspace access is denied
 * - Ownership transfer works end-to-end with audit log
 * - The owner cannot be removed
 * - The owner cannot leave without transferring ownership first
 * - The post-transfer roles are correct for both parties
 *
 * Run with:
 *   RUN_PHASE6_DB_TESTS=true DATABASE_URL=postgresql://nexus:nexus@localhost:5432/nexus_test npm test
 */

const DB_FLAG = 'RUN_PHASE6_DB_TESTS';

const dbUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!dbUrl) {
  // Skip gracefully when the flag is not set.
  describe('Phase 6 authorization db tests', () => {
    test('skipped — set RUN_PHASE6_DB_TESTS=true to run', () => {});
  });
} else {
  runTests(dbUrl);
}

function runTests(dbUrl: string): void {
  // ---------------------------------------------------------------------------
  // Test fixtures
  // ---------------------------------------------------------------------------

  interface TestUser {
    id: string;
    email: string;
    accessToken: string;
    jar: CookieJar;
  }

  let server: RunningServer;
  let baseUrl: string;

  // Users created in beforeAll
  let owner: TestUser;
  let pm: TestUser;
  let member: TestUser;
  let outsider: TestUser;

  // Workspace created in beforeAll
  let workspaceId: string;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function register(
    base: string,
    name: string,
    email: string,
    password: string,
  ): Promise<TestUser> {
    const jar = new CookieJar();

    const reg = await jsonRequest(`${base}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
      jar,
    });
    assert.equal(reg.status, 201, `register failed for ${email}: ${JSON.stringify(reg.body)}`);

    // For the test database we verify with a direct DB token retrieval.
    const db = await connectTestDatabase(dbUrl);
    const user = await db.prisma.user.findUniqueOrThrow({ where: { email } });
    const token = await db.prisma.authToken.findFirstOrThrow({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    // We need the raw token, but only the hash is stored. Use the crypto helper
    // to generate a usable verify path by reading the token hash directly via
    // a one-time lookup flow instead — use login after manual activation.
    // Activate the account directly via the DB.
    await db.prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    await db.prisma.authToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    });
    await db.prisma.$disconnect();

    const login = await jsonRequest<{ accessToken: string }>(`${base}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      jar,
    });
    assert.equal(login.status, 200, `login failed for ${email}`);
    const accessToken = (login.body.data as { accessToken: string }).accessToken;

    const meRes = await jsonRequest<{ user: { id: string } }>(`${base}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      jar,
    });
    const id = (meRes.body.data as { user: { id: string } }).user.id;

    return { id, email, accessToken, jar };
  }

  function authHeaders(user: TestUser): Record<string, string> {
    return {
      Authorization: `Bearer ${user.accessToken}`,
      'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
    };
  }

  async function createWorkspace(user: TestUser, name: string): Promise<string> {
    const res = await jsonRequest<{ id: string }>(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: authHeaders(user),
      body: JSON.stringify({ name }),
      jar: user.jar,
    });
    assert.equal(res.status, 201, `create workspace failed: ${JSON.stringify(res.body)}`);
    return (res.body.data as { id: string }).id;
  }

  async function addMember(
    actor: TestUser,
    wsId: string,
    email: string,
    role = 'MEMBER',
  ): Promise<void> {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${wsId}/members`, {
      method: 'POST',
      headers: authHeaders(actor),
      body: JSON.stringify({ email, role }),
      jar: actor.jar,
    });
    assert.equal(res.status, 201, `addMember failed: ${JSON.stringify(res.body)}`);
  }

  // ---------------------------------------------------------------------------
  // Setup / teardown
  // ---------------------------------------------------------------------------

  before(async () => {
    const db = await connectTestDatabase(dbUrl);
    const config = (await import('../src/config/env')).loadEnv();
    const app = createApp({ config });
    server = await startServer(app);
    baseUrl = server.baseUrl;

    // Clean up any leftover test data from previous runs.
    await db.prisma.user.deleteMany({
      where: {
        email: {
          in: [
            'phase6-owner@test.example',
            'phase6-pm@test.example',
            'phase6-member@test.example',
            'phase6-outsider@test.example',
          ],
        },
      },
    });
    await db.prisma.$disconnect();

    // Register all four test users.
    owner = await register(baseUrl, 'P6 Owner', 'phase6-owner@test.example', 'TestPass123!');
    pm = await register(baseUrl, 'P6 PM', 'phase6-pm@test.example', 'TestPass123!');
    member = await register(baseUrl, 'P6 Member', 'phase6-member@test.example', 'TestPass123!');
    outsider = await register(
      baseUrl,
      'P6 Outsider',
      'phase6-outsider@test.example',
      'TestPass123!',
    );

    // Create the shared workspace as the owner.
    workspaceId = await createWorkspace(owner, 'Phase6 Test Workspace');

    // Add pm and member to the workspace.
    await addMember(owner, workspaceId, pm.email, 'PROJECT_MANAGER');
    await addMember(owner, workspaceId, member.email, 'MEMBER');
  });

  after(async () => {
    await server.close();
    const db = await connectTestDatabase(dbUrl);
    await db.prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await db.prisma.user.deleteMany({
      where: {
        email: {
          in: [
            'phase6-owner@test.example',
            'phase6-pm@test.example',
            'phase6-member@test.example',
            'phase6-outsider@test.example',
          ],
        },
      },
    });
    await db.prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  describe('Phase 6 authorization db tests', () => {
    describe('cross-workspace access denial', () => {
      test('outsider cannot read a workspace they do not belong to', async () => {
        const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}`, {
          headers: authHeaders(outsider),
        });
        assert.equal(res.status, 403, 'outsider should be forbidden');
        assert.equal((res.body.error as { code: string }).code, 'WORKSPACE_ACCESS_DENIED');
      });

      test('outsider cannot list members of a workspace they do not belong to', async () => {
        const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/members`, {
          headers: authHeaders(outsider),
        });
        assert.equal(res.status, 403);
      });

      test('completely unknown workspace id returns 404', async () => {
        const fakeId = '00000000-0000-0000-0000-000000000000';
        const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${fakeId}`, {
          headers: authHeaders(outsider),
        });
        assert.equal(res.status, 404, 'unknown workspace should be 404');
        assert.equal((res.body.error as { code: string }).code, 'WORKSPACE_NOT_FOUND');
      });
    });

    describe('role-based access enforcement', () => {
      test('MEMBER cannot update workspace settings', async () => {
        const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}`, {
          method: 'PATCH',
          headers: authHeaders(member),
          body: JSON.stringify({ name: 'Hacked Name' }),
          jar: member.jar,
        });
        assert.equal(res.status, 403);
        assert.equal((res.body.error as { code: string }).code, 'INSUFFICIENT_ROLE');
      });

      test('MEMBER cannot archive a workspace', async () => {
        const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/archive`, {
          method: 'POST',
          headers: authHeaders(member),
          jar: member.jar,
        });
        assert.equal(res.status, 403);
      });

      test('PROJECT_MANAGER can update workspace settings', async () => {
        const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}`, {
          method: 'PATCH',
          headers: authHeaders(pm),
          body: JSON.stringify({ name: 'Phase6 Test Workspace' }), // restore the name
          jar: pm.jar,
        });
        assert.equal(res.status, 200, `PM update failed: ${JSON.stringify(res.body)}`);
      });

      test('PROJECT_MANAGER cannot archive a workspace', async () => {
        const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/archive`, {
          method: 'POST',
          headers: authHeaders(pm),
          jar: pm.jar,
        });
        assert.equal(res.status, 403);
      });

      test('MEMBER cannot add another member to the workspace', async () => {
        const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/members`, {
          method: 'POST',
          headers: authHeaders(member),
          body: JSON.stringify({ email: outsider.email, role: 'MEMBER' }),
          jar: member.jar,
        });
        assert.equal(res.status, 403);
      });

      test('MEMBER cannot view invitations', async () => {
        const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/invitations`, {
          headers: authHeaders(member),
        });
        assert.equal(res.status, 403);
      });
    });

    describe('owner-removal protection', () => {
      test('the owner cannot be removed by a project manager', async () => {
        const res = await jsonRequest(
          `${baseUrl}/api/v1/workspaces/${workspaceId}/members/${owner.id}`,
          {
            method: 'DELETE',
            headers: authHeaders(pm),
            jar: pm.jar,
          },
        );
        assert.equal(res.status, 403);
        assert.equal((res.body.error as { code: string }).code, 'OWNER_CANNOT_BE_MODIFIED');
      });

      test('the owner cannot remove themselves (self-removal block)', async () => {
        const res = await jsonRequest(
          `${baseUrl}/api/v1/workspaces/${workspaceId}/members/${owner.id}`,
          {
            method: 'DELETE',
            headers: authHeaders(owner),
            jar: owner.jar,
          },
        );
        assert.equal(res.status, 403);
        // OWNER_CANNOT_BE_MODIFIED fires first because assertMayManageMember
        // checks targetIsOwner before assertOwnershipSafe checks self-removal.
        const code = (res.body.error as { code: string }).code;
        assert.ok(
          code === 'OWNER_CANNOT_BE_MODIFIED' || code === 'OWNER_CANNOT_LEAVE',
          `Unexpected error code: ${code}`,
        );
      });
    });

    describe('ownership transfer', () => {
      // We create a second workspace for the transfer test so we do not break
      // the shared workspace used by other tests.
      let transferWsId: string;
      let secondMember: TestUser;

      before(async () => {
        // Register a temporary user for the second workspace.
        const db = await connectTestDatabase(dbUrl);
        await db.prisma.user.deleteMany({
          where: { email: 'phase6-transfer-member@test.example' },
        });
        await db.prisma.$disconnect();

        secondMember = await register(
          baseUrl,
          'P6 Transfer Target',
          'phase6-transfer-member@test.example',
          'TestPass123!',
        );
        transferWsId = await createWorkspace(owner, 'Phase6 Transfer Workspace');
        await addMember(owner, transferWsId, secondMember.email, 'MEMBER');
      });

      after(async () => {
        const db = await connectTestDatabase(dbUrl);
        await db.prisma.workspace.deleteMany({ where: { id: transferWsId } });
        await db.prisma.user.deleteMany({
          where: { email: 'phase6-transfer-member@test.example' },
        });
        await db.prisma.$disconnect();
      });

      test('non-owner cannot transfer ownership', async () => {
        const res = await jsonRequest(
          `${baseUrl}/api/v1/workspaces/${transferWsId}/owner/${secondMember.id}`,
          {
            method: 'PATCH',
            headers: authHeaders(member),
            body: JSON.stringify({}),
            jar: member.jar,
          },
        );
        assert.equal(res.status, 403);
      });

      test('owner cannot transfer ownership to a non-member', async () => {
        const res = await jsonRequest(
          `${baseUrl}/api/v1/workspaces/${transferWsId}/owner/${outsider.id}`,
          {
            method: 'PATCH',
            headers: authHeaders(owner),
            body: JSON.stringify({}),
            jar: owner.jar,
          },
        );
        assert.equal(res.status, 404);
        assert.equal((res.body.error as { code: string }).code, 'MEMBER_NOT_FOUND');
      });

      test('owner cannot transfer ownership to themselves', async () => {
        const res = await jsonRequest(
          `${baseUrl}/api/v1/workspaces/${transferWsId}/owner/${owner.id}`,
          {
            method: 'PATCH',
            headers: authHeaders(owner),
            body: JSON.stringify({}),
            jar: owner.jar,
          },
        );
        assert.equal(res.status, 400);
        assert.equal((res.body.error as { code: string }).code, 'TRANSFER_TO_SELF');
      });

      test('owner can transfer ownership to an existing member', async () => {
        const res = await jsonRequest<{ ownerId: string }>(
          `${baseUrl}/api/v1/workspaces/${transferWsId}/owner/${secondMember.id}`,
          {
            method: 'PATCH',
            headers: authHeaders(owner),
            body: JSON.stringify({ newOwnerRole: 'PROJECT_MANAGER' }),
            jar: owner.jar,
          },
        );
        assert.equal(res.status, 200, `transfer failed: ${JSON.stringify(res.body)}`);
        const data = res.body.data as { ownerId: string };
        assert.equal(data.ownerId, secondMember.id, 'ownerId should be the new owner');
      });

      test('after transfer the new owner has OWNER membership role', async () => {
        const db = await connectTestDatabase(dbUrl);
        const membership = await db.prisma.workspaceMembership.findUniqueOrThrow({
          where: {
            workspaceId_userId: { workspaceId: transferWsId, userId: secondMember.id },
          },
        });
        await db.prisma.$disconnect();
        assert.equal(membership.role, 'OWNER');
      });

      test('after transfer the previous owner has the requested role', async () => {
        const db = await connectTestDatabase(dbUrl);
        const membership = await db.prisma.workspaceMembership.findUniqueOrThrow({
          where: {
            workspaceId_userId: { workspaceId: transferWsId, userId: owner.id },
          },
        });
        await db.prisma.$disconnect();
        assert.equal(membership.role, 'PROJECT_MANAGER');
      });

      test('transfer is recorded in the audit log', async () => {
        const db = await connectTestDatabase(dbUrl);
        const entry = await db.prisma.auditLog.findFirst({
          where: {
            workspaceId: transferWsId,
            action: 'workspace.ownership_transferred',
          },
          orderBy: { createdAt: 'desc' },
        });
        await db.prisma.$disconnect();
        assert.ok(entry, 'audit entry should exist for the transfer');
        const meta = entry.metadata as { newOwnerId: string; previousOwnerId: string };
        assert.equal(meta.newOwnerId, secondMember.id);
        assert.equal(meta.previousOwnerId, owner.id);
      });
    });
  });
}
