import type { Channel, ChannelMembership, PrismaClient, WorkspaceRole } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { ProjectCapability, requireProjectAccess } from './project.policy';
import { effectiveWorkspaceRole, isOrganizationRoleForWorkspace } from './organization-role';

export const ChannelCapability = {
  View: 'channel:view', Create: 'channel:create', Update: 'channel:update',
  Archive: 'channel:archive', Delete: 'channel:delete', AddMember: 'channel:add_member',
  RemoveMember: 'channel:remove_member',
} as const;
export type ChannelCapabilityValue = (typeof ChannelCapability)[keyof typeof ChannelCapability];
export interface ChannelAccess { channel: Channel; membership: ChannelMembership | null; workspaceRole: WorkspaceRole }

export async function requireChannelAccess(client: PrismaClient, input: {
  userId: string; workspaceId: string; channelId: string; capability: ChannelCapabilityValue;
}): Promise<ChannelAccess> {
  const channel = await client.channel.findFirst({ where: { id: input.channelId, workspaceId: input.workspaceId, deletedAt: null } });
  if (!channel) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'That channel does not exist');
  const wm = await client.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } }, include: { workspace: { select: { type: true } } } });
  if (!wm || wm.status !== 'ACTIVE') throw new AppError(404, 'CHANNEL_NOT_FOUND', 'That channel does not exist');
  if (wm.organizationRole && !isOrganizationRoleForWorkspace(wm.workspace.type, wm.organizationRole)) throw new AppError(403, 'ORGANIZATION_ROLE_WORKSPACE_MISMATCH', 'The organization role is invalid');
  const workspaceRole = effectiveWorkspaceRole(wm.workspace.type, wm.role, wm.organizationRole);
  const manager = workspaceRole === 'OWNER' || workspaceRole === 'PROJECT_MANAGER';
  if (channel.archivedAt) {
    const managerCapabilities: ChannelCapabilityValue[] = [ChannelCapability.View, ChannelCapability.Archive, ChannelCapability.Delete];
    if (!manager || !managerCapabilities.includes(input.capability)) {
      throw new AppError(404, 'CHANNEL_NOT_FOUND', 'That channel does not exist');
    }
  }
  const implicitLegacyManager = manager && !wm.organizationRole;
  const manageCaps = [ChannelCapability.Update, ChannelCapability.Archive, ChannelCapability.Delete, ChannelCapability.AddMember, ChannelCapability.RemoveMember] as string[];
  const parent = await parentState(client, channel, input.userId);
  const inaccessibleParent = channel.type !== 'WORKSPACE' && channel.type !== 'PRIVATE' && !parent.active;
  if (inaccessibleParent && !(manager && [ChannelCapability.Archive, ChannelCapability.Delete].includes(input.capability as never))) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'That channel does not exist');
  let membership: ChannelMembership | null = null;
  if (channel.type === 'PRIVATE') {
    membership = await client.channelMembership.findUnique({ where: { channelId_userId: { channelId: channel.id, userId: input.userId } } });
    if (input.capability === ChannelCapability.View && !membership) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'That channel does not exist');
    if ([ChannelCapability.AddMember, ChannelCapability.RemoveMember].includes(input.capability as never) && membership?.role !== 'ADMIN' && !manager) throw new AppError(403, 'CHANNEL_ACCESS_DENIED', 'Channel administration is required');
    if (input.capability === ChannelCapability.Update && membership?.role !== 'ADMIN' && !manager) throw new AppError(403, 'CHANNEL_ACCESS_DENIED', 'Channel administration is required');
    if (input.capability === ChannelCapability.Archive && membership?.role !== 'ADMIN' && !manager) throw new AppError(403, 'CHANNEL_ACCESS_DENIED', 'Channel administration is required');
  } else if (input.capability === ChannelCapability.View && !manager) {
    if (channel.type === 'WORKSPACE') {
      if (workspaceRole === 'COLLABORATOR') throw new AppError(403, 'CHANNEL_ACCESS_DENIED', 'Collaborators cannot view workspace channels');
    } else if (channel.type === 'TEAM') {
      const tm = await client.teamMembership.findUnique({ where: { teamId_userId: { teamId: channel.teamId!, userId: input.userId } } });
      if (!implicitLegacyManager && !tm) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'That channel does not exist');
    } else if (channel.type === 'DEPARTMENT') {
      const dm = await client.departmentMembership.findUnique({ where: { departmentId_userId: { departmentId: channel.departmentId!, userId: input.userId } } });
      if (!manager && !dm) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'That channel does not exist');
    } else if (channel.type === 'PROJECT') {
      await requireProjectAccess(client, { userId: input.userId, workspaceId: input.workspaceId, projectId: channel.projectId!, workspaceRole: wm.role, capability: ProjectCapability.ViewProject });
    }
  }
  if (manageCaps.includes(input.capability)) {
    const scopedAdmin = (channel.type === 'TEAM' && wm.organizationRole !== 'INSTITUTION_DEPARTMENT_HEAD' && parent.leadId === input.userId) || (channel.type === 'DEPARTMENT' && wm.organizationRole === 'INSTITUTION_DEPARTMENT_HEAD' && parent.head === true);
    if (input.capability === ChannelCapability.Delete && !manager) throw new AppError(403, 'CHANNEL_ACCESS_DENIED', 'Only workspace managers can delete channels');
    if (!manager && channel.type === 'TEAM' && !scopedAdmin) throw new AppError(403, 'CHANNEL_ACCESS_DENIED', 'Team lead access is required');
    if (!manager && channel.type === 'DEPARTMENT' && !scopedAdmin) throw new AppError(403, 'CHANNEL_ACCESS_DENIED', 'Department head access is required');
    if (!manager && channel.type === 'PROJECT') throw new AppError(403, 'CHANNEL_ACCESS_DENIED', 'Workspace managers manage project channels');
    if (!manager && channel.type === 'WORKSPACE') throw new AppError(403, 'CHANNEL_ACCESS_DENIED', 'Workspace managers manage workspace channels');
  }
  return { channel, membership, workspaceRole };
}

async function parentState(client: PrismaClient, channel: Channel, userId: string): Promise<{ active: boolean; leadId?: string | null; head?: boolean }> {
  if (channel.type === 'TEAM') {
    if (!channel.teamId) return { active: false };
    const row = await client.team.findFirst({ where: { id: channel.teamId, workspaceId: channel.workspaceId, status: 'ACTIVE', deletedAt: null }, select: { leadId: true } });
    return { active: Boolean(row), leadId: row?.leadId };
  }
  if (channel.type === 'DEPARTMENT') {
    if (!channel.departmentId) return { active: false };
    const row = await client.department.findFirst({ where: { id: channel.departmentId, workspaceId: channel.workspaceId }, select: { members: { where: { userId, role: 'HEAD' }, select: { id: true }, take: 1 } } });
    return { active: Boolean(row), head: Boolean(row?.members.length) };
  }
  if (channel.type === 'PROJECT') {
    if (!channel.projectId) return { active: false };
    const row = await client.project.findFirst({ where: { id: channel.projectId, workspaceId: channel.workspaceId, deletedAt: null, status: { not: 'ARCHIVED' } }, select: { id: true } });
    return { active: Boolean(row) };
  }
  return { active: true };
}
