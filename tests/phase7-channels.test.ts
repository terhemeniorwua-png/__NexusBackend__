import assert from 'node:assert/strict';
import test from 'node:test';
import type { Channel, PrismaClient } from '@prisma/client';
import { ChannelCapability, requireChannelAccess } from '../src/modules/authorization/channel.policy';

const userId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const channelId = '33333333-3333-4333-8333-333333333333';
const parentId = '44444444-4444-4444-8444-444444444444';

function fixture(input: {
  type: Channel['type']; role?: 'OWNER'|'PROJECT_MANAGER'|'MEMBER'|'VIEWER'|'COLLABORATOR';
  organizationRole?: string | null; teamRole?: string | null; departmentRole?: string | null;
  projectRole?: string | null; privateRole?: 'ADMIN'|'MEMBER'|null; parentActive?: boolean;
  archived?: boolean;
}): PrismaClient {
  const channel = { id: channelId, workspaceId, type: input.type, name: 'Channel', description: null,
    teamId: input.type === 'TEAM' ? parentId : null, departmentId: input.type === 'DEPARTMENT' ? parentId : null,
    projectId: input.type === 'PROJECT' ? parentId : null, createdById: userId,
    archivedAt: input.archived ? new Date() : null, deletedAt: null, createdAt: new Date(), updatedAt: new Date() };
  const membership = { status: 'ACTIVE', role: input.role ?? 'MEMBER', organizationRole: input.organizationRole ?? null,
    workspace: { type: input.type === 'DEPARTMENT' ? 'INSTITUTION' : input.organizationRole?.startsWith('COMPANY') ? 'COMPANY' : 'INDIVIDUAL' } };
  const active = input.parentActive !== false;
  const project = { id: parentId, workspaceId, ownerId: 'other-user', visibility: 'PRIVATE', deletedAt: null, status: active ? 'ACTIVE' : 'ARCHIVED' };
  const fake = {
    channel: { findFirst: async () => channel },
    workspaceMembership: { findUnique: async () => membership },
    channelMembership: { findUnique: async () => input.privateRole ? { role: input.privateRole } : null },
    team: { findFirst: async () => active ? { leadId: input.teamRole === 'TEAM_LEAD' ? userId : null } : null },
    teamMembership: { findUnique: async () => input.teamRole ? { role: input.teamRole } : null },
    department: { findFirst: async () => active ? { id: parentId, members: input.departmentRole ? [{ id: parentId }] : [] } : null },
    departmentMembership: { findUnique: async () => input.departmentRole ? { role: input.departmentRole } : null },
    project: { findFirst: async () => input.type === 'PROJECT' && active ? project : null },
    projectMembership: { findUnique: async () => input.projectRole ? { role: input.projectRole } : null },
  };
  return fake as unknown as PrismaClient;
}

type RoleFixture = Omit<Parameters<typeof fixture>[0], 'type'>;

async function allowed(type: Channel['type'], capability: (typeof ChannelCapability)[keyof typeof ChannelCapability], roles: RoleFixture = {}) {
  return requireChannelAccess(fixture({ type, ...roles }), { userId, workspaceId, channelId, capability });
}
async function denied(type: Channel['type'], capability: (typeof ChannelCapability)[keyof typeof ChannelCapability], roles: RoleFixture = {}) {
  await assert.rejects(allowed(type, capability, roles), (error: unknown) => Boolean(error && typeof error === 'object' && 'statusCode' in error));
}

test('channel policy covers allowed and denied access for each channel type', async (t) => {
  await t.test('capability matrix: workspace channels', async () => {
    for (const role of ['OWNER', 'PROJECT_MANAGER', 'MEMBER', 'VIEWER'] as const) {
      await allowed('WORKSPACE', ChannelCapability.View, { role });
    }
    await denied('WORKSPACE', ChannelCapability.View, { role: 'COLLABORATOR' });
    for (const capability of [ChannelCapability.Update, ChannelCapability.Archive, ChannelCapability.Delete, ChannelCapability.AddMember, ChannelCapability.RemoveMember]) {
      await allowed('WORKSPACE', capability, { role: 'OWNER' });
      await allowed('WORKSPACE', capability, { role: 'PROJECT_MANAGER' });
      await denied('WORKSPACE', capability, { role: 'MEMBER' });
      await denied('WORKSPACE', capability, { role: 'VIEWER' });
      await denied('WORKSPACE', capability, { role: 'COLLABORATOR' });
    }
  });
  await t.test('capability matrix: team channels', async () => {
    await allowed('TEAM', ChannelCapability.View, { teamRole: 'MEMBER' });
    await allowed('TEAM', ChannelCapability.View, { role: 'OWNER' });
    await denied('TEAM', ChannelCapability.View, { role: 'MEMBER' });
    for (const capability of [ChannelCapability.Update, ChannelCapability.Archive, ChannelCapability.AddMember, ChannelCapability.RemoveMember]) {
      await allowed('TEAM', capability, { teamRole: 'TEAM_LEAD' });
      await denied('TEAM', capability, { teamRole: 'MEMBER' });
      await allowed('TEAM', capability, { role: 'OWNER' });
      await allowed('TEAM', capability, { role: 'PROJECT_MANAGER' });
    }
    await denied('TEAM', ChannelCapability.Delete, { teamRole: 'TEAM_LEAD' });
    await allowed('TEAM', ChannelCapability.Delete, { role: 'OWNER' });
  });
  await t.test('capability matrix: department channels', async () => {
    await allowed('DEPARTMENT', ChannelCapability.View, { departmentRole: 'MEMBER' });
    await allowed('DEPARTMENT', ChannelCapability.View, { role: 'OWNER' });
    await denied('DEPARTMENT', ChannelCapability.View, { role: 'MEMBER' });
    for (const capability of [ChannelCapability.Update, ChannelCapability.Archive, ChannelCapability.AddMember, ChannelCapability.RemoveMember]) {
      await allowed('DEPARTMENT', capability, { role: 'MEMBER', organizationRole: 'INSTITUTION_DEPARTMENT_HEAD', departmentRole: 'HEAD' });
      await denied('DEPARTMENT', capability, { departmentRole: 'MEMBER' });
      await allowed('DEPARTMENT', capability, { role: 'OWNER' });
      await allowed('DEPARTMENT', capability, { role: 'PROJECT_MANAGER' });
    }
    await denied('DEPARTMENT', ChannelCapability.Delete, { organizationRole: 'INSTITUTION_DEPARTMENT_HEAD', departmentRole: 'HEAD' });
    await allowed('DEPARTMENT', ChannelCapability.Delete, { role: 'OWNER' });
  });
  await t.test('capability matrix: project channels', async () => {
    await allowed('PROJECT', ChannelCapability.View, { projectRole: 'MEMBER' });
    await allowed('PROJECT', ChannelCapability.View, { role: 'OWNER' });
    await denied('PROJECT', ChannelCapability.View, { role: 'MEMBER' });
    for (const capability of [ChannelCapability.Update, ChannelCapability.Archive, ChannelCapability.AddMember, ChannelCapability.RemoveMember, ChannelCapability.Delete]) {
      await allowed('PROJECT', capability, { role: 'OWNER' });
      await allowed('PROJECT', capability, { role: 'PROJECT_MANAGER' });
      await denied('PROJECT', capability, { projectRole: 'MEMBER' });
    }
  });
  await t.test('capability matrix: private channels', async () => {
    await allowed('PRIVATE', ChannelCapability.View, { privateRole: 'ADMIN' });
    await allowed('PRIVATE', ChannelCapability.View, { privateRole: 'MEMBER' });
    await denied('PRIVATE', ChannelCapability.View, { role: 'OWNER' });
    await denied('PRIVATE', ChannelCapability.View, { role: 'PROJECT_MANAGER' });
    await denied('PRIVATE', ChannelCapability.View, { organizationRole: 'COMPANY_ADMIN' });
    for (const capability of [ChannelCapability.Update, ChannelCapability.Archive, ChannelCapability.AddMember, ChannelCapability.RemoveMember]) {
      await allowed('PRIVATE', capability, { privateRole: 'ADMIN' });
      await denied('PRIVATE', capability, { privateRole: 'MEMBER' });
      await allowed('PRIVATE', capability, { role: 'OWNER' });
      await allowed('PRIVATE', capability, { role: 'PROJECT_MANAGER' });
    }
    await denied('PRIVATE', ChannelCapability.Delete, { privateRole: 'ADMIN' });
    await denied('PRIVATE', ChannelCapability.Delete, { privateRole: 'MEMBER' });
    await allowed('PRIVATE', ChannelCapability.Delete, { role: 'OWNER' });
  });
  await t.test('WORKSPACE: active members and viewers may view; collaborators may not; members cannot update', async () => {
    await allowed('WORKSPACE', ChannelCapability.View, { role: 'MEMBER' });
    await allowed('WORKSPACE', ChannelCapability.View, { role: 'VIEWER' });
    await denied('WORKSPACE', ChannelCapability.View, { role: 'COLLABORATOR' });
    await denied('WORKSPACE', ChannelCapability.Update, { role: 'MEMBER' });
  });
  await t.test('TEAM: active team members view; team leads update; nonmembers and ordinary members are denied', async () => {
    await allowed('TEAM', ChannelCapability.View, { teamRole: 'MEMBER' });
    await denied('TEAM', ChannelCapability.View);
    await allowed('TEAM', ChannelCapability.Update, { teamRole: 'TEAM_LEAD' });
    await denied('TEAM', ChannelCapability.Update, { teamRole: 'MEMBER' });
  });
  await t.test('DEPARTMENT: department members view; heads update; unassigned members are denied', async () => {
    await allowed('DEPARTMENT', ChannelCapability.View, { departmentRole: 'MEMBER' });
    await denied('DEPARTMENT', ChannelCapability.View);
    await allowed('DEPARTMENT', ChannelCapability.Update, { organizationRole: 'INSTITUTION_DEPARTMENT_HEAD', departmentRole: 'HEAD' });
    await denied('DEPARTMENT', ChannelCapability.Update, { departmentRole: 'MEMBER' });
  });
  await t.test('PROJECT: project members view; viewers cannot update; nonmembers are denied', async () => {
    await allowed('PROJECT', ChannelCapability.View, { projectRole: 'MEMBER' });
    await denied('PROJECT', ChannelCapability.View);
    await denied('PROJECT', ChannelCapability.Update, { projectRole: 'VIEWER' });
  });
  await t.test('PRIVATE: explicit members read; ADMIN manages; MEMBER and nonmembers cannot manage/read', async () => {
    await allowed('PRIVATE', ChannelCapability.View, { privateRole: 'MEMBER' });
    await allowed('PRIVATE', ChannelCapability.Update, { privateRole: 'ADMIN' });
    await allowed('PRIVATE', ChannelCapability.AddMember, { privateRole: 'ADMIN' });
    await allowed('PRIVATE', ChannelCapability.RemoveMember, { privateRole: 'ADMIN' });
    await denied('PRIVATE', ChannelCapability.View);
    await denied('PRIVATE', ChannelCapability.Update, { privateRole: 'MEMBER' });
  });
  await t.test('organization admins cannot read PRIVATE without explicit channel membership', async () => {
    await denied('PRIVATE', ChannelCapability.View, { role: 'PROJECT_MANAGER', organizationRole: 'COMPANY_ADMIN' });
  });
});

test('archived channel policy hides channels from non-managers and limits manager actions', async (t) => {
  for (const type of ['WORKSPACE', 'TEAM', 'DEPARTMENT', 'PROJECT', 'PRIVATE'] as const) {
    await t.test(`${type} channels`, async () => {
      const nonManager: RoleFixture = type === 'TEAM' ? { teamRole: 'MEMBER' }
        : type === 'DEPARTMENT' ? { departmentRole: 'MEMBER' }
        : type === 'PROJECT' ? { projectRole: 'MEMBER' }
        : type === 'PRIVATE' ? { privateRole: 'ADMIN' } : { role: 'VIEWER' };
      for (const capability of [ChannelCapability.View, ChannelCapability.Update, ChannelCapability.Archive, ChannelCapability.Delete, ChannelCapability.AddMember, ChannelCapability.RemoveMember]) {
        await assert.rejects(
          requireChannelAccess(fixture({ type, archived: true, ...nonManager }), { userId, workspaceId, channelId, capability }),
          (error: unknown) => Boolean(error && typeof error === 'object' && 'statusCode' in error && (error as { statusCode: number }).statusCode === 404),
        );
      }
      if (type === 'PRIVATE') {
        // Workspace managers cannot bypass the explicit PRIVATE membership rule.
        await denied('PRIVATE', ChannelCapability.View, { role: 'PROJECT_MANAGER', archived: true });
        return;
      }
      const manager = { role: 'MEMBER' as const, organizationRole: type === 'DEPARTMENT' ? 'INSTITUTION_ADMIN' : 'COMPANY_ADMIN', archived: true };
      await allowed(type, ChannelCapability.View, manager);
      await allowed(type, ChannelCapability.Archive, manager);
      await allowed(type, ChannelCapability.Delete, manager);
      for (const capability of [ChannelCapability.Update, ChannelCapability.AddMember, ChannelCapability.RemoveMember]) {
        await denied(type, capability, manager);
      }
    });
  }
});
