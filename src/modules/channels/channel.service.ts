import type { Channel, ChannelType, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { ChannelAuditAction, recordAuditEvent } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { AppError } from '../../utils/errors';
import { ChannelCapability, requireChannelAccess } from '../authorization/channel.policy';
import { DepartmentCapability, requireDepartmentAccess } from '../authorization/department.policy';
import { TeamCapability, requireTeamAccess } from '../authorization/team.policy';
import { WorkspaceCapability, requireWorkspaceAccess } from '../authorization/workspace.policy';
import type { RequestContext } from '../auth/auth.types';

type Input = { userId: string; workspaceId: string };
type CreateInput = Input & { type: ChannelType; name: string; description?: string | null; teamId?: string; departmentId?: string; projectId?: string };
const shape = { _count: { select: { memberships: true } } } as const;
function summary(row: Channel & { _count: { memberships: number } }) {
  return { id: row.id, workspaceId: row.workspaceId, type: row.type, name: row.name, description: row.description,
    teamId: row.teamId, departmentId: row.departmentId, projectId: row.projectId,
    archivedAt: row.archivedAt, createdAt: row.createdAt, updatedAt: row.updatedAt,
    memberCount: row.type === 'PRIVATE' ? row._count.memberships : null };
}
function validateParent(type: ChannelType, i: CreateInput) {
  const count = Number(Boolean(i.teamId)) + Number(Boolean(i.departmentId)) + Number(Boolean(i.projectId));
  if ((type === 'TEAM' && (!i.teamId || count !== 1)) || (type === 'DEPARTMENT' && (!i.departmentId || count !== 1)) || (type === 'PROJECT' && (!i.projectId || count !== 1)) || (['WORKSPACE','PRIVATE'].includes(type) && count !== 0)) throw new AppError(400, 'INVALID_CHANNEL_PARENT', 'Channel type and parent must match');
}
function conflict(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') throw new AppError(409, 'CHANNEL_NAME_CONFLICT', 'A channel with that name already exists in this workspace');
  throw error;
}
export function createChannelService(prisma: PrismaClient = getPrismaClient()) {
  return {
    async create(i: CreateInput, ctx: RequestContext) {
      validateParent(i.type, i);
      const access = await requireWorkspaceAccess(prisma, { ...i, capability: WorkspaceCapability.ViewWorkspace });
      const manager = access.effectiveRole === 'OWNER' || access.effectiveRole === 'PROJECT_MANAGER';
      if (['WORKSPACE','PRIVATE','PROJECT'].includes(i.type) && !manager) throw new AppError(403, 'CHANNEL_ACCESS_DENIED', 'Workspace manager access is required');
      if (i.type === 'TEAM') {
        const a = await requireTeamAccess(prisma, { ...i, teamId: i.teamId!, workspaceRole: access.effectiveRole, capability: TeamCapability.UpdateTeam });
        if (!manager && a.teamMembership?.role !== 'TEAM_LEAD') throw new AppError(403, 'CHANNEL_ACCESS_DENIED', 'Team lead access is required');
      }
      if (i.type === 'DEPARTMENT') {
        const a = await requireDepartmentAccess(prisma, { ...i, departmentId: i.departmentId!, capability: DepartmentCapability.Update });
        if (!manager && a.membership?.role !== 'HEAD') throw new AppError(403, 'CHANNEL_ACCESS_DENIED', 'Department head access is required');
      }
      if (i.type === 'PROJECT') {
        const p = await prisma.project.findFirst({ where: { id: i.projectId, workspaceId: i.workspaceId, deletedAt: null, status: { not: 'ARCHIVED' } }, select: { id: true } });
        if (!p) throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
      }
      try {
        return await prisma.$transaction(async (tx) => {
          const row = await tx.channel.create({ data: { workspaceId: i.workspaceId, type: i.type, name: i.name, description: i.description ?? null, teamId: i.teamId ?? null, departmentId: i.departmentId ?? null, projectId: i.projectId ?? null, createdById: i.userId }, include: shape });
          if (i.type === 'PRIVATE') await tx.channelMembership.create({ data: { channelId: row.id, userId: i.userId, role: 'ADMIN' } });
          await recordAuditEvent(tx, { workspaceId: i.workspaceId, actorId: i.userId, action: ChannelAuditAction.Created, targetType: 'Channel', targetId: row.id, metadata: { type: i.type, name: i.name }, ...ctx });
          const response = i.type === 'PRIVATE' ? await tx.channel.findUniqueOrThrow({ where: { id: row.id }, include: shape }) : row;
          return summary(response);
        });
      } catch (e) { return conflict(e); }
    },
    async list(i: Input & { cursor?: string; limit: number }) {
      const a = await requireWorkspaceAccess(prisma, { ...i, capability: WorkspaceCapability.ViewWorkspace });
      const manager = a.effectiveRole === 'OWNER' || a.effectiveRole === 'PROJECT_MANAGER';
      const implicitLegacyManager = manager && !a.membership.organizationRole;
      const roleFilter = a.effectiveRole === 'COLLABORATOR' ? { type: { not: 'WORKSPACE' as const } } : {};
      const rows = await prisma.channel.findMany({ where: { workspaceId: i.workspaceId, deletedAt: null, archivedAt: null, ...roleFilter, OR: [
        { type: 'WORKSPACE' }, { type: 'PRIVATE', memberships: { some: { userId: i.userId } } },
        { type: 'TEAM', team: { is: { status: 'ACTIVE', deletedAt: null, ...(implicitLegacyManager ? {} : { members: { some: { userId: i.userId } } }) } } },
        { type: 'DEPARTMENT', department: { is: { ...(manager ? {} : { members: { some: { userId: i.userId } } }) } } },
        { type: 'PROJECT', project: { is: { deletedAt: null, status: { not: 'ARCHIVED' }, OR: [ { ownerId: i.userId }, { members: { some: { userId: i.userId } } }, { team: { is: { members: { some: { userId: i.userId } } } } }, { department: { is: { members: { some: { userId: i.userId } } } } }, ...(implicitLegacyManager ? [{}] : []) ] } } },
      ] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], ...(i.cursor ? { cursor: { id: i.cursor }, skip: 1 } : {}), take: i.limit + 1, include: shape });
      const more = rows.length > i.limit; const page = rows.slice(0, i.limit);
      return { items: page.map(summary), nextCursor: more ? page.at(-1)?.id ?? null : null };
    },
    async get(i: Input & { channelId: string }) { const { channel } = await requireChannelAccess(prisma, { ...i, capability: ChannelCapability.View }); return summary(await prisma.channel.findUniqueOrThrow({ where: { id: channel.id }, include: shape })); },
    async update(i: Input & { channelId: string; name?: string; description?: string | null }, ctx: RequestContext) {
      const { channel } = await requireChannelAccess(prisma, { ...i, capability: ChannelCapability.Update });
      try { return await prisma.$transaction(async (tx) => { const row = await tx.channel.update({ where: { id: channel.id }, data: { ...(i.name !== undefined ? { name: i.name } : {}), ...(i.description !== undefined ? { description: i.description } : {}) }, include: shape }); await recordAuditEvent(tx, { workspaceId: i.workspaceId, actorId: i.userId, action: ChannelAuditAction.Updated, targetType: 'Channel', targetId: row.id, metadata: { name: row.name }, ...ctx }); return summary(row); }); } catch(e) { return conflict(e); }
    },
    async archive(i: Input & { channelId: string }, ctx: RequestContext) { const { channel } = await requireChannelAccess(prisma, { ...i, capability: ChannelCapability.Archive }); return prisma.$transaction(async (tx) => { const row = await tx.channel.update({ where: { id: channel.id }, data: { archivedAt: new Date() }, include: shape }); await recordAuditEvent(tx, { workspaceId: i.workspaceId, actorId: i.userId, action: ChannelAuditAction.Archived, targetType: 'Channel', targetId: row.id, ...ctx }); return summary(row); }); },
    async remove(i: Input & { channelId: string }, ctx: RequestContext) { const { channel } = await requireChannelAccess(prisma, { ...i, capability: ChannelCapability.Delete }); await prisma.$transaction(async (tx) => { await tx.channel.update({ where: { id: channel.id }, data: { deletedAt: new Date() } }); await recordAuditEvent(tx, { workspaceId: i.workspaceId, actorId: i.userId, action: ChannelAuditAction.Deleted, targetType: 'Channel', targetId: channel.id, ...ctx }); }); },
    async addMember(i: Input & { channelId: string; targetUserId: string }, ctx: RequestContext) { const { channel } = await requireChannelAccess(prisma, { userId: i.userId, workspaceId: i.workspaceId, channelId: i.channelId, capability: ChannelCapability.AddMember }); if (channel.type !== 'PRIVATE') throw new AppError(400, 'PRIVATE_CHANNEL_REQUIRED', 'Membership is managed only for private channels'); const target = await prisma.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: i.workspaceId, userId: i.targetUserId } } }); if (!target || target.status !== 'ACTIVE') throw new AppError(404, 'WORKSPACE_MEMBER_NOT_FOUND', 'That active workspace member does not exist'); return prisma.$transaction(async (tx) => { const m = await tx.channelMembership.upsert({ where: { channelId_userId: { channelId: channel.id, userId: i.targetUserId } }, create: { channelId: channel.id, userId: i.targetUserId, role: 'MEMBER' }, update: {}, select: { channelId: true, userId: true, role: true, createdAt: true } }); await recordAuditEvent(tx, { workspaceId: i.workspaceId, actorId: i.userId, action: ChannelAuditAction.MemberAdded, targetType: 'ChannelMembership', targetId: m.userId, metadata: { channelId: channel.id }, ...ctx }); await createNotification(tx, { userId: i.targetUserId, type: 'MEMBERSHIP_CHANGED', title: 'Added to a private channel', data: { workspaceId: i.workspaceId, channelId: channel.id } }); return m; }); },
    async removeMember(i: Input & { channelId: string; memberUserId: string }, ctx: RequestContext) { const { channel } = await requireChannelAccess(prisma, { ...i, capability: ChannelCapability.RemoveMember }); if (channel.type !== 'PRIVATE') throw new AppError(400, 'PRIVATE_CHANNEL_REQUIRED', 'Membership is managed only for private channels'); return prisma.$transaction(async (tx) => { const removed = await tx.channelMembership.deleteMany({ where: { channelId: channel.id, userId: i.memberUserId } }); if (!removed.count) throw new AppError(404, 'CHANNEL_MEMBER_NOT_FOUND', 'That channel member does not exist'); await recordAuditEvent(tx, { workspaceId: i.workspaceId, actorId: i.userId, action: ChannelAuditAction.MemberRemoved, targetType: 'ChannelMembership', targetId: i.memberUserId, metadata: { channelId: channel.id }, ...ctx }); await createNotification(tx, { userId: i.memberUserId, type: 'MEMBERSHIP_CHANGED', title: 'Removed from a private channel', data: { workspaceId: i.workspaceId, channelId: channel.id } }); return { channelId: channel.id, userId: i.memberUserId, removed: true }; }); },
  };
}
