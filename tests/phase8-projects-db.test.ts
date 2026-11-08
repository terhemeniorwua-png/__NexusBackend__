import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE8_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Phase 8 projects PostgreSQL tests', () =>
    test('skipped — set RUN_PHASE8_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

interface TestUser {
  id: string;
  email: string;
  token: string;
  jar: CookieJar;
}

function runTests(rawDbUrl: string): void {
  let server: RunningServer;
  let baseUrl: string;
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let organizationAdmin: TestUser;
  let organizationOwner: TestUser;
  let projectManager: TestUser;
  let workspaceId: string;
  let otherWorkspaceId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });
  const workspaceProjects = (id = workspaceId) => `${baseUrl}/api/v1/workspaces/${id}/projects`;
  const projectUrl = (id: string, wsId = workspaceId) => `${workspaceProjects(wsId)}/${id}`;
  const transferUrl = (id: string) => `${projectUrl(id)}/transfer-ownership`;

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `p8-${suffix}-${tag}@test.example`;
    const password = 'TestPass123!';
    const jar = new CookieJar();
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
      jar,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const db = await connectTestDatabase(rawDbUrl);
    const user = await db.prisma.user.findUniqueOrThrow({ where: { email } });
    await db.prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    await db.prisma.authToken.updateMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', usedAt: null },
      data: { usedAt: new Date() },
    });
    await db.prisma.$disconnect();
    const login = await jsonRequest<{ accessToken: string }>(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      jar,
    });
    assert.equal(login.status, 200);
    const token = (login.body.data as { accessToken: string }).accessToken;
    const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      jar,
    });
    const id = (me.body.data as { user: { id: string } }).user.id;
    userIds.push(id);
    return { id, email, token, jar };
  }

  async function addWorkspaceMember(
    user: TestUser,
    targetWorkspaceId = workspaceId,
  ): Promise<void> {
    const response = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${targetWorkspaceId}/members`,
      {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ email: user.email, role: 'MEMBER' }),
        jar: owner.jar,
      },
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
  }

  async function createProject(user: TestUser, body: Record<string, unknown>, wsId = workspaceId) {
    return jsonRequest(workspaceProjects(wsId), {
      method: 'POST',
      headers: auth(user),
      body: JSON.stringify(body),
      jar: user.jar,
    });
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = (await import('../src/config/env')).loadEnv({
      ...process.env,
      RATE_LIMIT_NAMESPACE: `phase8-db-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    owner = await register('Phase 8 Owner', 'owner');
    member = await register('Phase 8 Member', 'member');
    outsider = await register('Phase 8 Outsider', 'outsider');
    organizationAdmin = await register('Phase 8 Organization Admin', 'admin');
    organizationOwner = await register('Phase 8 Organization Owner', 'org-owner');
    projectManager = await register('Phase 8 Project Manager', 'project-manager');
    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: `Phase 8 Workspace ${tag}` }),
      jar: owner.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);
    await addWorkspaceMember(member);
    await addWorkspaceMember(outsider);
    await addWorkspaceMember(organizationAdmin);
    await addWorkspaceMember(organizationOwner);
    await addWorkspaceMember(projectManager);
    const other = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: `Phase 8 Other Workspace ${tag}` }),
      jar: owner.jar,
    });
    assert.equal(other.status, 201);
    otherWorkspaceId = (other.body.data as { id: string }).id;
    workspaceIds.push(otherWorkspaceId);
    await addWorkspaceMember(organizationAdmin, otherWorkspaceId);
    const adminDb = await connectTestDatabase(rawDbUrl);
    await adminDb.prisma.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: organizationAdmin.id } },
      data: { organizationRole: 'COMPANY_ADMIN' },
    });
    await adminDb.prisma.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: organizationOwner.id } },
      data: { organizationRole: 'COMPANY_OWNER' },
    });
    await adminDb.prisma.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: projectManager.id } },
      data: { role: 'MEMBER' },
    });
    await adminDb.prisma.workspaceMembership.update({
      where: {
        workspaceId_userId: { workspaceId: otherWorkspaceId, userId: organizationAdmin.id },
      },
      data: { organizationRole: 'COMPANY_ADMIN' },
    });
    await adminDb.prisma.$disconnect();
  });

  after(async () => {
    await server?.close();
    await disconnectRedis();
    const db = await connectTestDatabase(rawDbUrl);
    await db.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
  });

  test('workspace-visible project creation, listing, details, activity and audit are integrated', async () => {
    const created = await createProject(owner, {
      name: 'Workspace Project',
      key: `W${Date.now()}`,
      description: 'Initial project',
      category: 'Operations',
      labels: ['launch', 'internal'],
      visibility: 'WORKSPACE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const project = created.body.data as {
      id: string;
      ownerId: string;
      visibility: string;
      memberCount: number;
      category: string;
      labels: string[];
    };
    assert.equal(project.ownerId, owner.id);
    assert.equal(project.visibility, 'WORKSPACE');
    assert.equal(project.memberCount, 1);
    assert.equal(project.category, 'Operations');
    assert.deepEqual(project.labels, ['launch', 'internal']);
    assert.equal(
      (await jsonRequest(projectUrl(project.id), { headers: auth(member) })).status,
      200,
    );
    const list = await jsonRequest(workspaceProjects(), { headers: auth(member) });
    const items = (list.body.data as { items: Array<{ id: string }> }).items;
    assert.ok(items.some((item) => item.id === project.id));
    const activity = await jsonRequest(`${projectUrl(project.id)}/activity`, {
      headers: auth(owner),
    });
    assert.equal(activity.status, 200);
    assert.ok(
      (activity.body.data as { items: Array<{ action: string }> }).items.some(
        (item) => item.action === 'project.created',
      ),
    );
    const createdMilestone = await jsonRequest(`${projectUrl(project.id)}/milestones`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: 'Kickoff', dueDate: '2026-12-15T00:00:00.000Z' }),
      jar: owner.jar,
    });
    assert.equal(createdMilestone.status, 201, JSON.stringify(createdMilestone.body));
    const milestone = createdMilestone.body.data as {
      id: string;
      name: string;
      completedAt: string | null;
    };
    assert.equal(milestone.name, 'Kickoff');
    assert.equal(milestone.completedAt, null);
    const listedMilestones = await jsonRequest(`${projectUrl(project.id)}/milestones`, {
      headers: auth(member),
    });
    assert.equal(listedMilestones.status, 200);
    assert.equal((listedMilestones.body.data as Array<{ id: string }>)[0]?.id, milestone.id);
    const completedMilestone = await jsonRequest(
      `${projectUrl(project.id)}/milestones/${milestone.id}`,
      {
        method: 'PATCH',
        headers: auth(owner),
        body: JSON.stringify({ completed: true }),
        jar: owner.jar,
      },
    );
    assert.equal(completedMilestone.status, 200);
    assert.ok((completedMilestone.body.data as { completedAt: string | null }).completedAt);
    const db = await connectTestDatabase(rawDbUrl);
    try {
      assert.equal(
        await db.prisma.projectMembership.count({
          where: { projectId: project.id, userId: owner.id, role: 'PROJECT_MANAGER' },
        }),
        1,
      );
      assert.ok(
        await db.prisma.auditLog.findFirst({
          where: { targetType: 'Project', targetId: project.id, action: 'project.created' },
        }),
      );
    } finally {
      await db.prisma.$disconnect();
    }
  });

  test('private visibility hides projects from members and organization admins until explicit membership', async () => {
    const response = await createProject(owner, {
      name: 'Private Project',
      key: `P${Date.now()}`,
      visibility: 'PRIVATE',
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const projectId = (response.body.data as { id: string }).id;
    assert.equal((await jsonRequest(projectUrl(projectId), { headers: auth(member) })).status, 404);
    assert.equal(
      (await jsonRequest(projectUrl(projectId), { headers: auth(organizationAdmin) })).status,
      404,
    );
    const add = await jsonRequest(`${projectUrl(projectId)}/members`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ userId: organizationAdmin.id, role: 'VIEWER' }),
      jar: owner.jar,
    });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    assert.equal(
      (await jsonRequest(projectUrl(projectId), { headers: auth(organizationAdmin) })).status,
      200,
    );
    assert.equal(
      (await jsonRequest(`${projectUrl(projectId)}/milestones`, { headers: auth(member) })).status,
      404,
    );
    const roster = await jsonRequest(`${projectUrl(projectId)}/members`, { headers: auth(owner) });
    assert.equal(roster.status, 200);
    assert.ok(
      (roster.body.data as Array<{ userId: string }>).some(
        (row) => row.userId === organizationAdmin.id,
      ),
    );
    assert.equal(
      (await jsonRequest(projectUrl(projectId, otherWorkspaceId), { headers: auth(owner) })).status,
      404,
    );
  });

  test('private-project routes conceal an inaccessible project and its list entry', async () => {
    const created = await createProject(owner, {
      name: 'Hidden private project',
      key: `H${Date.now()}`,
      visibility: 'PRIVATE',
    });
    const projectId = (created.body.data as { id: string }).id;
    const missingId = 'f8e6c5d4-1111-4111-8111-111111111111';
    const hiddenUrl = projectUrl(projectId);
    const missingUrl = projectUrl(missingId);
    const requests = [
      [hiddenUrl, { headers: auth(outsider) }],
      [missingUrl, { headers: auth(outsider) }],
    ] as const;
    const [hidden, missing] = await Promise.all(
      requests.map(([url, options]) => jsonRequest(url, options)),
    );
    assert.ok(hidden && missing);
    assert.equal(hidden.status, 404);
    assert.deepEqual(
      {
        success: (hidden.body as { success: boolean }).success,
        code: (hidden.body as { error: { code: string } }).error.code,
        message: (hidden.body as { error: { message: string } }).error.message,
      },
      {
        success: (missing.body as { success: boolean }).success,
        code: (missing.body as { error: { code: string } }).error.code,
        message: (missing.body as { error: { message: string } }).error.message,
      },
    );

    const privateList = await jsonRequest(`${workspaceProjects()}?limit=1`, {
      headers: auth(outsider),
    });
    assert.equal(privateList.status, 200);
    const page = privateList.body.data as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    assert.equal(
      page.items.some((item) => item.id === projectId),
      false,
    );
    const denied = await Promise.all([
      jsonRequest(hiddenUrl, {
        method: 'PATCH',
        headers: auth(outsider),
        body: JSON.stringify({ name: 'leak' }),
        jar: outsider.jar,
      }),
      jsonRequest(`${hiddenUrl}/activity`, { headers: auth(outsider) }),
      jsonRequest(`${hiddenUrl}/members`, { headers: auth(outsider) }),
      jsonRequest(`${hiddenUrl}/members`, {
        method: 'POST',
        headers: auth(outsider),
        body: JSON.stringify({ userId: member.id }),
        jar: outsider.jar,
      }),
      jsonRequest(`${hiddenUrl}/milestones`, { headers: auth(outsider) }),
      jsonRequest(`${hiddenUrl}/milestones`, {
        method: 'POST',
        headers: auth(outsider),
        body: JSON.stringify({ name: 'unauthorized' }),
        jar: outsider.jar,
      }),
    ]);
    assert.ok(
      denied.every((response) => response.status === 404),
      JSON.stringify(denied.map((response) => response.body)),
    );

    await jsonRequest(`${hiddenUrl}/members`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ userId: outsider.id, role: 'VIEWER' }),
      jar: owner.jar,
    });
    assert.equal((await jsonRequest(hiddenUrl, { headers: auth(outsider) })).status, 200);
    await jsonRequest(`${hiddenUrl}/members/${outsider.id}`, {
      method: 'DELETE',
      headers: auth(owner),
      jar: owner.jar,
    });
    assert.equal((await jsonRequest(hiddenUrl, { headers: auth(outsider) })).status, 404);
  });

  test('ownership transfers support all former-owner outcomes and preserve a single manager', async () => {
    for (const [index, previousOwnerRole] of (['MANAGER', 'MEMBER', 'REMOVE'] as const).entries()) {
      const created = await createProject(owner, {
        name: `Transfer ${previousOwnerRole}`,
        key: `O${index}${Date.now()}`,
        visibility: 'PRIVATE',
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const projectId = (created.body.data as { id: string }).id;
      const beforeNotifications = await connectTestDatabase(rawDbUrl);
      const notificationCount = await beforeNotifications.prisma.notification.count({
        where: { userId: member.id },
      });
      await beforeNotifications.prisma.$disconnect();
      const transferred = await jsonRequest(transferUrl(projectId), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ newOwnerId: member.id, previousOwnerRole }),
        jar: owner.jar,
      });
      assert.equal(transferred.status, 200, JSON.stringify(transferred.body));
      const db = await connectTestDatabase(rawDbUrl);
      try {
        const row = await db.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
        assert.equal(row.ownerId, member.id);
        assert.equal(
          await db.prisma.projectMembership.count({
            where: { projectId, userId: member.id, role: 'PROJECT_MANAGER' },
          }),
          1,
        );
        const oldMembership = await db.prisma.projectMembership.findUnique({
          where: { projectId_userId: { projectId, userId: owner.id } },
        });
        if (previousOwnerRole === 'REMOVE') assert.equal(oldMembership, null);
        else
          assert.equal(
            oldMembership?.role,
            previousOwnerRole === 'MANAGER' ? 'PROJECT_MANAGER' : 'MEMBER',
          );
        assert.ok(
          await db.prisma.projectMembership.count({
            where: { projectId, role: 'PROJECT_MANAGER' },
          }),
        );
        const activities = await db.prisma.auditLog.findMany({
          where: {
            targetType: 'Project',
            targetId: projectId,
            action: 'project.ownership_transferred',
          },
        });
        assert.equal(activities.length, 1);
        assert.equal(activities[0]?.actorId, owner.id);
        assert.equal(
          (activities[0]?.metadata as { previousOwnerId: string }).previousOwnerId,
          owner.id,
        );
        assert.equal((activities[0]?.metadata as { newOwnerId: string }).newOwnerId, member.id);
        assert.equal(
          (activities[0]?.metadata as { previousOwnerRole: string }).previousOwnerRole,
          previousOwnerRole === 'REMOVE'
            ? 'REMOVED'
            : previousOwnerRole === 'MANAGER'
              ? 'PROJECT_MANAGER'
              : 'MEMBER',
        );
        assert.equal(
          (activities[0]?.metadata as { forcedAdminTransfer: boolean }).forcedAdminTransfer,
          false,
        );
        assert.equal(
          await db.prisma.notification.count({ where: { userId: member.id } }),
          notificationCount,
        );
      } finally {
        await db.prisma.$disconnect();
      }
    }
  });

  test('owner and organization administrators can transfer; project managers cannot force-transfer', async () => {
    const project = await createProject(owner, {
      name: 'Admin transfer',
      key: `A${Date.now()}`,
      visibility: 'WORKSPACE',
    });
    const projectId = (project.body.data as { id: string }).id;
    let db = await connectTestDatabase(rawDbUrl);
    await db.prisma.projectMembership.create({
      data: { projectId, userId: projectManager.id, role: 'PROJECT_MANAGER' },
    });
    await db.prisma.$disconnect();

    const denied = await jsonRequest(transferUrl(projectId), {
      method: 'POST',
      headers: auth(projectManager),
      body: JSON.stringify({ newOwnerId: outsider.id }),
      jar: projectManager.jar,
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    db = await connectTestDatabase(rawDbUrl);
    assert.equal(
      await db.prisma.auditLog.count({
        where: {
          targetType: 'Project',
          targetId: projectId,
          action: 'project.ownership_transferred',
        },
      }),
      0,
    );
    await db.prisma.$disconnect();

    const adminTransfer = await jsonRequest(transferUrl(projectId), {
      method: 'POST',
      headers: auth(organizationAdmin),
      body: JSON.stringify({ newOwnerId: member.id }),
      jar: organizationAdmin.jar,
    });
    assert.equal(adminTransfer.status, 200, JSON.stringify(adminTransfer.body));
    assert.equal(
      (adminTransfer.body.data as { forcedAdminTransfer: boolean }).forcedAdminTransfer,
      true,
    );
    const orgOwnerProject = await createProject(owner, {
      name: 'Org owner transfer',
      key: `B${Date.now()}`,
      visibility: 'WORKSPACE',
    });
    const orgOwnerTransfer = await jsonRequest(
      transferUrl((orgOwnerProject.body.data as { id: string }).id),
      {
        method: 'POST',
        headers: auth(organizationOwner),
        body: JSON.stringify({ newOwnerId: outsider.id }),
        jar: organizationOwner.jar,
      },
    );
    assert.equal(orgOwnerTransfer.status, 200, JSON.stringify(orgOwnerTransfer.body));
    assert.equal(
      (orgOwnerTransfer.body.data as { forcedAdminTransfer: boolean }).forcedAdminTransfer,
      true,
    );
  });

  test('ownership transfer rejects ineligible users, self-transfer and soft-deleted projects', async () => {
    const project = await createProject(owner, {
      name: 'Eligibility',
      key: `E${Date.now()}`,
      visibility: 'WORKSPACE',
    });
    const projectId = (project.body.data as { id: string }).id;
    const self = await jsonRequest(transferUrl(projectId), {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ newOwnerId: owner.id }),
      jar: owner.jar,
    });
    assert.equal(self.status, 400);

    const db = await connectTestDatabase(rawDbUrl);
    await db.prisma.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: outsider.id } },
      data: { organizationRole: 'COMPANY_MEMBER' },
    });
    await db.prisma.$disconnect();
    const limited = await jsonRequest(transferUrl(projectId), {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ newOwnerId: outsider.id }),
      jar: owner.jar,
    });
    assert.equal(limited.status, 422);
    const suspendFixture = await connectTestDatabase(rawDbUrl);
    await suspendFixture.prisma.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: outsider.id } },
      data: { organizationRole: null, status: 'SUSPENDED' },
    });
    await suspendFixture.prisma.$disconnect();
    const suspendedTarget = await jsonRequest(transferUrl(projectId), {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ newOwnerId: outsider.id }),
      jar: owner.jar,
    });
    assert.equal(suspendedTarget.status, 422);
    const restoreTarget = await connectTestDatabase(rawDbUrl);
    await restoreTarget.prisma.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: outsider.id } },
      data: { status: 'ACTIVE' },
    });
    await restoreTarget.prisma.user.update({
      where: { id: outsider.id },
      data: { deletedAt: new Date() },
    });
    await restoreTarget.prisma.$disconnect();
    const deletedTarget = await jsonRequest(transferUrl(projectId), {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ newOwnerId: outsider.id }),
      jar: owner.jar,
    });
    assert.equal(deletedTarget.status, 422);
    const reviveFixture = await connectTestDatabase(rawDbUrl);
    await reviveFixture.prisma.user.update({
      where: { id: outsider.id },
      data: { deletedAt: null },
    });
    await reviveFixture.prisma.$disconnect();

    const deletedProject = await createProject(owner, {
      name: 'Deleted transfer',
      key: `D${Date.now()}`,
      visibility: 'WORKSPACE',
    });
    const deletedId = (deletedProject.body.data as { id: string }).id;
    const markDeleted = await connectTestDatabase(rawDbUrl);
    await markDeleted.prisma.project.update({
      where: { id: deletedId },
      data: { deletedAt: new Date() },
    });
    await markDeleted.prisma.$disconnect();
    const deletedResponse = await jsonRequest(transferUrl(deletedId), {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ newOwnerId: member.id }),
      jar: owner.jar,
    });
    assert.equal(deletedResponse.status, 404);
  });

  test('ownership transfer is allowed for archived projects but never for soft-deleted projects', async () => {
    const created = await createProject(owner, {
      name: 'Archived transfer',
      key: `AR${Date.now()}`,
      visibility: 'WORKSPACE',
    });
    const projectId = (created.body.data as { id: string }).id;
    const archived = await jsonRequest(`${projectUrl(projectId)}/archive`, {
      method: 'POST',
      headers: auth(owner),
      jar: owner.jar,
    });
    assert.equal(archived.status, 200);
    const transferred = await jsonRequest(transferUrl(projectId), {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ newOwnerId: member.id }),
      jar: owner.jar,
    });
    assert.equal(transferred.status, 200, JSON.stringify(transferred.body));
    const db = await connectTestDatabase(rawDbUrl);
    const row = await db.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    assert.equal(row.status, 'ARCHIVED');
    assert.equal(row.ownerId, member.id);
    await db.prisma.$disconnect();
  });

  test('DEPARTMENT_TEAM visibility follows current team membership and cannot widen when a team is archived', async () => {
    // Departments only exist in INSTITUTION workspaces (see requireDepartmentAccess), and
    // company organization roles are invalid there (ORGANIZATION_ROLE_WORKSPACE_MISMATCH).
    // Switch the shared workspace for this test only, and restore everything afterwards so
    // later tests keep running against the original workspace type and roles.
    const setup = await connectTestDatabase(rawDbUrl);
    const originalWorkspace = await setup.prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { type: true },
    });
    const originalRoles = await setup.prisma.workspaceMembership.findMany({
      where: {
        workspaceId,
        userId: { in: [owner.id, organizationAdmin.id, organizationOwner.id] },
      },
      select: { userId: true, organizationRole: true },
    });
    await setup.prisma.workspace.update({
      where: { id: workspaceId },
      data: { type: 'INSTITUTION' },
    });
    await setup.prisma.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId, userId: owner.id } },
      data: { organizationRole: 'INSTITUTION_OWNER' },
    });
    await setup.prisma.workspaceMembership.updateMany({
      where: { workspaceId, userId: { in: [organizationAdmin.id, organizationOwner.id] } },
      data: { organizationRole: null },
    });
    const department = await setup.prisma.department.create({
      data: { workspaceId, name: `P8 department ${tag}` },
    });
    const teamA = await setup.prisma.team.create({
      data: { workspaceId, departmentId: department.id, name: `P8 team A ${tag}` },
    });
    const teamB = await setup.prisma.team.create({
      data: { workspaceId, departmentId: department.id, name: `P8 team B ${tag}` },
    });
    await setup.prisma.teamMembership.create({
      data: { teamId: teamA.id, userId: owner.id, role: 'TEAM_LEAD' },
    });
    await setup.prisma.teamMembership.create({
      data: { teamId: teamA.id, userId: member.id, role: 'MEMBER' },
    });
    await setup.prisma.teamMembership.create({
      data: { teamId: teamB.id, userId: owner.id, role: 'TEAM_LEAD' },
    });
    await setup.prisma.departmentMembership.create({
      data: { departmentId: department.id, userId: outsider.id, role: 'MEMBER' },
    });
    await setup.prisma.$disconnect();

    try {
      const projectA = await createProject(owner, {
        name: 'Team A Scope',
        key: `TA${Date.now()}`,
        visibility: 'DEPARTMENT_TEAM',
        teamId: teamA.id,
        departmentId: department.id,
      });
      assert.equal(projectA.status, 201, JSON.stringify(projectA.body));
      const projectB = await createProject(owner, {
        name: 'Team B Scope',
        key: `TB${Date.now()}`,
        visibility: 'DEPARTMENT_TEAM',
        teamId: teamB.id,
        departmentId: department.id,
      });
      assert.equal(projectB.status, 201, JSON.stringify(projectB.body));
      const projectAId = (projectA.body.data as { id: string }).id;
      const projectBId = (projectB.body.data as { id: string }).id;
      assert.equal(
        (await jsonRequest(projectUrl(projectAId), { headers: auth(member) })).status,
        200,
      );
      assert.equal(
        (await jsonRequest(projectUrl(projectBId), { headers: auth(member) })).status,
        404,
      );
      assert.equal(
        (await jsonRequest(projectUrl(projectAId), { headers: auth(outsider) })).status,
        404,
      );

      const departmentOnly = await createProject(owner, {
        name: 'Department-only scope',
        key: `DO${Date.now()}`,
        visibility: 'DEPARTMENT_TEAM',
        departmentId: department.id,
      });
      assert.equal(departmentOnly.status, 201, JSON.stringify(departmentOnly.body));
      const departmentOnlyId = (departmentOnly.body.data as { id: string }).id;
      const departmentOwnerTransfer = await jsonRequest(transferUrl(departmentOnlyId), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ newOwnerId: outsider.id }),
        jar: owner.jar,
      });
      assert.equal(
        departmentOwnerTransfer.status,
        200,
        JSON.stringify(departmentOwnerTransfer.body),
      );
      const teamOwnerDenied = await jsonRequest(transferUrl(projectAId), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ newOwnerId: outsider.id }),
        jar: owner.jar,
      });
      assert.equal(teamOwnerDenied.status, 422, JSON.stringify(teamOwnerDenied.body));
      const addToTeam = await connectTestDatabase(rawDbUrl);
      await addToTeam.prisma.teamMembership.create({
        data: { teamId: teamA.id, userId: outsider.id, role: 'MEMBER' },
      });
      await addToTeam.prisma.$disconnect();
      const teamOwnerTransfer = await jsonRequest(transferUrl(projectAId), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ newOwnerId: outsider.id }),
        jar: owner.jar,
      });
      assert.equal(teamOwnerTransfer.status, 200, JSON.stringify(teamOwnerTransfer.body));

      const move = await connectTestDatabase(rawDbUrl);
      await move.prisma.teamMembership.delete({
        where: { teamId_userId: { teamId: teamA.id, userId: member.id } },
      });
      await move.prisma.teamMembership.create({
        data: { teamId: teamB.id, userId: member.id, role: 'MEMBER' },
      });
      await move.prisma.$disconnect();
      assert.equal(
        (await jsonRequest(projectUrl(projectAId), { headers: auth(member) })).status,
        404,
      );
      assert.equal(
        (await jsonRequest(projectUrl(projectBId), { headers: auth(member) })).status,
        200,
      );

      const archiveTeam = await connectTestDatabase(rawDbUrl);
      await archiveTeam.prisma.team.update({
        where: { id: teamB.id },
        data: { status: 'ARCHIVED', deletedAt: new Date() },
      });
      await archiveTeam.prisma.$disconnect();
      assert.equal(
        (await jsonRequest(projectUrl(projectBId), { headers: auth(member) })).status,
        404,
      );
      assert.equal(
        (await jsonRequest(projectUrl(projectBId), { headers: auth(outsider) })).status,
        404,
      );
    } finally {
      const restore = await connectTestDatabase(rawDbUrl);
      // Restore the type first, then the original (company) roles.
      await restore.prisma.workspace.update({
        where: { id: workspaceId },
        data: { type: originalWorkspace.type },
      });
      for (const row of originalRoles) {
        await restore.prisma.workspaceMembership.update({
          where: { workspaceId_userId: { workspaceId, userId: row.userId } },
          data: { organizationRole: row.organizationRole },
        });
      }
      await restore.prisma.$disconnect();
    }
  });

  test('workspace B admin cannot address workspace A projects or mismatched milestones', async () => {
    const a = await createProject(owner, {
      name: 'Workspace A private',
      key: `XA${Date.now()}`,
      visibility: 'PRIVATE',
    });
    const projectAId = (a.body.data as { id: string }).id;
    const memberA = await jsonRequest(`${projectUrl(projectAId)}/members`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ userId: organizationAdmin.id }),
      jar: owner.jar,
    });
    assert.equal(memberA.status, 201);
    const milestoneA = await jsonRequest(`${projectUrl(projectAId)}/milestones`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: 'A milestone' }),
      jar: owner.jar,
    });
    const milestoneAId = (milestoneA.body.data as { id: string }).id;
    const b = await createProject(
      organizationAdmin,
      { name: 'Workspace B project', key: `XB${Date.now()}`, visibility: 'WORKSPACE' },
      otherWorkspaceId,
    );
    assert.equal(b.status, 201, JSON.stringify(b.body));
    const projectBId = (b.body.data as { id: string }).id;
    const bUrl = projectUrl(projectAId, otherWorkspaceId);
    const hidden = await Promise.all([
      jsonRequest(bUrl, { headers: auth(organizationAdmin) }),
      jsonRequest(bUrl, {
        method: 'PATCH',
        headers: auth(organizationAdmin),
        body: JSON.stringify({ name: 'cross' }),
        jar: organizationAdmin.jar,
      }),
      jsonRequest(`${bUrl}/activity`, { headers: auth(organizationAdmin) }),
      jsonRequest(`${bUrl}/members`, { headers: auth(organizationAdmin) }),
      jsonRequest(`${bUrl}/members`, {
        method: 'POST',
        headers: auth(organizationAdmin),
        body: JSON.stringify({ userId: owner.id }),
        jar: organizationAdmin.jar,
      }),
      jsonRequest(`${bUrl}/members/${owner.id}`, {
        method: 'PATCH',
        headers: auth(organizationAdmin),
        body: JSON.stringify({ role: 'MEMBER' }),
        jar: organizationAdmin.jar,
      }),
      jsonRequest(`${bUrl}/members/${owner.id}`, {
        method: 'DELETE',
        headers: auth(organizationAdmin),
        jar: organizationAdmin.jar,
      }),
      jsonRequest(`${bUrl}/milestones`, { headers: auth(organizationAdmin) }),
      jsonRequest(`${bUrl}/milestones`, {
        method: 'POST',
        headers: auth(organizationAdmin),
        body: JSON.stringify({ name: 'cross' }),
        jar: organizationAdmin.jar,
      }),
      jsonRequest(`${bUrl}/archive`, {
        method: 'POST',
        headers: auth(organizationAdmin),
        jar: organizationAdmin.jar,
      }),
      jsonRequest(`${bUrl}/restore`, {
        method: 'POST',
        headers: auth(organizationAdmin),
        jar: organizationAdmin.jar,
      }),
      jsonRequest(bUrl, {
        method: 'DELETE',
        headers: auth(organizationAdmin),
        jar: organizationAdmin.jar,
      }),
      jsonRequest(`${bUrl}/transfer-ownership`, {
        method: 'POST',
        headers: auth(organizationAdmin),
        body: JSON.stringify({ newOwnerId: member.id }),
        jar: organizationAdmin.jar,
      }),
      jsonRequest(`${bUrl}/milestones/${milestoneAId}`, {
        method: 'DELETE',
        headers: auth(organizationAdmin),
        jar: organizationAdmin.jar,
      }),
    ]);
    assert.ok(
      hidden.every((response) => response.status === 404),
      JSON.stringify(hidden.map((response) => response.status)),
    );
    const mismatch = await jsonRequest(
      `${projectUrl(projectBId, otherWorkspaceId)}/milestones/${milestoneAId}`,
      {
        method: 'PATCH',
        headers: auth(organizationAdmin),
        body: JSON.stringify({ completed: true }),
        jar: organizationAdmin.jar,
      },
    );
    assert.equal(mismatch.status, 404);
    const mismatchDelete = await jsonRequest(
      `${projectUrl(projectBId, otherWorkspaceId)}/milestones/${milestoneAId}`,
      { method: 'DELETE', headers: auth(organizationAdmin), jar: organizationAdmin.jar },
    );
    assert.equal(mismatchDelete.status, 404);
    const db = await connectTestDatabase(rawDbUrl);
    try {
      assert.equal(
        (await db.prisma.project.findUniqueOrThrow({ where: { id: projectAId } })).deletedAt,
        null,
      );
      assert.equal(
        await db.prisma.projectMilestone.count({
          where: { id: milestoneAId, projectId: projectAId },
        }),
        1,
      );
      assert.equal(
        await db.prisma.auditLog.count({
          where: {
            targetType: 'Project',
            targetId: projectAId,
            action: {
              in: ['project.updated', 'project.deleted', 'project.archived', 'project.restored'],
            },
            actorId: organizationAdmin.id,
          },
        }),
        0,
      );
    } finally {
      await db.prisma.$disconnect();
    }
  });

  test('concurrent transfers from one ordinary project owner yield one success and one conflict', async () => {
    const created = await createProject(owner, {
      name: 'Concurrent transfer',
      key: `C${Date.now()}`,
      visibility: 'WORKSPACE',
    });
    const projectId = (created.body.data as { id: string }).id;
    const db = await connectTestDatabase(rawDbUrl);
    await db.prisma.project.update({ where: { id: projectId }, data: { ownerId: member.id } });
    await db.prisma.projectMembership.update({
      where: { projectId_userId: { projectId, userId: owner.id } },
      data: { role: 'MEMBER' },
    });
    await db.prisma.projectMembership.upsert({
      where: { projectId_userId: { projectId, userId: member.id } },
      create: { projectId, userId: member.id, role: 'PROJECT_MANAGER' },
      update: { role: 'PROJECT_MANAGER' },
    });
    await db.prisma.$disconnect();
    const requests = await Promise.all(
      [outsider, projectManager].map((target) =>
        jsonRequest(transferUrl(projectId), {
          method: 'POST',
          headers: auth(member),
          body: JSON.stringify({ newOwnerId: target.id, previousOwnerRole: 'MEMBER' }),
          jar: member.jar,
        }),
      ),
    );
    assert.deepEqual(requests.map((response) => response.status).sort(), [200, 409]);
    const verify = await connectTestDatabase(rawDbUrl);
    try {
      const row = await verify.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      assert.ok([outsider.id, projectManager.id].includes(row.ownerId));
      assert.equal(
        await verify.prisma.projectMembership.count({
          where: { projectId, userId: row.ownerId, role: 'PROJECT_MANAGER' },
        }),
        1,
      );
      assert.equal(
        await verify.prisma.auditLog.count({
          where: {
            targetType: 'Project',
            targetId: projectId,
            action: 'project.ownership_transferred',
          },
        }),
        1,
      );
    } finally {
      await verify.prisma.$disconnect();
    }
  });

  test('department/team-only access follows current team membership and member roles cannot mutate projects', async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const team = await db.prisma.team.create({
      data: { workspaceId, name: `Phase 8 team ${tag}` },
    });
    await db.prisma.teamMembership.create({
      data: { teamId: team.id, userId: owner.id, role: 'TEAM_LEAD' },
    });
    await db.prisma.teamMembership.create({
      data: { teamId: team.id, userId: member.id, role: 'MEMBER' },
    });
    await db.prisma.$disconnect();
    const created = await createProject(owner, {
      name: 'Team Restricted Project',
      key: `T${Date.now()}`,
      visibility: 'DEPARTMENT_TEAM',
      teamId: team.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = (created.body.data as { id: string }).id;
    assert.equal((await jsonRequest(projectUrl(projectId), { headers: auth(member) })).status, 200);
    assert.equal(
      (await jsonRequest(projectUrl(projectId), { headers: auth(outsider) })).status,
      404,
    );
    const privateTeamProject = await createProject(owner, {
      name: 'Private Project With Team Association',
      key: `PT${Date.now()}`,
      visibility: 'PRIVATE',
      teamId: team.id,
    });
    assert.equal(privateTeamProject.status, 201, JSON.stringify(privateTeamProject.body));
    const privateTeamProjectId = (privateTeamProject.body.data as { id: string }).id;
    assert.equal(
      (await jsonRequest(projectUrl(privateTeamProjectId), { headers: auth(member) })).status,
      404,
    );
    const memberProjectList = await jsonRequest(workspaceProjects(), { headers: auth(member) });
    assert.equal(
      (memberProjectList.body.data as { items: Array<{ id: string }> }).items.some(
        (item) => item.id === privateTeamProjectId,
      ),
      false,
    );
    const deniedUpdate = await jsonRequest(projectUrl(projectId), {
      method: 'PATCH',
      headers: auth(member),
      body: JSON.stringify({ name: 'Unauthorized' }),
      jar: member.jar,
    });
    assert.equal(deniedUpdate.status, 403);
    const teamDb = await connectTestDatabase(rawDbUrl);
    await teamDb.prisma.teamMembership.delete({
      where: { teamId_userId: { teamId: team.id, userId: member.id } },
    });
    await teamDb.prisma.$disconnect();
    assert.equal((await jsonRequest(projectUrl(projectId), { headers: auth(member) })).status, 404);
  });

  test('project update, archive, list filtering, restoration and soft deletion work', async () => {
    const created = await createProject(owner, {
      name: 'Lifecycle Project',
      key: `L${Date.now()}`,
      visibility: 'WORKSPACE',
    });
    const projectId = (created.body.data as { id: string }).id;
    const milestoneResponse = await jsonRequest(`${projectUrl(projectId)}/milestones`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: 'Retained milestone' }),
      jar: owner.jar,
    });
    const milestoneId = (milestoneResponse.body.data as { id: string }).id;
    const updated = await jsonRequest(projectUrl(projectId), {
      method: 'PATCH',
      headers: auth(owner),
      body: JSON.stringify({
        name: 'Lifecycle Project Updated',
        dueDate: '2026-12-01T00:00:00.000Z',
        category: 'Delivery',
        labels: ['urgent'],
        status: 'ACTIVE',
      }),
      jar: owner.jar,
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal((updated.body.data as { category: string }).category, 'Delivery');
    assert.equal((updated.body.data as { status: string }).status, 'ACTIVE');
    assert.deepEqual((updated.body.data as { labels: string[] }).labels, ['urgent']);
    const archive = await jsonRequest(`${projectUrl(projectId)}/archive`, {
      method: 'POST',
      headers: auth(owner),
      jar: owner.jar,
    });
    assert.equal(archive.status, 200);
    assert.equal((archive.body.data as { status: string }).status, 'ARCHIVED');
    const defaultList = await jsonRequest(workspaceProjects(), { headers: auth(owner) });
    assert.equal(
      (defaultList.body.data as { items: Array<{ id: string }> }).items.some(
        (item) => item.id === projectId,
      ),
      false,
    );
    const archivedList = await jsonRequest(`${workspaceProjects()}?includeArchived=true`, {
      headers: auth(owner),
    });
    assert.equal(
      (archivedList.body.data as { items: Array<{ id: string }> }).items.some(
        (item) => item.id === projectId,
      ),
      true,
    );
    const restore = await jsonRequest(`${projectUrl(projectId)}/restore`, {
      method: 'POST',
      headers: auth(owner),
      jar: owner.jar,
    });
    assert.equal(restore.status, 200);
    assert.equal((restore.body.data as { status: string }).status, 'ACTIVE');
    assert.equal(
      (await jsonRequest(`${projectUrl(projectId)}/milestones`, { headers: auth(owner) })).status,
      200,
    );
    assert.equal(
      (
        (await jsonRequest(`${projectUrl(projectId)}/milestones`, { headers: auth(owner) })).body
          .data as Array<{ id: string }>
      ).some((item) => item.id === milestoneId),
      true,
    );
    assert.ok(
      (
        (await jsonRequest(`${projectUrl(projectId)}/activity`, { headers: auth(owner) })).body
          .data as { items: Array<{ action: string }> }
      ).items.some((item) => item.action === 'project.restored'),
    );
    const remove = await jsonRequest(projectUrl(projectId), {
      method: 'DELETE',
      headers: auth(owner),
      jar: owner.jar,
    });
    assert.equal(remove.status, 200);
    assert.equal((await jsonRequest(projectUrl(projectId), { headers: auth(owner) })).status, 404);
    assert.equal(
      (await jsonRequest(`${projectUrl(projectId)}/activity`, { headers: auth(owner) })).status,
      404,
    );
    assert.equal(
      (await jsonRequest(`${projectUrl(projectId)}/milestones`, { headers: auth(owner) })).status,
      404,
    );
    assert.equal(
      (
        await jsonRequest(projectUrl(projectId), {
          method: 'DELETE',
          headers: auth(owner),
          jar: owner.jar,
        })
      ).status,
      404,
    );
  });
}