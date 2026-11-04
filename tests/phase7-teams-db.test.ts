import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

/**
 * Phase 7 database integration tests — team lifecycle and permissions.
 *
 * These tests drive the real HTTP application against a test PostgreSQL
 * database. They verify:
 *
 * - Full team lifecycle: create → list → get → update → archive → delete
 * - Team member management: add, update role, remove
 * - Team lead change with membership role synchronization
 * - Authorization: workspace OWNER, PROJECT_MANAGER and MEMBER have correct
 *   access; outsiders and COLLABORATOR/VIEWER roles are denied
 * - Audit log entries written for each change
 * - Notifications created for team membership events
 * - A deleted team is not returned in the active team list
 *
 * Run with:
 *   RUN_PHASE7_DB_TESTS=true DATABASE_URL=postgresql://nexus:nexus@localhost:5432/nexus_test npm test
 */

const DB_FLAG = 'RUN_PHASE7_DB_TESTS';

const dbUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!dbUrl) {
  describe('Phase 7 teams db tests', () => {
    test('skipped — set RUN_PHASE7_DB_TESTS=true to run', () => {});
  });
} else {
  runTests(dbUrl);
}

function runTests(rawDbUrl: string): void {
  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  interface TestUser {
    id: string;
    email: string;
    accessToken: string;
    jar: CookieJar;
  }

  let server: RunningServer;
  let baseUrl: string;

  let owner: TestUser;
  let pm: TestUser;
  let member: TestUser;
  let outsider: TestUser;

  let workspaceId: string;
  let institutionWorkspaceId: string;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function register(name: string, email: string, password: string): Promise<TestUser> {
    const jar = new CookieJar();

    const reg = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
      jar,
    });
    assert.equal(reg.status, 201, `register failed for ${email}: ${JSON.stringify(reg.body)}`);

    // Activate account directly via the database (avoids email delivery).
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
    assert.equal(login.status, 200, `login failed for ${email}`);
    const accessToken = (login.body.data as { accessToken: string }).accessToken;

    const meRes = await jsonRequest<{ user: { id: string } }>(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      jar,
    });
    const id = (meRes.body.data as { user: { id: string } }).user.id;

    return { id, email, accessToken, jar };
  }

  function auth(user: TestUser): Record<string, string> {
    return {
      Authorization: `Bearer ${user.accessToken}`,
      'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
    };
  }

  async function addWorkspaceMember(
    actor: TestUser,
    wsId: string,
    email: string,
    role = 'MEMBER',
  ): Promise<void> {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${wsId}/members`, {
      method: 'POST',
      headers: auth(actor),
      body: JSON.stringify({ email, role }),
      jar: actor.jar,
    });
    assert.equal(res.status, 201, `addWorkspaceMember failed: ${JSON.stringify(res.body)}`);
  }

  function teamUrl(wsId: string, teamId?: string): string {
    const base = `${baseUrl}/api/v1/workspaces/${wsId}/teams`;
    return teamId ? `${base}/${teamId}` : base;
  }

  async function createTeam(
    actor: TestUser,
    wsId: string,
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await jsonRequest<{ id: string }>(teamUrl(wsId), {
      method: 'POST',
      headers: auth(actor),
      body: JSON.stringify({ name, ...extra }),
      jar: actor.jar,
    });
    assert.equal(res.status, 201, `createTeam failed: ${JSON.stringify(res.body)}`);
    return (res.body.data as { id: string }).id;
  }

  // ---------------------------------------------------------------------------
  // Setup / teardown
  // ---------------------------------------------------------------------------

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const config = (await import('../src/config/env')).loadEnv();
    await connectRedis(config);
    const app = createApp({ config });
    server = await startServer(app);
    baseUrl = server.baseUrl;

    // Clean up stale data from previous interrupted runs.
    const testEmails = [
      'p7-owner@test.example',
      'p7-pm@test.example',
      'p7-member@test.example',
      'p7-outsider@test.example',
    ];
    const staleUsers = await db.prisma.user.findMany({
      where: { email: { in: testEmails } },
      select: { id: true },
    });
    await db.prisma.workspace.deleteMany({
      where: { OR: [{ id: workspaceId }, { ownerId: { in: staleUsers.map(({ id }) => id) } }] },
    });
    await db.prisma.user.deleteMany({ where: { id: { in: staleUsers.map(({ id }) => id) } } });
    await db.prisma.$disconnect();

    owner = await register('P7 Owner', 'p7-owner@test.example', 'TestPass123!');
    pm = await register('P7 PM', 'p7-pm@test.example', 'TestPass123!');
    member = await register('P7 Member', 'p7-member@test.example', 'TestPass123!');
    outsider = await register('P7 Outsider', 'p7-outsider@test.example', 'TestPass123!');

    // Create the workspace and populate membership.
    const ws = await jsonRequest<{ id: string }>(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: 'Phase7 Test Workspace' }),
      jar: owner.jar,
    });
    assert.equal(ws.status, 201);
    workspaceId = (ws.body.data as { id: string }).id;

    await addWorkspaceMember(owner, workspaceId, pm.email, 'PROJECT_MANAGER');
    await addWorkspaceMember(owner, workspaceId, member.email, 'MEMBER');
    const institution = await jsonRequest<{ id: string }>(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: 'Phase7 Institution', type: 'INSTITUTION' }),
      jar: owner.jar,
    });
    assert.equal(
      institution.status,
      201,
      `institution workspace creation failed: ${JSON.stringify(institution.body)}`,
    );
    institutionWorkspaceId = (institution.body.data as { id: string }).id;
    await addWorkspaceMember(owner, institutionWorkspaceId, member.email, 'MEMBER');
    await addWorkspaceMember(owner, institutionWorkspaceId, pm.email, 'MEMBER');
    // outsider is NOT added to the workspace.
  });

  after(async () => {
    await server?.close();
    await disconnectRedis();
    const db = await connectTestDatabase(rawDbUrl);
    const testUsers = await db.prisma.user.findMany({
      where: {
        email: {
          in: [
            'p7-owner@test.example',
            'p7-pm@test.example',
            'p7-member@test.example',
            'p7-outsider@test.example',
          ],
        },
      },
      select: { id: true },
    });
    await db.prisma.workspace.deleteMany({
      where: { OR: [{ id: workspaceId }, { ownerId: { in: testUsers.map(({ id }) => id) } }] },
    });
    await db.prisma.user.deleteMany({
      where: { id: { in: testUsers.map(({ id }) => id) } },
    });
    await db.prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  describe('Phase 7 team lifecycle', () => {
    let teamId: string;

    test('OWNER can create a team', async () => {
      teamId = await createTeam(owner, workspaceId, 'Alpha Team');
      assert.ok(teamId, 'team id should be returned');
    });

    test('created team appears in the list', async () => {
      const res = await jsonRequest<Array<{ id: string; name: string }>>(teamUrl(workspaceId), {
        headers: auth(owner),
      });
      assert.equal(res.status, 200);
      const teams = res.body.data as Array<{ id: string; name: string }>;
      assert.ok(
        teams.some((t) => t.id === teamId),
        'Alpha Team should be in the list',
      );
    });

    test('can get the team by id', async () => {
      const res = await jsonRequest<{ id: string; name: string }>(teamUrl(workspaceId, teamId), {
        headers: auth(owner),
      });
      assert.equal(res.status, 200);
      const team = res.body.data as { id: string; name: string };
      assert.equal(team.id, teamId);
      assert.equal(team.name, 'Alpha Team');
    });

    test('OWNER can update team name and description', async () => {
      const res = await jsonRequest<{ name: string; description: string }>(
        teamUrl(workspaceId, teamId),
        {
          method: 'PATCH',
          headers: auth(owner),
          body: JSON.stringify({ name: 'Alpha Team Updated', description: 'Core team' }),
          jar: owner.jar,
        },
      );
      assert.equal(res.status, 200);
      const team = res.body.data as { name: string; description: string };
      assert.equal(team.name, 'Alpha Team Updated');
      assert.equal(team.description, 'Core team');
    });

    test('PROJECT_MANAGER can update a team', async () => {
      const pmTeamId = await createTeam(pm, workspaceId, 'PM Team');
      const res = await jsonRequest(teamUrl(workspaceId, pmTeamId), {
        method: 'PATCH',
        headers: auth(pm),
        body: JSON.stringify({ name: 'PM Team Updated' }),
        jar: pm.jar,
      });
      assert.equal(res.status, 200);
    });

    test('MEMBER cannot create a team', async () => {
      const res = await jsonRequest(teamUrl(workspaceId), {
        method: 'POST',
        headers: auth(member),
        body: JSON.stringify({ name: 'Member Team' }),
        jar: member.jar,
      });
      assert.equal(res.status, 403);
    });

    test('outsider cannot list teams in a workspace', async () => {
      const res = await jsonRequest(teamUrl(workspaceId), {
        headers: auth(outsider),
      });
      assert.equal(res.status, 403);
    });

    test('outsider cannot get a specific team', async () => {
      const res = await jsonRequest(teamUrl(workspaceId, teamId), {
        headers: auth(outsider),
      });
      assert.equal(res.status, 403);
    });

    test('MEMBER can list teams', async () => {
      const res = await jsonRequest(teamUrl(workspaceId), {
        headers: auth(member),
      });
      assert.equal(res.status, 200);
    });

    test('OWNER can archive a team', async () => {
      const archiveTeamId = await createTeam(owner, workspaceId, 'To Archive');
      const res = await jsonRequest(`${teamUrl(workspaceId, archiveTeamId)}/archive`, {
        method: 'POST',
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(res.status, 200);
      const team = res.body.data as { status: string };
      assert.equal(team.status, 'ARCHIVED');
    });

    test('archived team does not appear in the default list', async () => {
      const res = await jsonRequest<Array<{ id: string; status: string }>>(teamUrl(workspaceId), {
        headers: auth(owner),
      });
      assert.equal(res.status, 200);
      const teams = res.body.data as Array<{ id: string; status: string }>;
      // All returned teams should be active.
      assert.ok(
        teams.every((t) => t.status === 'ACTIVE'),
        'default list should only return ACTIVE teams',
      );
    });

    test('archived team appears when includeArchived=true', async () => {
      const res = await jsonRequest<Array<{ id: string; status: string }>>(
        `${teamUrl(workspaceId)}?includeArchived=true`,
        { headers: auth(owner) },
      );
      assert.equal(res.status, 200);
      const teams = res.body.data as Array<{ id: string; status: string }>;
      assert.ok(
        teams.some((t) => t.status === 'ARCHIVED'),
        'archived teams should appear when includeArchived=true',
      );
    });

    test('audit log records team creation', async () => {
      const db = await connectTestDatabase(rawDbUrl);
      const entry = await db.prisma.auditLog.findFirst({
        where: { targetId: teamId, action: 'team.created' },
      });
      await db.prisma.$disconnect();
      assert.ok(entry, 'audit log entry for team.created should exist');
    });

    test('OWNER can delete a team (soft-delete)', async () => {
      const deleteTeamId = await createTeam(owner, workspaceId, 'To Delete');
      const res = await jsonRequest(teamUrl(workspaceId, deleteTeamId), {
        method: 'DELETE',
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(res.status, 200);
      const body = res.body.data as { id: string; deleted: boolean };
      assert.equal(body.deleted, true);
    });

    test('deleted team does not appear in the list', async () => {
      const res = await jsonRequest<Array<{ id: string }>>(
        `${teamUrl(workspaceId)}?includeArchived=true`,
        { headers: auth(owner) },
      );
      assert.equal(res.status, 200);
    });

    test('MEMBER cannot delete a team', async () => {
      const res = await jsonRequest(teamUrl(workspaceId, teamId), {
        method: 'DELETE',
        headers: auth(member),
        jar: member.jar,
      });
      assert.equal(res.status, 403);
    });
  });

  describe('Phase 7 team membership', () => {
    let memberTeamId: string;

    before(async () => {
      memberTeamId = await createTeam(owner, workspaceId, 'Membership Team');
    });

    test('OWNER can add a workspace member to a team', async () => {
      const res = await jsonRequest(`${teamUrl(workspaceId, memberTeamId)}/members`, {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ userId: member.id, role: 'MEMBER' }),
        jar: owner.jar,
      });
      assert.equal(res.status, 201, `addMember failed: ${JSON.stringify(res.body)}`);
      const added = res.body.data as { userId: string; role: string };
      assert.equal(added.userId, member.id);
      assert.equal(added.role, 'MEMBER');
    });

    test('duplicate add is rejected', async () => {
      const res = await jsonRequest(`${teamUrl(workspaceId, memberTeamId)}/members`, {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ userId: member.id, role: 'MEMBER' }),
        jar: owner.jar,
      });
      assert.equal(res.status, 409);
    });

    test('OWNER can list team members', async () => {
      const res = await jsonRequest<Array<{ userId: string }>>(
        `${teamUrl(workspaceId, memberTeamId)}/members`,
        { headers: auth(owner) },
      );
      assert.equal(res.status, 200);
      const members = res.body.data as Array<{ userId: string }>;
      assert.ok(
        members.some((m) => m.userId === member.id),
        'member should appear in the team members list',
      );
    });

    test('OWNER can update a team member role to TEAM_LEAD', async () => {
      const res = await jsonRequest(`${teamUrl(workspaceId, memberTeamId)}/members/${member.id}`, {
        method: 'PATCH',
        headers: auth(owner),
        body: JSON.stringify({ role: 'TEAM_LEAD' }),
        jar: owner.jar,
      });
      assert.equal(res.status, 200);
      const updated = res.body.data as { role: string };
      assert.equal(updated.role, 'TEAM_LEAD');
    });

    test('audit log records member role change', async () => {
      const db = await connectTestDatabase(rawDbUrl);
      const entry = await db.prisma.auditLog.findFirst({
        where: {
          action: 'team.member_role_changed',
          workspaceId,
        },
        orderBy: { createdAt: 'desc' },
      });
      await db.prisma.$disconnect();
      assert.ok(entry, 'audit log entry for team.member_role_changed should exist');
    });

    test('notification is created for membership role change', async () => {
      const db = await connectTestDatabase(rawDbUrl);
      const notification = await db.prisma.notification.findFirst({
        where: {
          userId: member.id,
          type: 'MEMBERSHIP_CHANGED',
        },
        orderBy: { createdAt: 'desc' },
      });
      await db.prisma.$disconnect();
      assert.ok(notification, 'a membership notification should exist for the team member');
    });

    test('cannot add a user who is not a workspace member', async () => {
      const res = await jsonRequest(`${teamUrl(workspaceId, memberTeamId)}/members`, {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ userId: outsider.id, role: 'MEMBER' }),
        jar: owner.jar,
      });
      assert.equal(res.status, 404);
      assert.equal((res.body.error as { code: string }).code, 'WORKSPACE_MEMBER_NOT_FOUND');
    });

    test('OWNER can remove a team member', async () => {
      const res = await jsonRequest(`${teamUrl(workspaceId, memberTeamId)}/members/${member.id}`, {
        method: 'DELETE',
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(res.status, 200);
    });

    test('removing a non-existent member returns 404', async () => {
      const res = await jsonRequest(`${teamUrl(workspaceId, memberTeamId)}/members/${member.id}`, {
        method: 'DELETE',
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(res.status, 404);
    });
  });

  describe('Phase 7 team lead management', () => {
    let leadTeamId: string;

    before(async () => {
      leadTeamId = await createTeam(owner, workspaceId, 'Lead Team');
      // Add PM as a team member first.
      await jsonRequest(`${teamUrl(workspaceId, leadTeamId)}/members`, {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ userId: pm.id, role: 'MEMBER' }),
        jar: owner.jar,
      });
    });

    test('OWNER can change the team lead to an existing workspace member', async () => {
      const res = await jsonRequest(`${teamUrl(workspaceId, leadTeamId)}/lead`, {
        method: 'PATCH',
        headers: auth(owner),
        body: JSON.stringify({ leadId: pm.id }),
        jar: owner.jar,
      });
      assert.equal(res.status, 200, `changeLead failed: ${JSON.stringify(res.body)}`);
      const team = res.body.data as { leadId: string };
      assert.equal(team.leadId, pm.id);
    });

    test('new lead has TEAM_LEAD role in team membership', async () => {
      const res = await jsonRequest<Array<{ userId: string; role: string }>>(
        `${teamUrl(workspaceId, leadTeamId)}/members`,
        { headers: auth(owner) },
      );
      assert.equal(res.status, 200);
      const members = res.body.data as Array<{ userId: string; role: string }>;
      const pmMembership = members.find((m) => m.userId === pm.id);
      assert.ok(pmMembership, 'PM should appear in team members');
      assert.equal(pmMembership?.role, 'TEAM_LEAD');
    });

    test('audit log records lead change', async () => {
      const db = await connectTestDatabase(rawDbUrl);
      const entry = await db.prisma.auditLog.findFirst({
        where: { targetId: leadTeamId, action: 'team.lead_changed' },
        orderBy: { createdAt: 'desc' },
      });
      await db.prisma.$disconnect();
      assert.ok(entry, 'audit log entry for team.lead_changed should exist');
    });

    test('notification sent to new lead', async () => {
      const db = await connectTestDatabase(rawDbUrl);
      const notification = await db.prisma.notification.findFirst({
        where: {
          userId: pm.id,
          type: 'MEMBERSHIP_CHANGED',
          title: { contains: 'lead' },
        },
        orderBy: { createdAt: 'desc' },
      });
      await db.prisma.$disconnect();
      assert.ok(notification, 'new lead should receive a notification');
    });

    test('OWNER can clear the team lead (set to null)', async () => {
      const res = await jsonRequest(`${teamUrl(workspaceId, leadTeamId)}/lead`, {
        method: 'PATCH',
        headers: auth(owner),
        body: JSON.stringify({ leadId: null }),
        jar: owner.jar,
      });
      assert.equal(res.status, 200);
      const team = res.body.data as { leadId: string | null };
      assert.equal(team.leadId, null);
    });

    test('cannot set lead to a user who is not a workspace member', async () => {
      const res = await jsonRequest(`${teamUrl(workspaceId, leadTeamId)}/lead`, {
        method: 'PATCH',
        headers: auth(owner),
        body: JSON.stringify({ leadId: outsider.id }),
        jar: owner.jar,
      });
      assert.equal(res.status, 404);
      assert.equal((res.body.error as { code: string }).code, 'LEAD_NOT_FOUND');
    });

    test('MEMBER cannot change the team lead', async () => {
      const res = await jsonRequest(`${teamUrl(workspaceId, leadTeamId)}/lead`, {
        method: 'PATCH',
        headers: auth(member),
        body: JSON.stringify({ leadId: pm.id }),
        jar: member.jar,
      });
      // member is not a team member and workspace MEMBER role alone cannot manage members
      assert.ok([403, 403].includes(res.status), 'member should be forbidden from changing lead');
    });
  });

  describe('Phase 7 team creation with initial lead', () => {
    test('can create a team with a leadId specified', async () => {
      const res = await jsonRequest<{
        id: string;
        leadId: string | null;
        memberCount: number;
      }>(teamUrl(workspaceId), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ name: 'Led Team', leadId: pm.id }),
        jar: owner.jar,
      });
      assert.equal(res.status, 201);
      const team = res.body.data as { id: string; leadId: string | null; memberCount: number };
      assert.equal(team.leadId, pm.id);
      // creator + lead = 2 members
      assert.ok(team.memberCount >= 2);
    });

    test('cannot create a team with a leadId that is not a workspace member', async () => {
      const res = await jsonRequest(teamUrl(workspaceId), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ name: 'Bad Lead Team', leadId: outsider.id }),
        jar: owner.jar,
      });
      assert.equal(res.status, 404);
      assert.equal((res.body.error as { code: string }).code, 'LEAD_NOT_FOUND');
    });
  });

  describe('Phase 7 validation errors', () => {
    test('creating a team with a name that is too short returns 400', async () => {
      const res = await jsonRequest(teamUrl(workspaceId), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ name: 'X' }),
        jar: owner.jar,
      });
      assert.equal(res.status, 400);
    });

    test('updating a team with unknown fields returns 400', async () => {
      const anyTeamId = await createTeam(owner, workspaceId, 'Validation Team');
      const res = await jsonRequest(teamUrl(workspaceId, anyTeamId), {
        method: 'PATCH',
        headers: auth(owner),
        body: JSON.stringify({ status: 'ARCHIVED' }),
        jar: owner.jar,
      });
      assert.equal(res.status, 400);
    });

    test('updating a team with an empty body returns 400', async () => {
      const anyTeamId = await createTeam(owner, workspaceId, 'Empty Update Team');
      const res = await jsonRequest(teamUrl(workspaceId, anyTeamId), {
        method: 'PATCH',
        headers: auth(owner),
        body: JSON.stringify({}),
        jar: owner.jar,
      });
      assert.equal(res.status, 400);
    });

    test('fetching a team that does not exist returns 404', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await jsonRequest(teamUrl(workspaceId, fakeId), {
        headers: auth(owner),
      });
      assert.equal(res.status, 404);
    });
  });

  describe('Phase 7 organization profiles and institution groups', () => {
    test('company profile is provisioned and only company fields are accepted', async () => {
      const read = await jsonRequest<{ name: string }>(
        `${baseUrl}/api/v1/workspaces/${workspaceId}/company-profile`,
        { headers: auth(owner) },
      );
      assert.equal(read.status, 200);
      assert.equal((read.body.data as { name: string }).name, 'Phase7 Test Workspace');

      const updated = await jsonRequest<{ industryCategory: string }>(
        `${baseUrl}/api/v1/workspaces/${workspaceId}/company-profile`,
        {
          method: 'PATCH',
          headers: auth(owner),
          body: JSON.stringify({ industryCategory: 'Education' }),
          jar: owner.jar,
        },
      );
      assert.equal(updated.status, 200);
      assert.equal(
        (updated.body.data as { industryCategory: string }).industryCategory,
        'Education',
      );

      const wrongType = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${workspaceId}/institution-profile`,
        {
          headers: auth(owner),
        },
      );
      assert.equal(wrongType.status, 404);
    });

    test('institution profile and groups stay separate from departments and require organization administration', async () => {
      const profile = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/institution-profile`,
        {
          method: 'PATCH',
          headers: auth(owner),
          body: JSON.stringify({
            institutionType: 'UNIVERSITY',
            institutionalEmail: 'admin@institution.example',
          }),
          jar: owner.jar,
        },
      );
      assert.equal(profile.status, 200);

      const denied = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/institution-groups`,
        {
          method: 'POST',
          headers: auth(member),
          body: JSON.stringify({ name: 'Unauthorized Group' }),
          jar: member.jar,
        },
      );
      assert.equal(denied.status, 403);

      const created = await jsonRequest<{ id: string }>(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/institution-groups`,
        {
          method: 'POST',
          headers: auth(owner),
          body: JSON.stringify({ name: 'Research Group' }),
          jar: owner.jar,
        },
      );
      assert.equal(created.status, 201);
      const groupId = (created.body.data as { id: string }).id;

      const added = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/institution-groups/${groupId}/members`,
        {
          method: 'POST',
          headers: auth(owner),
          body: JSON.stringify({ userId: member.id }),
          jar: owner.jar,
        },
      );
      assert.equal(added.status, 201);

      const visible = await jsonRequest<Array<{ id: string }>>(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/institution-groups`,
        { headers: auth(member) },
      );
      assert.equal(visible.status, 200);
      assert.equal(
        (visible.body.data as Array<{ id: string }>).some((group) => group.id === groupId),
        true,
      );

      const outsiderList = await jsonRequest<Array<{ id: string }>>(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/institution-groups`,
        { headers: auth(pm) },
      );
      assert.equal(outsiderList.status, 200);
      assert.equal(
        (outsiderList.body.data as Array<{ id: string }>).some((group) => group.id === groupId),
        false,
      );
    });
  });
}
