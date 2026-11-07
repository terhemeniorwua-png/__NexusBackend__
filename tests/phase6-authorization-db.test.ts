import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import {
  ProjectCapability,
  requireProjectAccess,
  requireTeamAccess,
  TeamCapability,
} from '../src/modules/authorization';
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
  const testRun = `${process.pid}-${Date.now()}`;
  const fixtureEmails = [
    `phase6-owner-${testRun}@test.example`,
    `phase6-pm-${testRun}@test.example`,
    `phase6-member-${testRun}@test.example`,
    `phase6-outsider-${testRun}@test.example`,
  ];
  const createdUserIds: string[] = [];

  // Workspace created in beforeAll
  let workspaceId: string;
  const createdWorkspaceIds: string[] = [];

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
    // We need the raw token, but only the hash is stored. Use the crypto helper
    // to generate a usable verify path by reading the token hash directly via
    // a one-time lookup flow instead — use login after manual activation.
    // Activate the account directly via the DB.
    await db.prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
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
    createdUserIds.push(id);

    return { id, email, accessToken, jar };
  }

  function authHeaders(user: TestUser): Record<string, string> {
    return {
      Authorization: `Bearer ${user.accessToken}`,
      'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
    };
  }

  async function createWorkspace(
    user: TestUser,
    name: string,
    type: 'COMPANY' | 'INSTITUTION' = 'COMPANY',
  ): Promise<string> {
    const res = await jsonRequest<{ id: string }>(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: authHeaders(user),
      body: JSON.stringify({ name, type }),
      jar: user.jar,
    });
    assert.equal(res.status, 201, `create workspace failed: ${JSON.stringify(res.body)}`);
    const id = (res.body.data as { id: string }).id;
    createdWorkspaceIds.push(id);
    return id;
  }

  async function addMember(
    actor: TestUser,
    wsId: string,
    email: string,
    role = 'MEMBER',
    organizationRole?: string,
  ): Promise<void> {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${wsId}/members`, {
      method: 'POST',
      headers: authHeaders(actor),
      body: JSON.stringify(organizationRole ? { email, organizationRole } : { email, role }),
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

    await connectRedis({ redisUrl: 'redis://localhost:6379/15' });

    const app = createApp({ config });
    server = await startServer(app);
    baseUrl = server.baseUrl;

    await db.prisma.$disconnect();

    // Register all four test users.
    owner = await register(baseUrl, 'P6 Owner', fixtureEmails[0]!, 'TestPass123!');
    pm = await register(baseUrl, 'P6 PM', fixtureEmails[1]!, 'TestPass123!');
    member = await register(baseUrl, 'P6 Member', fixtureEmails[2]!, 'TestPass123!');
    outsider = await register(baseUrl, 'P6 Outsider', fixtureEmails[3]!, 'TestPass123!');

    // Create the shared workspace as the owner.
    workspaceId = await createWorkspace(owner, 'Phase6 Test Workspace');

    // Add pm and member to the workspace.
    await addMember(owner, workspaceId, pm.email, 'PROJECT_MANAGER');
    await addMember(owner, workspaceId, member.email, 'MEMBER');
  });

  after(async () => {
    await server.close();
    await disconnectRedis();
    const db = await connectTestDatabase(dbUrl);
    await db.prisma.workspace.deleteMany({
      where: { id: { in: createdWorkspaceIds } },
    });
    await db.prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await db.prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  describe('Phase 6 authorization db tests', () => {
    test('organization roles remain scoped to each workspace and owners are plural', async () => {
      const companyId = await createWorkspace(owner, 'Phase6 Role Company', 'COMPANY');
      const institutionId = await createWorkspace(owner, 'Phase6 Role Institution', 'INSTITUTION');
      await addMember(owner, companyId, pm.email, 'MEMBER', 'COMPANY_ADMIN');
      await addMember(owner, institutionId, pm.email, 'MEMBER', 'INSTITUTION_STUDENT');

      const db = await connectTestDatabase(dbUrl);
      try {
        const project = await db.prisma.project.create({
          data: {
            workspaceId: companyId,
            name: 'Unassigned Company Project',
            key: `UCP${Date.now()}`,
            ownerId: owner.id,
            visibility: 'PRIVATE',
          },
        });
        const team = await db.prisma.team.create({
          data: { workspaceId: companyId, name: 'Unassigned Company Team' },
        });
        await assert.rejects(
          requireProjectAccess(db.prisma, {
            userId: pm.id,
            workspaceId: companyId,
            projectId: project.id,
            workspaceRole: 'PROJECT_MANAGER',
            capability: ProjectCapability.ViewProject,
          }),
        );
        await assert.rejects(
          requireTeamAccess(db.prisma, {
            userId: pm.id,
            workspaceId: companyId,
            teamId: team.id,
            workspaceRole: 'PROJECT_MANAGER',
            capability: 'team:view',
          }),
        );
      } finally {
        await db.prisma.$disconnect();
      }

      const companyUpdate = await jsonRequest(`${baseUrl}/api/v1/workspaces/${companyId}`, {
        method: 'PATCH',
        headers: authHeaders(pm),
        body: JSON.stringify({ name: 'Phase6 Role Company Renamed' }),
        jar: pm.jar,
      });
      assert.equal(companyUpdate.status, 200, JSON.stringify(companyUpdate.body));

      const institutionUpdate = await jsonRequest(`${baseUrl}/api/v1/workspaces/${institutionId}`, {
        method: 'PATCH',
        headers: authHeaders(pm),
        body: JSON.stringify({ name: 'Should Not Be Allowed' }),
        jar: pm.jar,
      });
      assert.equal(institutionUpdate.status, 403, JSON.stringify(institutionUpdate.body));

      const secondOwner = await register(
        baseUrl,
        'P6 Second Owner',
        `phase6-second-owner-${Date.now()}@test.example`,
        'TestPass123!',
      );
      await addMember(owner, companyId, secondOwner.email, 'MEMBER', 'COMPANY_OWNER');

      const unauthorizedPromotion = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${companyId}/members/${outsider.id}`,
        {
          method: 'PATCH',
          headers: authHeaders(pm),
          body: JSON.stringify({ organizationRole: 'COMPANY_OWNER' }),
          jar: pm.jar,
        },
      );
      // A non-member is hidden as not found to avoid disclosing membership.
      assert.equal(unauthorizedPromotion.status, 404, JSON.stringify(unauthorizedPromotion.body));

      const demoteAdditionalOwner = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${companyId}/members/${secondOwner.id}`,
        {
          method: 'PATCH',
          headers: authHeaders(owner),
          body: JSON.stringify({ organizationRole: 'COMPANY_MEMBER' }),
          jar: owner.jar,
        },
      );
      assert.equal(demoteAdditionalOwner.status, 200, JSON.stringify(demoteAdditionalOwner.body));

      const demoteLastOwner = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${companyId}/members/${owner.id}`,
        {
          method: 'PATCH',
          headers: authHeaders(owner),
          body: JSON.stringify({ organizationRole: 'COMPANY_MEMBER' }),
          jar: owner.jar,
        },
      );
      assert.equal(demoteLastOwner.status, 409, JSON.stringify(demoteLastOwner.body));
    });

    test('institution departments are private to assigned members and heads', async () => {
      const institutionId = await createWorkspace(
        owner,
        'Phase6 Department Institution',
        'INSTITUTION',
      );
      await addMember(owner, institutionId, pm.email, 'MEMBER', 'INSTITUTION_DEPARTMENT_HEAD');
      await addMember(owner, institutionId, member.email, 'MEMBER', 'INSTITUTION_STUDENT');

      const created = await jsonRequest<{ id: string }>(
        `${baseUrl}/api/v1/workspaces/${institutionId}/departments`,
        {
          method: 'POST',
          headers: authHeaders(owner),
          body: JSON.stringify({ name: 'Computer Science' }),
          jar: owner.jar,
        },
      );
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const departmentId = (created.body.data as { id: string }).id;

      const secondDepartment = await jsonRequest<{ id: string }>(
        `${baseUrl}/api/v1/workspaces/${institutionId}/departments`,
        {
          method: 'POST',
          headers: authHeaders(owner),
          body: JSON.stringify({ name: 'Physics' }),
          jar: owner.jar,
        },
      );
      assert.equal(secondDepartment.status, 201, JSON.stringify(secondDepartment.body));
      const secondDepartmentId = (secondDepartment.body.data as { id: string }).id;

      const assignedHead = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${institutionId}/departments/${departmentId}/members`,
        {
          method: 'POST',
          headers: authHeaders(owner),
          body: JSON.stringify({ targetUserId: pm.id, role: 'HEAD' }),
          jar: owner.jar,
        },
      );
      assert.equal(assignedHead.status, 200, JSON.stringify(assignedHead.body));

      const assignedStudent = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${institutionId}/departments/${departmentId}/members`,
        {
          method: 'POST',
          headers: authHeaders(pm),
          body: JSON.stringify({ targetUserId: member.id, role: 'MEMBER' }),
          jar: pm.jar,
        },
      );
      assert.equal(assignedStudent.status, 200, JSON.stringify(assignedStudent.body));

      const visible = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${institutionId}/departments`,
        { headers: authHeaders(pm), jar: pm.jar },
      );
      assert.equal(visible.status, 200);
      assert.equal((visible.body.data as Array<{ id: string }>).length, 1);

      const studentCreate = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${institutionId}/departments`,
        {
          method: 'POST',
          headers: authHeaders(member),
          body: JSON.stringify({ name: 'Unauthorized Department' }),
          jar: member.jar,
        },
      );
      assert.equal(studentCreate.status, 403);

      const db = await connectTestDatabase(dbUrl);
      try {
        const assignedProject = await db.prisma.project.create({
          data: {
            workspaceId: institutionId,
            departmentId,
            name: 'Department Project',
            key: `DP${Date.now()}`,
            ownerId: owner.id,
          },
        });
        const otherProject = await db.prisma.project.create({
          data: {
            workspaceId: institutionId,
            departmentId: secondDepartmentId,
            name: 'Other Department Project',
            key: `ODP${Date.now()}`,
            ownerId: owner.id,
          },
        });
        const assignedTeam = await db.prisma.team.create({
          data: { workspaceId: institutionId, departmentId, name: 'Department Team' },
        });
        const otherTeam = await db.prisma.team.create({
          data: {
            workspaceId: institutionId,
            departmentId: secondDepartmentId,
            name: 'Other Team',
          },
        });

        await requireProjectAccess(db.prisma, {
          userId: pm.id,
          workspaceId: institutionId,
          projectId: assignedProject.id,
          workspaceRole: 'COLLABORATOR',
          capability: ProjectCapability.ManageTask,
        });
        await assert.rejects(
          requireProjectAccess(db.prisma, {
            userId: pm.id,
            workspaceId: institutionId,
            projectId: otherProject.id,
            workspaceRole: 'COLLABORATOR',
            capability: ProjectCapability.ViewProject,
          }),
          (error: unknown) => (error as { code?: string }).code === 'PROJECT_NOT_FOUND',
        );
        await requireTeamAccess(db.prisma, {
          userId: pm.id,
          workspaceId: institutionId,
          teamId: assignedTeam.id,
          workspaceRole: 'COLLABORATOR',
          capability: TeamCapability.UpdateTeam,
        });
        await assert.rejects(
          requireTeamAccess(db.prisma, {
            userId: pm.id,
            workspaceId: institutionId,
            teamId: otherTeam.id,
            workspaceRole: 'COLLABORATOR',
            capability: TeamCapability.ViewTeam,
          }),
          (error: unknown) => (error as { code?: string }).code === 'TEAM_NOT_FOUND',
        );
      } finally {
        await db.prisma.$disconnect();
      }
    });

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
        assert.equal((res.body.error as { code: string }).code, 'ORGANIZATION_OWNER_REQUIRED');
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
        assert.equal(res.status, 409);
        const code = (res.body.error as { code: string }).code;
        assert.equal(code, 'LAST_ORGANIZATION_OWNER');
      });
    });

    describe('ownership transfer', () => {
      // We create a second workspace for the transfer test so we do not break
      // the shared workspace used by other tests.
      let transferWsId: string;
      let secondMember: TestUser;
      let transferId: string;

      before(async () => {
        secondMember = await register(
          baseUrl,
          'P6 Transfer Target',
          `phase6-transfer-member-${testRun}@test.example`,
          'TestPass123!',
        );
        transferWsId = await createWorkspace(owner, 'Phase6 Transfer Workspace');
        await addMember(owner, transferWsId, secondMember.email, 'MEMBER');
      });

      after(async () => {
        const db = await connectTestDatabase(dbUrl);
        await db.prisma.workspace.deleteMany({ where: { id: transferWsId } });
        await db.prisma.user.deleteMany({ where: { id: secondMember.id } });
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
        // The documented two-step flow requires the recipient to be an active
        // workspace member. A non-member returns 409, not 404, because the
        // membership lookup fails with "not active" rather than "not found."
        assert.equal(res.status, 409);
        assert.equal((res.body.error as { code: string }).code, 'NEW_OWNER_NOT_ACTIVE');
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

      test('owner can initiate ownership transfer to an existing member', async () => {
        // The documented API contract implements a two-step flow: the owner
        // initiates a transfer, and the recipient must accept it. See
        // docs/API.md — PATCH returns { transferId, status: 'PENDING' }.
        const res = await jsonRequest<{ transferId: string; status: string }>(
          `${baseUrl}/api/v1/workspaces/${transferWsId}/owner/${secondMember.id}`,
          {
            method: 'PATCH',
            headers: authHeaders(owner),
            body: JSON.stringify({ newOwnerRole: 'PROJECT_MANAGER' }),
            jar: owner.jar,
          },
        );
        assert.equal(res.status, 200, `transfer initiation failed: ${JSON.stringify(res.body)}`);
        const data = res.body.data as { transferId: string; status: string };
        assert.equal(data.status, 'PENDING', 'transfer status should be PENDING');
        assert.ok(data.transferId, 'a transferId should be returned');
        transferId = data.transferId;
      });

      test('the recipient can list the incoming ownership transfer', async () => {
        const res = await jsonRequest<{ items: Array<{ id: string; workspaceId: string; initiatedBy: { id: string; name: string } }> }>(
          `${baseUrl}/api/v1/workspaces/owner-transfers/incoming?limit=50&offset=0`,
          { headers: authHeaders(secondMember), jar: secondMember.jar },
        );
        assert.equal(res.status, 200);
        const items = (res.body.data as { items: Array<{ id: string; workspaceId: string; initiatedBy: { id: string; name: string } }> }).items;
        const found = items.find((item) => item.id === transferId);
        assert.ok(found, 'the pending transfer should appear in the recipient inbox');
        // The response must include the sender identity so the frontend can
        // show who is offering the transfer.
        assert.ok(found.initiatedBy, 'transfer should include initiatedBy sender identity');
        assert.equal(found.initiatedBy.id, owner.id, 'initiatedBy.id should be the owner');
        assert.equal(found.initiatedBy.name, 'P6 Owner', 'initiatedBy.name should be the owner display name');
      });

      test('the recipient can accept the ownership transfer', async () => {
        const res = await jsonRequest<{ workspaceId: string; billingAcceptanceRequired: boolean }>(
          `${baseUrl}/api/v1/workspaces/${transferWsId}/owner-transfers/${transferId}/accept`,
          {
            method: 'POST',
            headers: authHeaders(secondMember),
            jar: secondMember.jar,
          },
        );
        assert.equal(res.status, 200, `accept failed: ${JSON.stringify(res.body)}`);
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
        assert.equal(membership.organizationRole, 'COMPANY_OWNER');
      });

      test('after transfer the previous organization owner has the requested role', async () => {
        const db = await connectTestDatabase(dbUrl);
        const membership = await db.prisma.workspaceMembership.findUniqueOrThrow({
          where: {
            workspaceId_userId: { workspaceId: transferWsId, userId: owner.id },
          },
        });
        await db.prisma.$disconnect();
        // The previous owner requested PROJECT_MANAGER as the post-transfer role.
        assert.equal(membership.role, 'PROJECT_MANAGER');
        assert.equal(membership.organizationRole, null);
      });

      test('transfer acceptance is recorded in the audit log', async () => {
        const db = await connectTestDatabase(dbUrl);
        const entry = await db.prisma.auditLog.findFirst({
          where: {
            workspaceId: transferWsId,
            action: 'workspace.ownership_transfer_accepted',
          },
          orderBy: { createdAt: 'desc' },
        });
        await db.prisma.$disconnect();
        assert.ok(entry, 'audit entry should exist for the transfer acceptance');
        const meta = entry.metadata as { newOwnerId: string; previousOwnerId: string };
        assert.equal(meta.newOwnerId, secondMember.id);
        assert.equal(meta.previousOwnerId, owner.id);
      });
    });

    describe('security regression: information hiding', () => {
      // These tests verify that a non-member or unauthorized user never learns
      // that a private project, archived workspace, or pending ownership
      // transfer exists. The responses must use 404 or 403 with generic codes
      // that do not reveal the resource type or its state.

      test('non-member cannot discover a private project via the API', async () => {
        const db = await connectTestDatabase(dbUrl);
        let privateProjectId: string;
        try {
          const privateProject = await db.prisma.project.create({
            data: {
              workspaceId,
              name: 'Secret Project',
              key: `SEC${Date.now()}`,
              ownerId: owner.id,
              visibility: 'PRIVATE',
            },
          });
          privateProjectId = privateProject.id;

          // The outsider is not a member of the workspace, so the workspace
          // access check should reject before the project is even loaded.
          const res = await jsonRequest(
            `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${privateProjectId}`,
            { headers: authHeaders(outsider), jar: outsider.jar },
          );
          assert.equal(res.status, 403, JSON.stringify(res.body));
          assert.equal(
            (res.body.error as { code: string }).code,
            'WORKSPACE_ACCESS_DENIED',
            'should not reveal project existence to a non-member',
          );
        } finally {
          await db.prisma.project.deleteMany({ where: { id: privateProjectId! } });
          await db.prisma.$disconnect();
        }
      });

      test('workspace member without project access receives PROJECT_NOT_FOUND for a private project', async () => {
        const db = await connectTestDatabase(dbUrl);
        let privateProjectId: string;
        try {
          const privateProject = await db.prisma.project.create({
            data: {
              workspaceId,
              name: 'Hidden Project',
              key: `HDN${Date.now()}`,
              ownerId: owner.id,
              visibility: 'PRIVATE',
            },
          });
          privateProjectId = privateProject.id;

          // The member belongs to the workspace but has no project membership.
          // The project policy must return PROJECT_NOT_FOUND, not
          // PROJECT_ACCESS_DENIED, to avoid revealing the project exists.
          await assert.rejects(
            requireProjectAccess(db.prisma, {
              userId: member.id,
              workspaceId,
              projectId: privateProjectId,
              workspaceRole: 'MEMBER',
              capability: ProjectCapability.ViewProject,
            }),
            (error: unknown) => (error as { code?: string }).code === 'PROJECT_NOT_FOUND',
          );
        } finally {
          await db.prisma.project.deleteMany({ where: { id: privateProjectId! } });
          await db.prisma.$disconnect();
        }
      });

      test('outsider cannot list incoming ownership transfers for another user', async () => {
        // The transfer endpoint is scoped to the authenticated user, so an
        // outsider querying their own inbox should never see transfers
        // intended for someone else.
        const res = await jsonRequest(
          `${baseUrl}/api/v1/workspaces/owner-transfers/incoming?limit=50&offset=0`,
          { headers: authHeaders(outsider), jar: outsider.jar },
        );
        assert.equal(res.status, 200);
        const data = res.body.data as { items: unknown[] };
        assert.equal(data.items.length, 0, 'outsider should have no incoming transfers');
      });

      test('pending transfer is not visible to a non-member of the workspace', async () => {
        const db = await connectTestDatabase(dbUrl);
        let secWsId: string;
        let secMemberId: string;
        try {
          // Create a separate workspace with a pending transfer.
          const secMember = await register(
            baseUrl,
            'P6 Sec Member',
            `phase6-sec-member-${Date.now()}@test.example`,
            'TestPass123!',
          );
          secMemberId = secMember.id;
          secWsId = await createWorkspace(owner, 'Phase6 Security Workspace');
          await addMember(owner, secWsId, secMember.email, 'MEMBER');

          const initiate = await jsonRequest<{ transferId: string; status: string }>(
            `${baseUrl}/api/v1/workspaces/${secWsId}/owner/${secMember.id}`,
            {
              method: 'PATCH',
              headers: authHeaders(owner),
              body: JSON.stringify({ newOwnerRole: 'MEMBER' }),
              jar: owner.jar,
            },
          );
          assert.equal(initiate.status, 200);

          // The outsider is not a member of the workspace and should not see
          // the transfer in their inbox.
          const outsiderInbox = await jsonRequest(
            `${baseUrl}/api/v1/workspaces/owner-transfers/incoming?limit=50&offset=0`,
            { headers: authHeaders(outsider), jar: outsider.jar },
          );
          assert.equal(outsiderInbox.status, 200);
          const outsiderData = outsiderInbox.body.data as { items: unknown[] };
          assert.equal(outsiderData.items.length, 0);

          // The member of the *original* workspace is also not a member of the
          // security workspace and should not see the transfer.
          const memberInbox = await jsonRequest(
            `${baseUrl}/api/v1/workspaces/owner-transfers/incoming?limit=50&offset=0`,
            { headers: authHeaders(member), jar: member.jar },
          );
          assert.equal(memberInbox.status, 200);
          const memberData = memberInbox.body.data as { items: unknown[] };
          assert.equal(memberData.items.length, 0);

          // Clean up: cancel the pending transfer by removing the member.
          await jsonRequest(`${baseUrl}/api/v1/workspaces/${secWsId}/members/${secMember.id}`, {
            method: 'DELETE',
            headers: authHeaders(owner),
            jar: owner.jar,
          });
        } finally {
          const db2 = await connectTestDatabase(dbUrl);
          await db2.prisma.workspace.deleteMany({ where: { id: secWsId! } }).catch(() => undefined);
          await db2.prisma.user.deleteMany({ where: { id: secMemberId! } }).catch(() => undefined);
          await db2.prisma.$disconnect();
          await db.prisma.$disconnect();
        }
      });

      test('archived workspace is not accessible to a non-member', async () => {
        const db = await connectTestDatabase(dbUrl);
        let archivedWsId: string;
        try {
          archivedWsId = await createWorkspace(owner, 'Phase6 Archive Security WS');
          // Archive the workspace.
          const archiveRes = await jsonRequest(
            `${baseUrl}/api/v1/workspaces/${archivedWsId}/archive`,
            {
              method: 'POST',
              headers: authHeaders(owner),
              jar: owner.jar,
            },
          );
          assert.equal(archiveRes.status, 200, `archive failed: ${JSON.stringify(archiveRes.body)}`);

          // An outsider should get 404 (WORKSPACE_NOT_FOUND) not 403, because
          // the workspace access check hides archived workspaces from
          // non-members.
          const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${archivedWsId}`, {
            headers: authHeaders(outsider),
            jar: outsider.jar,
          });
          assert.equal(res.status, 404, JSON.stringify(res.body));
          assert.equal(
            (res.body.error as { code: string }).code,
            'WORKSPACE_NOT_FOUND',
            'archived workspace should be hidden from non-members',
          );
        } finally {
          await db.prisma.workspace.deleteMany({ where: { id: archivedWsId! } }).catch(() => undefined);
          await db.prisma.$disconnect();
        }
      });
    });
  });
}
