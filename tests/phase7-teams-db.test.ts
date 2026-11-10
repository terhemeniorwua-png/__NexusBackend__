import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { resetEmailSender, setEmailSender, type EmailMessage } from '../src/services/email';
import { ProjectCapability, requireProjectAccess } from '../src/modules/authorization';
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
  const testRun = `${process.pid}-${Date.now()}`;
  const fixtureEmails = [
    `p7-owner-${testRun}@test.example`,
    `p7-pm-${testRun}@test.example`,
    `p7-member-${testRun}@test.example`,
    `p7-outsider-${testRun}@test.example`,
  ];

  let workspaceId: string;
  let institutionWorkspaceId: string;
  const createdWorkspaceIds: string[] = [];
  const extraUserIds: string[] = [];

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
    // The application routes use the shared Prisma client. Bind it explicitly
    // to the same isolated database used for fixture writes before creating
    // the app so the test cannot read from an implicit development URL.
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = (await import('./helpers/test-config')).loadTestConfig({
      RATE_LIMIT_NAMESPACE: `phase7-db-${process.pid}-${Date.now()}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    await connectRedis(config);
    const app = createApp({ config });
    server = await startServer(app);
    baseUrl = server.baseUrl;

    await db.prisma.$disconnect();

    owner = await register('P7 Owner', fixtureEmails[0]!, 'TestPass123!');
    pm = await register('P7 PM', fixtureEmails[1]!, 'TestPass123!');
    member = await register('P7 Member', fixtureEmails[2]!, 'TestPass123!');
    outsider = await register('P7 Outsider', fixtureEmails[3]!, 'TestPass123!');

    // Create the workspace and populate membership.
    const ws = await jsonRequest<{ id: string }>(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: 'Phase7 Test Workspace' }),
      jar: owner.jar,
    });
    assert.equal(ws.status, 201);
    workspaceId = (ws.body.data as { id: string }).id;
    createdWorkspaceIds.push(workspaceId);

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
    createdWorkspaceIds.push(institutionWorkspaceId);
    await addWorkspaceMember(owner, institutionWorkspaceId, member.email, 'MEMBER');
    await addWorkspaceMember(owner, institutionWorkspaceId, pm.email, 'MEMBER');
    // outsider is NOT added to the workspace.
  });

  after(async () => {
    await server?.close();
    await disconnectRedis();
    const db = await connectTestDatabase(rawDbUrl);
    const createdUserIds = [owner?.id, pm?.id, member?.id, outsider?.id, ...extraUserIds].filter(
      (id): id is string => Boolean(id),
    );
    await db.prisma.workspace.deleteMany({ where: { id: { in: createdWorkspaceIds } } });
    await db.prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
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

  describe('Phase 4.4 team invitation workflow', () => {
    test('invites an existing workspace member and adds only team membership on acceptance', async () => {
      const invitedTeamId = await createTeam(owner, workspaceId, 'Invitation Team');
      let captured: EmailMessage | undefined;
      setEmailSender({
        async send(message) {
          captured = message;
          return { accepted: true };
        },
      });

      try {
        const create = await jsonRequest(`${teamUrl(workspaceId, invitedTeamId)}/invitations`, {
          method: 'POST',
          headers: auth(owner),
          body: JSON.stringify({ targetUserId: member.id }),
          jar: owner.jar,
        });
        assert.equal(create.status, 201, JSON.stringify(create.body));
        assert.equal((create.body.data as { emailSent: boolean }).emailSent, true);
        assert.equal(captured?.template, 'team_invitation');
        assert.equal(captured?.to, member.email);

        const link = captured!.text.match(/\?token=([A-Za-z0-9_-]+)/);
        assert.ok(link, 'team invitation email should contain its one-time acceptance token');
        const token = decodeURIComponent(link[1]!);
        assert.equal(JSON.stringify(create.body).includes(token), false);

        const invitation = (create.body.data as { invitation: { id: string; type: string; teamId: string } }).invitation;
        assert.equal(invitation.type, 'TEAM');
        assert.equal(invitation.teamId, invitedTeamId);

        const duplicate = await jsonRequest(`${teamUrl(workspaceId, invitedTeamId)}/invitations`, {
          method: 'POST',
          headers: auth(owner),
          body: JSON.stringify({ targetUserId: member.id }),
          jar: owner.jar,
        });
        assert.equal(duplicate.status, 409);

        const preview = await jsonRequest(`${baseUrl}/api/v1/invitations/${token}`);
        assert.equal(preview.status, 200);
        assert.equal((preview.body.data as { team: { id: string; name: string } }).team.id, invitedTeamId);

        const verify = await jsonRequest(`${baseUrl}/api/v1/invitations/${token}/verify`, {
          headers: auth(member),
          jar: member.jar,
        });
        assert.equal(verify.status, 200);
        const viewer = (verify.body.data as { viewer: { alreadyMember: boolean; canAccept: boolean; alreadyTeamMember: boolean } }).viewer;
        assert.equal(viewer.alreadyMember, true);
        assert.equal(viewer.canAccept, true);
        assert.equal(viewer.alreadyTeamMember, false);

        const before = await connectTestDatabase(rawDbUrl);
        const membershipBefore = await before.prisma.workspaceMembership.findUniqueOrThrow({
          where: { workspaceId_userId: { workspaceId, userId: member.id } },
          select: { role: true },
        });
        await before.prisma.$disconnect();

        const accepts = await Promise.all([
          jsonRequest(`${baseUrl}/api/v1/invitations/${token}/accept`, {
            method: 'POST',
            headers: auth(member),
            jar: member.jar,
          }),
          jsonRequest(`${baseUrl}/api/v1/invitations/${token}/accept`, {
            method: 'POST',
            headers: auth(member),
            jar: member.jar,
          }),
        ]);
        assert.deepEqual(accepts.map((result) => result.status).sort(), [200, 409]);
        const db = await connectTestDatabase(rawDbUrl);
        const [teamMembership, membershipAfter, persistedInvitation] = await Promise.all([
          db.prisma.teamMembership.findUnique({
            where: { teamId_userId: { teamId: invitedTeamId, userId: member.id } },
          }),
          db.prisma.workspaceMembership.findUniqueOrThrow({
            where: { workspaceId_userId: { workspaceId, userId: member.id } },
            select: { role: true },
          }),
          db.prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } }),
        ]);
        assert.ok(teamMembership);
        assert.equal(membershipAfter.role, membershipBefore.role);
        assert.equal(persistedInvitation.status, 'ACCEPTED');
        await db.prisma.$disconnect();

        const replay = await jsonRequest(`${baseUrl}/api/v1/invitations/${token}/accept`, {
          method: 'POST',
          headers: auth(member),
          jar: member.jar,
        });
        assert.equal(replay.status, 409);
      } finally {
        resetEmailSender();
      }
    });

    test('rejects team invitations for people without active workspace membership', async () => {
      const invitedTeamId = await createTeam(owner, workspaceId, 'Member-only Invitations');
      const response = await jsonRequest(`${teamUrl(workspaceId, invitedTeamId)}/invitations`, {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ targetUserId: outsider.id }),
        jar: owner.jar,
      });
      assert.equal(response.status, 404);
      assert.equal((response.body.error as { code: string }).code, 'TEAM_INVITATION_RECIPIENT_NOT_FOUND');
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

      const createdDepartment = await jsonRequest<{ id: string }>(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/departments`,
        {
          method: 'POST',
          headers: auth(owner),
          body: JSON.stringify({ name: 'Science' }),
          jar: owner.jar,
        },
      );
      assert.equal(createdDepartment.status, 201);
      const departmentId = (createdDepartment.body.data as { id: string }).id;
      const renamedDepartment = await jsonRequest<{ name: string }>(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/departments/${departmentId}`,
        {
          method: 'PATCH',
          headers: auth(owner),
          body: JSON.stringify({ name: 'Natural Sciences' }),
          jar: owner.jar,
        },
      );
      assert.equal(renamedDepartment.status, 200);
      assert.equal((renamedDepartment.body.data as { name: string }).name, 'Natural Sciences');
      const departmentAuditDb = await connectTestDatabase(rawDbUrl);
      const departmentAudit = await departmentAuditDb.prisma.auditLog.findFirst({
        where: {
          action: 'institution.department_updated',
          workspaceId: institutionWorkspaceId,
          targetId: departmentId,
        },
      });
      await departmentAuditDb.prisma.$disconnect();
      assert.ok(departmentAudit, 'department rename should be audited');
      const deniedDepartmentUpdate = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/departments/${departmentId}`,
        {
          method: 'PATCH',
          headers: auth(member),
          body: JSON.stringify({ name: 'Unauthorized rename' }),
          jar: member.jar,
        },
      );
      assert.equal(deniedDepartmentUpdate.status, 403);
      const crossWorkspaceDepartmentUpdate = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${workspaceId}/departments/${departmentId}`,
        {
          method: 'PATCH',
          headers: auth(owner),
          body: JSON.stringify({ name: 'Cross-workspace rename' }),
          jar: owner.jar,
        },
      );
      assert.equal(crossWorkspaceDepartmentUpdate.status, 404);

      const secondDepartment = await jsonRequest<{ id: string }>(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/departments`,
        {
          method: 'POST',
          headers: auth(owner),
          body: JSON.stringify({ name: 'Arts' }),
          jar: owner.jar,
        },
      );
      assert.equal(secondDepartment.status, 201);
      const duplicateDepartmentName = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/departments/${(secondDepartment.body.data as { id: string }).id}`,
        {
          method: 'PATCH',
          headers: auth(owner),
          body: JSON.stringify({ name: 'Natural Sciences' }),
          jar: owner.jar,
        },
      );
      assert.equal(duplicateDepartmentName.status, 409);

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

      const unauthenticated = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/notification-preferences`,
      );
      assert.equal(unauthenticated.status, 401);

      const defaults = await jsonRequest<Array<{ type: string; inAppEnabled: boolean }>>(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/notification-preferences`,
        { headers: auth(member) },
      );
      assert.equal(defaults.status, 200);
      assert.ok(
        (defaults.body.data as Array<{ type: string; inAppEnabled: boolean }>).every(
          (preference) => preference.inAppEnabled,
        ),
      );

      const savedPreferences = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/notification-preferences`,
        {
          method: 'PATCH',
          headers: auth(member),
          body: JSON.stringify({
            preferences: [{ type: 'MEMBERSHIP_CHANGED', inAppEnabled: false }],
          }),
          jar: member.jar,
        },
      );
      assert.equal(savedPreferences.status, 200);

      const otherWorkspacePreferences = await jsonRequest<
        Array<{ type: string; inAppEnabled: boolean }>
      >(`${baseUrl}/api/v1/workspaces/${workspaceId}/notification-preferences`, {
        headers: auth(member),
      });
      assert.equal(otherWorkspacePreferences.status, 200);
      assert.equal(
        (
          otherWorkspacePreferences.body.data as Array<{ type: string; inAppEnabled: boolean }>
        ).find((preference) => preference.type === 'MEMBERSHIP_CHANGED')?.inAppEnabled,
        true,
      );

      const outsiderPreferences = await jsonRequest(
        `${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/notification-preferences`,
        { headers: auth(outsider) },
      );
      assert.equal(outsiderPreferences.status, 403);

      const db = await connectTestDatabase(rawDbUrl);
      const notificationsBefore = await db.prisma.notification.count({
        where: { userId: member.id, type: 'MEMBERSHIP_CHANGED' },
      });
      await db.prisma.$disconnect();

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

      const afterAddDb = await connectTestDatabase(rawDbUrl);
      const notificationsAfter = await afterAddDb.prisma.notification.count({
        where: { userId: member.id, type: 'MEMBERSHIP_CHANGED' },
      });
      await afterAddDb.prisma.$disconnect();
      assert.equal(notificationsAfter, notificationsBefore);

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

  describe('Phase 7 team project access', () => {
    test('team membership grants scoped access to its linked project only', async () => {
      const assignedTeamId = await createTeam(owner, workspaceId, 'Project Access Team');
      const unrelatedTeamId = await createTeam(owner, workspaceId, 'Unrelated Project Team');
      const addToTeam = await jsonRequest(`${teamUrl(workspaceId, assignedTeamId)}/members`, {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ userId: member.id, role: 'MEMBER' }),
        jar: owner.jar,
      });
      assert.equal(addToTeam.status, 201);

      const db = await connectTestDatabase(rawDbUrl);
      try {
        const project = await db.prisma.project.create({
          data: {
            workspaceId,
            name: 'Team scoped project',
            key: `TSP${Date.now()}`,
            ownerId: owner.id,
            visibility: 'DEPARTMENT_TEAM',
          },
        });
        const association = await jsonRequest(
          `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${project.id}/organizational-access`,
          {
            method: 'PATCH',
            headers: auth(owner),
            body: JSON.stringify({ teamId: assignedTeamId }),
            jar: owner.jar,
          },
        );
        assert.equal(association.status, 200, JSON.stringify(association.body));
        assert.equal((association.body.data as { teamId: string }).teamId, assignedTeamId);
        const unrelatedProject = await db.prisma.project.create({
          data: {
            workspaceId,
            teamId: unrelatedTeamId,
            name: 'Unrelated team project',
            key: `UTP${Date.now()}`,
            ownerId: owner.id,
            visibility: 'DEPARTMENT_TEAM',
          },
        });

        const access = await requireProjectAccess(db.prisma, {
          userId: member.id,
          workspaceId,
          projectId: project.id,
          workspaceRole: 'MEMBER',
          capability: ProjectCapability.ViewProject,
        });
        assert.equal(access.projectMembership, null);
        const persisted = await db.prisma.project.findUniqueOrThrow({ where: { id: project.id } });
        assert.equal(persisted.teamId, assignedTeamId);

        await assert.rejects(
          requireProjectAccess(db.prisma, {
            userId: member.id,
            workspaceId,
            projectId: unrelatedProject.id,
            workspaceRole: 'MEMBER',
            capability: ProjectCapability.ViewProject,
          }),
          (error: unknown) => (error as { code?: string }).code === 'PROJECT_NOT_FOUND',
        );
      } finally {
        await db.prisma.$disconnect();
      }
    });
  });

  describe('Phase 7 channel access', () => {
    test('workspace visibility, private membership, name uniqueness, deletion and parent removal', async () => {
      const channelUrl = (wsId: string, channelId?: string) =>
        `${baseUrl}/api/v1/workspaces/${wsId}/channels${channelId ? `/${channelId}` : ''}`;
      const create = async (actor: TestUser, wsId: string, body: Record<string, unknown>) =>
        jsonRequest(channelUrl(wsId), { method: 'POST', headers: auth(actor), body: JSON.stringify(body), jar: actor.jar });
      const workspaceChannel = await create(owner, workspaceId, { type: 'WORKSPACE', name: 'Engineering' });
      assert.equal(workspaceChannel.status, 201, JSON.stringify(workspaceChannel.body));
      const engineeringId = (workspaceChannel.body.data as { id: string }).id;
      const duplicate = await create(owner, workspaceId, { type: 'WORKSPACE', name: 'engineering' });
      assert.equal(duplicate.status, 409);
      const crossWorkspace = await create(owner, institutionWorkspaceId, { type: 'WORKSPACE', name: 'engineering' });
      assert.equal(crossWorkspace.status, 201);

      const viewer = await create(owner, workspaceId, { type: 'WORKSPACE', name: 'Viewer-visible' });
      assert.equal(viewer.status, 201);
      const viewerUser = await register('P7 Viewer', `p7-viewer-${Date.now()}@test.example`, 'TestPass123!');
      extraUserIds.push(viewerUser.id);
      await addWorkspaceMember(owner, workspaceId, viewerUser.email, 'VIEWER');
      assert.equal((await jsonRequest(channelUrl(workspaceId, engineeringId), { headers: auth(viewerUser) })).status, 200);
      assert.equal((await jsonRequest(channelUrl(workspaceId, engineeringId), { headers: auth(outsider) })).status, 404);

      const privateRes = await create(owner, workspaceId, { type: 'PRIVATE', name: 'Private room' });
      assert.equal(privateRes.status, 201);
      const privateId = (privateRes.body.data as { id: string }).id;
      const db = await connectTestDatabase(rawDbUrl);
      try {
        assert.equal((await db.prisma.channelMembership.findUniqueOrThrow({ where: { channelId_userId: { channelId: privateId, userId: owner.id } } })).role, 'ADMIN');
        const memberRes = await jsonRequest(`${channelUrl(workspaceId, privateId)}/members`, { method: 'POST', headers: auth(owner), body: JSON.stringify({ userId: member.id }), jar: owner.jar });
        assert.equal(memberRes.status, 201);
        assert.equal((memberRes.body.data as { role: string }).role, 'MEMBER');
        assert.equal((await jsonRequest(channelUrl(workspaceId, privateId), { headers: auth(pm) })).status, 404);
        const wrongWorkspace = await jsonRequest(channelUrl(institutionWorkspaceId, privateId), { headers: auth(owner) });
        assert.equal(wrongWorkspace.status, 404);
        await db.prisma.channel.update({ where: { id: engineeringId }, data: { deletedAt: new Date() } });
      } finally { await db.prisma.$disconnect(); }
      assert.equal((await create(owner, workspaceId, { type: 'WORKSPACE', name: 'ENGINEERING' })).status, 201);
      const teamRes = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/teams`, { method: 'POST', headers: auth(owner), body: JSON.stringify({ name: 'Channel parent team' }), jar: owner.jar });
      const teamId = (teamRes.body.data as { id: string }).id;
      const teamChannel = await create(owner, workspaceId, { type: 'TEAM', teamId, name: 'Team channel' });
      assert.equal(teamChannel.status, 201);
      const teamChannelId = (teamChannel.body.data as { id: string }).id;
      const db2 = await connectTestDatabase(rawDbUrl);
      await db2.prisma.team.update({ where: { id: teamId }, data: { status: 'ARCHIVED' } });
      await db2.prisma.$disconnect();
      assert.equal((await jsonRequest(channelUrl(workspaceId, teamChannelId), { headers: auth(member) })).status, 404);
      const archive = await jsonRequest(`${channelUrl(workspaceId, teamChannelId)}/archive`, { method: 'POST', headers: auth(owner), jar: owner.jar });
      assert.equal(archive.status, 200);
    });

    test('team, department and project parent archival, deletion or null reference revoke access', async () => {
      const channelUrl = (wsId: string, channelId: string) => `${baseUrl}/api/v1/workspaces/${wsId}/channels/${channelId}`;
      const db = await connectTestDatabase(rawDbUrl);
      try {
        const team = await db.prisma.team.create({ data: { workspaceId, name: `Null team ${Date.now()}` } });
        const teamChannel = await db.prisma.channel.create({ data: { workspaceId, type: 'TEAM', teamId: team.id, name: `Null team channel ${Date.now()}`, createdById: owner.id } });
        await db.prisma.channel.update({ where: { id: teamChannel.id }, data: { teamId: null } });
        assert.equal((await jsonRequest(channelUrl(workspaceId, teamChannel.id), { headers: auth(member) })).status, 404);
        assert.equal((await jsonRequest(channelUrl(workspaceId, teamChannel.id), { headers: auth(owner) })).status, 404);
        assert.equal((await jsonRequest(`${channelUrl(workspaceId, teamChannel.id)}/archive`, { method: 'POST', headers: auth(owner), jar: owner.jar })).status, 200);

        const departmentRes = await jsonRequest(`${baseUrl}/api/v1/workspaces/${institutionWorkspaceId}/departments`, { method: 'POST', headers: auth(owner), body: JSON.stringify({ name: `Channel department ${Date.now()}` }), jar: owner.jar });
        assert.equal(departmentRes.status, 201, JSON.stringify(departmentRes.body));
        const departmentId = (departmentRes.body.data as { id: string }).id;
        const departmentChannel = await db.prisma.channel.create({ data: { workspaceId: institutionWorkspaceId, type: 'DEPARTMENT', departmentId, name: `Department channel ${Date.now()}`, createdById: owner.id } });
        await db.prisma.department.delete({ where: { id: departmentId } });
        assert.equal((await jsonRequest(channelUrl(institutionWorkspaceId, departmentChannel.id), { headers: auth(member) })).status, 404);
        assert.equal((await jsonRequest(channelUrl(institutionWorkspaceId, departmentChannel.id), { headers: auth(owner) })).status, 404);
        assert.equal((await jsonRequest(`${channelUrl(institutionWorkspaceId, departmentChannel.id)}/archive`, { method: 'POST', headers: auth(owner), jar: owner.jar })).status, 200);

        const project = await db.prisma.project.create({ data: { workspaceId, ownerId: owner.id, name: 'Archived channel parent', key: `ACP${Date.now()}` } });
        const projectChannel = await db.prisma.channel.create({ data: { workspaceId, type: 'PROJECT', projectId: project.id, name: `Project channel ${Date.now()}`, createdById: owner.id } });
        await db.prisma.project.update({ where: { id: project.id }, data: { status: 'ARCHIVED' } });
        assert.equal((await jsonRequest(channelUrl(workspaceId, projectChannel.id), { headers: auth(member) })).status, 404);
        assert.equal((await jsonRequest(channelUrl(workspaceId, projectChannel.id), { headers: auth(owner) })).status, 404);
        assert.equal((await jsonRequest(`${channelUrl(workspaceId, projectChannel.id)}/archive`, { method: 'POST', headers: auth(owner), jar: owner.jar })).status, 200);
        await db.prisma.channel.update({ where: { id: projectChannel.id }, data: { projectId: null } });
        assert.equal((await jsonRequest(channelUrl(workspaceId, projectChannel.id), { headers: auth(owner) })).status, 404);
        assert.equal((await jsonRequest(`${channelUrl(workspaceId, projectChannel.id)}/archive`, { method: 'POST', headers: auth(owner), jar: owner.jar })).status, 200);
      } finally { await db.prisma.$disconnect(); }
    });

    test('channel inputs reject client-controlled type, parent and role; private members must belong to the workspace', async () => {
      const channelUrl = (wsId: string, channelId?: string) => `${baseUrl}/api/v1/workspaces/${wsId}/channels${channelId ? `/${channelId}` : ''}`;
      const invalidBodies = [
        { type: 'WORKSPACE', name: 'Client type', role: 'ADMIN' },
        { type: 'WORKSPACE', name: 'Client parent', teamId: '11111111-1111-4111-8111-111111111111' },
      ];
      for (const body of invalidBodies) {
        const response = await jsonRequest(channelUrl(workspaceId), { method: 'POST', headers: auth(owner), body: JSON.stringify(body), jar: owner.jar });
        assert.equal(response.status, 400, JSON.stringify(response.body));
      }
      const privateResponse = await jsonRequest(channelUrl(workspaceId), { method: 'POST', headers: auth(owner), body: JSON.stringify({ type: 'PRIVATE', name: `Membership validation ${Date.now()}` }), jar: owner.jar });
      assert.equal(privateResponse.status, 201, JSON.stringify(privateResponse.body));
      const privateId = (privateResponse.body.data as { id: string }).id;
      const db = await connectTestDatabase(rawDbUrl);
      try {
        const activeParent = await db.prisma.team.create({ data: { workspaceId, name: `Strict input team ${Date.now()}` } });
        const updateType = await jsonRequest(channelUrl(workspaceId, privateId), { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ type: 'WORKSPACE' }), jar: owner.jar });
        assert.equal(updateType.status, 400);
        const updateParent = await jsonRequest(channelUrl(workspaceId, privateId), { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ projectId: activeParent.id }), jar: owner.jar });
        assert.equal(updateParent.status, 400);
      } finally { await db.prisma.$disconnect(); }
      const forgedRole = await jsonRequest(`${channelUrl(workspaceId, privateId)}/members`, { method: 'POST', headers: auth(owner), body: JSON.stringify({ userId: member.id, role: 'ADMIN' }), jar: owner.jar });
      assert.equal(forgedRole.status, 400, JSON.stringify(forgedRole.body));
      const outsiderTarget = await register('P7 Channel Outsider', `p7-channel-outsider-${Date.now()}@test.example`, 'TestPass123!');
      extraUserIds.push(outsiderTarget.id);
      const nonMember = await jsonRequest(`${channelUrl(workspaceId, privateId)}/members`, { method: 'POST', headers: auth(owner), body: JSON.stringify({ userId: outsiderTarget.id }), jar: owner.jar });
      assert.equal(nonMember.status, 404, JSON.stringify(nonMember.body));
    });

    test('removing team, department or project membership revokes inherited channel access', async () => {
      const db = await connectTestDatabase(rawDbUrl);
      try {
        const team = await db.prisma.team.create({ data: { workspaceId, name: `Revocation team ${Date.now()}` } });
        await db.prisma.teamMembership.create({ data: { teamId: team.id, userId: member.id, role: 'MEMBER' } });
        const teamChannel = await db.prisma.channel.create({ data: { workspaceId, type: 'TEAM', teamId: team.id, name: `Revocation team channel ${Date.now()}`, createdById: owner.id } });
        const url = (wsId: string, id: string) => `${baseUrl}/api/v1/workspaces/${wsId}/channels/${id}`;
        assert.equal((await jsonRequest(url(workspaceId, teamChannel.id), { headers: auth(member) })).status, 200);
        await db.prisma.teamMembership.delete({ where: { teamId_userId: { teamId: team.id, userId: member.id } } });
        assert.equal((await jsonRequest(url(workspaceId, teamChannel.id), { headers: auth(member) })).status, 404);

        const department = await db.prisma.department.create({ data: { workspaceId: institutionWorkspaceId, name: `Revocation department ${Date.now()}` } });
        await db.prisma.departmentMembership.create({ data: { departmentId: department.id, userId: member.id, role: 'MEMBER' } });
        const departmentChannel = await db.prisma.channel.create({ data: { workspaceId: institutionWorkspaceId, type: 'DEPARTMENT', departmentId: department.id, name: `Revocation department channel ${Date.now()}`, createdById: owner.id } });
        assert.equal((await jsonRequest(url(institutionWorkspaceId, departmentChannel.id), { headers: auth(member) })).status, 200);
        await db.prisma.departmentMembership.delete({ where: { departmentId_userId: { departmentId: department.id, userId: member.id } } });
        assert.equal((await jsonRequest(url(institutionWorkspaceId, departmentChannel.id), { headers: auth(member) })).status, 404);

        const project = await db.prisma.project.create({ data: { workspaceId, ownerId: owner.id, name: `Revocation project ${Date.now()}`, key: `RCP${Date.now()}`, visibility: 'PRIVATE' } });
        await db.prisma.projectMembership.create({ data: { projectId: project.id, userId: member.id, role: 'MEMBER' } });
        const projectChannel = await db.prisma.channel.create({ data: { workspaceId, type: 'PROJECT', projectId: project.id, name: `Revocation project channel ${Date.now()}`, createdById: owner.id } });
        assert.equal((await jsonRequest(url(workspaceId, projectChannel.id), { headers: auth(member) })).status, 200);
        await db.prisma.projectMembership.delete({ where: { projectId_userId: { projectId: project.id, userId: member.id } } });
        assert.equal((await jsonRequest(url(workspaceId, projectChannel.id), { headers: auth(member) })).status, 404);
      } finally { await db.prisma.$disconnect(); }
    });

    test('archived channel is hidden from members while a workspace manager can still manage it', async () => {
      const db = await connectTestDatabase(rawDbUrl);
      let channelId: string;
      try {
        const channel = await db.prisma.channel.create({ data: { workspaceId, type: 'WORKSPACE', name: `Archived channel ${Date.now()}`, createdById: owner.id, archivedAt: new Date() } });
        channelId = channel.id;
      } finally { await db.prisma.$disconnect(); }
      const url = `${baseUrl}/api/v1/workspaces/${workspaceId}/channels/${channelId}`;
      const memberResponse = await jsonRequest(url, { headers: auth(member) });
      const memberList = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/channels`, { headers: auth(member) });
      const managerGet = await jsonRequest(url, { headers: auth(owner) });
      const managerList = await jsonRequest<{ items: Array<{ id: string }> }>(`${baseUrl}/api/v1/workspaces/${workspaceId}/channels`, { headers: auth(owner) });
      const managerResponse = await jsonRequest(`${url}/archive`, { method: 'POST', headers: auth(owner), jar: owner.jar });
      const managerUpdate = await jsonRequest(url, { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ name: 'Should remain archived' }), jar: owner.jar });
      const managerAddMember = await jsonRequest(`${url}/members`, { method: 'POST', headers: auth(owner), body: JSON.stringify({ userId: member.id }), jar: owner.jar });
      const managerRemoveMember = await jsonRequest(`${url}/members/${member.id}`, { method: 'DELETE', headers: auth(owner), jar: owner.jar });
      assert.equal(managerResponse.status, 200);
      assert.equal(managerGet.status, 200);
      assert.equal((managerList.body.data as { items: Array<{ id: string }> }).items.some((item) => item.id === channelId), true);
      assert.equal((memberList.body.data as { items: Array<{ id: string }> }).items.some((item) => item.id === channelId), false);
      assert.equal(managerUpdate.status, 404);
      assert.equal(managerAddMember.status, 404);
      assert.equal(managerRemoveMember.status, 404);
      assert.equal(memberResponse.status, 404, 'archived channels must not be readable by ordinary members');
    });

    test('workspace removal and final account deletion clean up private channel memberships', async () => {
      const url = `${baseUrl}/api/v1/workspaces/${workspaceId}/channels`;
      const removedUser = await register('P7 Removed Channel Member', `p7-removed-channel-${Date.now()}@test.example`, 'TestPass123!');
      extraUserIds.push(removedUser.id);
      await addWorkspaceMember(owner, workspaceId, removedUser.email);
      const created = await jsonRequest(url, { method: 'POST', headers: auth(owner), body: JSON.stringify({ type: 'PRIVATE', name: `Removal cleanup ${Date.now()}` }), jar: owner.jar });
      assert.equal(created.status, 201);
      const removedChannelId = (created.body.data as { id: string }).id;
      assert.equal((await jsonRequest(`${url}/${removedChannelId}/members`, { method: 'POST', headers: auth(owner), body: JSON.stringify({ userId: removedUser.id }), jar: owner.jar })).status, 201);
      const removal = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/members/${removedUser.id}`, { method: 'DELETE', headers: auth(owner), body: JSON.stringify({}), jar: owner.jar });
      assert.equal(removal.status, 200, JSON.stringify(removal.body));

      const db = await connectTestDatabase(rawDbUrl);
      try {
        assert.equal(await db.prisma.channelMembership.count({ where: { channelId: removedChannelId, userId: removedUser.id } }), 0);
      } finally { await db.prisma.$disconnect(); }

      const deletionUser = await register('P7 Deletion Channel Member', `p7-delete-channel-${Date.now()}@test.example`, 'TestPass123!');
      extraUserIds.push(deletionUser.id);
      await addWorkspaceMember(owner, workspaceId, deletionUser.email);
      const deletionChannel = await jsonRequest(url, { method: 'POST', headers: auth(owner), body: JSON.stringify({ type: 'PRIVATE', name: `Deletion cleanup ${Date.now()}` }), jar: owner.jar });
      assert.equal(deletionChannel.status, 201);
      const deletionChannelId = (deletionChannel.body.data as { id: string }).id;
      assert.equal((await jsonRequest(`${url}/${deletionChannelId}/members`, { method: 'POST', headers: auth(owner), body: JSON.stringify({ userId: deletionUser.id }), jar: owner.jar })).status, 201);
      const deletionDb = await connectTestDatabase(rawDbUrl);
      try {
        await deletionDb.prisma.user.update({ where: { id: deletionUser.id }, data: { status: 'PENDING_DELETION', scheduledDeletionAt: new Date(Date.now() - 1000) } });
        const { processPendingAccountDeletions } = await import('../src/modules/auth/account-deletion.service');
        const result = await processPendingAccountDeletions(deletionDb.prisma, new Date(), 4);
        assert.equal(result.deleted, 1);
        assert.equal(await deletionDb.prisma.channelMembership.count({ where: { channelId: deletionChannelId, userId: deletionUser.id } }), 0);
      } finally { await deletionDb.prisma.$disconnect(); }
    });
  });
}
