import type { PrismaClient, Project, ProjectRole, User } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import type { RequestContext } from '../auth/auth.types';
import { ProjectAuditAction, recordAuditEvent } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { AppError } from '../../utils/errors';
import {
  ProjectCapability,
  requireProjectAccess,
  requireWorkspaceAccess,
  WorkspaceCapability,
} from '../authorization';
import type {
  AddProjectMemberInput,
  ChangeProjectOwnerInput,
  CreateProjectInput,
  ListProjectsQuery,
  ProjectActivityQuery,
  UpdateProjectInput,
  UpdateProjectMemberRoleInput,
} from './project.schemas';
import type {
  Pagination,
  ProjectActivityEntry,
  ProjectActivityResult,
  ProjectDetailSummary,
  ProjectListResult,
  ProjectMemberSummary,
  ProjectOverview,
  ProjectSummary,
} from './project.types';
import {
  canTransitionProjectStatus,
  isValidProjectKey,
  projectKeyCandidate,
  projectKeyFromName,
} from './project.rules';

export interface ProjectService {
  create(
    input: { userId: string; workspaceId: string } & CreateProjectInput,
    ctx: RequestContext,
  ): Promise<ProjectSummary>;
  list(
    input: { userId: string; workspaceId: string } & ListProjectsQuery,
  ): Promise<ProjectListResult>;
  get(input: { userId: string; workspaceId: string; projectId: string }): Promise<ProjectSummary>;
  getDetail(input: {
    userId: string;
    workspaceId: string;
    projectId: string;
  }): Promise<ProjectDetailSummary>;
  overview(input: { userId: string; workspaceId: string }): Promise<ProjectOverview>;
  update(
    input: { userId: string; workspaceId: string; projectId: string } & UpdateProjectInput,
    ctx: RequestContext,
  ): Promise<ProjectSummary>;
  archive(
    input: { userId: string; workspaceId: string; projectId: string },
    ctx: RequestContext,
  ): Promise<ProjectSummary>;
  remove(
    input: { userId: string; workspaceId: string; projectId: string },
    ctx: RequestContext,
  ): Promise<void>;
  listMembers(input: {
    userId: string;
    workspaceId: string;
    projectId: string;
  }): Promise<ProjectMemberSummary[]>;
  addMember(
    input: {
      userId: string;
      workspaceId: string;
      projectId: string;
      targetUserId: string;
    } & AddProjectMemberInput,
    ctx: RequestContext,
  ): Promise<ProjectMemberSummary>;
  updateMemberRole(
    input: {
      userId: string;
      workspaceId: string;
      projectId: string;
      targetUserId: string;
    } & UpdateProjectMemberRoleInput,
    ctx: RequestContext,
  ): Promise<ProjectMemberSummary>;
  removeMember(
    input: { userId: string; workspaceId: string; projectId: string; targetUserId: string },
    ctx: RequestContext,
  ): Promise<void>;
  changeOwner(
    input: { userId: string; workspaceId: string; projectId: string } & Partial<ChangeProjectOwnerInput>,
    ctx: RequestContext,
  ): Promise<ProjectSummary>;
  activity(
    input: { userId: string; workspaceId: string; projectId: string } & ProjectActivityQuery,
  ): Promise<ProjectActivityResult>;
}

type ProjectWithOwner = Project & { owner: Pick<User, 'id' | 'name' | 'email'> };

function toSummary(
  project: ProjectWithOwner,
  memberCount: number,
  taskCount: number,
): ProjectSummary {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    teamId: project.teamId,
    name: project.name,
    key: project.key,
    description: project.description,
    status: project.status,
    visibility: project.visibility,
    startDate: project.startDate,
    dueDate: project.dueDate,
    ownerId: project.ownerId,
    owner: { id: project.owner.id, name: project.owner.name, email: project.owner.email },
    settings: (project as any).settings ?? null,
    memberCount,
    taskCount,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function toMember(m: {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  createdAt: Date;
  user: Pick<User, 'id' | 'name' | 'email'>;
}): ProjectMemberSummary {
  return {
    id: m.id,
    projectId: m.projectId,
    userId: m.user.id,
    role: m.role,
    name: m.user.name,
    email: m.user.email,
    joinedAt: m.createdAt,
  };
}

function pagination(page: number, pageSize: number, total: number): Pagination {
  return { page, pageSize, total, totalPages: total === 0 ? 0 : Math.ceil(total / pageSize) };
}

function isDueSoon(d: Date | null) {
  if (!d) return false;
  const now = Date.now();
  return d.getTime() >= now && d.getTime() <= now + 7 * 24 * 3600 * 1000;
}
function isOverdue(d: Date | null) {
  if (!d) return false;
  return d.getTime() < Date.now();
}

export function createProjectService(prisma?: PrismaClient): ProjectService {
  const client = prisma ?? getPrismaClient();

  async function uniqueProjectKey(
    workspaceId: string,
    name: string,
    requested?: string,
  ): Promise<string> {
    const base = requested && isValidProjectKey(requested) ? requested : projectKeyFromName(name);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const candidate = projectKeyCandidate(base, attempt);
      const exists = await client.project.findUnique({
        where: { workspaceId_key: { workspaceId, key: candidate } },
        select: { id: true },
      });
      if (!exists) return candidate;
    }
    throw new AppError(409, 'PROJECT_KEY_CONFLICT', 'Unable to generate a unique project key');
  }

  async function loadProjectSummary(
    projectId: string,
    workspaceId: string,
  ): Promise<ProjectSummary> {
    const project = await client.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        _count: { select: { members: true, tasks: true } },
      },
    });
    if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
    const { _count, ...data } = project;
    return toSummary(data, _count.members, _count.tasks);
  }

  return {
    async create(input, ctx): Promise<ProjectSummary> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.UpdateWorkspace,
      });
      if (input.teamId) {
        const team = await client.team.findFirst({
          where: { id: input.teamId, workspaceId: workspace.id, deletedAt: null },
          select: { id: true },
        });
        if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', 'That team does not exist');
      }
      const ownerId = input.ownerId ?? input.userId;
      if (ownerId !== input.userId) {
        const om = await client.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: ownerId } },
        });
        if (!om)
          throw new AppError(
            404,
            'OWNER_NOT_FOUND',
            'The project owner must be a member of the workspace',
          );
      }
      const key = await uniqueProjectKey(workspace.id, input.name, input.key);

      const project = await client.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            workspaceId: workspace.id,
            teamId: input.teamId ?? null,
            name: input.name,
            key,
            ...(input.description !== undefined ? { description: input.description } : {}),
            status: input.status,
            visibility: input.visibility,
            ownerId,
            ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
            ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
            ...(input.settings !== undefined ? { settings: input.settings as any } : {}),
          },
          include: { owner: { select: { id: true, name: true, email: true } } },
        });
        await tx.projectMembership.create({
          data: {
            projectId: created.id,
            userId: input.userId,
            role:
              membership.role === 'OWNER' || membership.role === 'PROJECT_MANAGER'
                ? 'PROJECT_MANAGER'
                : 'MEMBER',
          },
        });
        if (ownerId !== input.userId) {
          const ex = await tx.projectMembership.findUnique({
            where: { projectId_userId: { projectId: created.id, userId: ownerId } },
          });
          if (!ex)
            await tx.projectMembership.create({
              data: { projectId: created.id, userId: ownerId, role: 'PROJECT_MANAGER' },
            });
          else if (ex.role !== 'PROJECT_MANAGER')
            await tx.projectMembership.update({
              where: { id: ex.id },
              data: { role: 'PROJECT_MANAGER' },
            });
        }
        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: ProjectAuditAction.ProjectCreated,
          targetType: 'Project',
          targetId: created.id,
          metadata: { name: created.name, key: created.key },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        if (ownerId !== input.userId) {
          await createNotification(tx, {
            userId: ownerId,
            type: 'PROJECT_UPDATE',
            title: `You own ${created.name}`,
            body: `You have been assigned as the owner of the project ${created.name}.`,
            data: { workspaceId: workspace.id, projectId: created.id },
          });
        }
        return created;
      });
      const memberCount = await client.projectMembership.count({
        where: { projectId: project.id },
      });
      const taskCount = await client.task.count({
        where: { projectId: project.id, deletedAt: null },
      });
      return toSummary(project, memberCount, taskCount);
    },

    async list(input): Promise<ProjectListResult> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const where: any = { workspaceId: workspace.id, deletedAt: null };
      if (!input.includeArchived) where.status = { not: 'ARCHIVED' };
      else if (input.status) where.status = input.status;
      if (input.visibility) where.visibility = input.visibility;
      if (input.teamId) where.teamId = input.teamId;
      if (input.ownerId) where.ownerId = input.ownerId;
      if (input.search)
        where.OR = [
          { name: { contains: input.search, mode: 'insensitive' } },
          { key: { contains: input.search, mode: 'insensitive' } },
        ];
      if (membership.role !== 'OWNER' && membership.role !== 'PROJECT_MANAGER') {
        where.OR = [{ visibility: 'WORKSPACE' }, { members: { some: { userId: input.userId } } }];
      }
      const [rows, total] = await Promise.all([
        client.project.findMany({
          where,
          include: {
            owner: { select: { id: true, name: true, email: true } },
            _count: { select: { members: true, tasks: true } },
          },
          orderBy: { [input.sortBy]: input.sortOrder },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        client.project.count({ where }),
      ]);
      return {
        items: rows.map(({ _count, ...p }) => toSummary(p, _count.members, _count.tasks)),
        pagination: pagination(input.page, input.pageSize, total),
      };
    },

    async get(input): Promise<ProjectSummary> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      await requireProjectAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        projectId: input.projectId,
        workspaceRole: membership.role,
        capability: ProjectCapability.ViewProject,
      });
      return loadProjectSummary(input.projectId, workspace.id);
    },

    async getDetail(input): Promise<ProjectDetailSummary> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      await requireProjectAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        projectId: input.projectId,
        workspaceRole: membership.role,
        capability: ProjectCapability.ViewProject,
      });
      const [project, memberCount, taskCount, completedTaskCount, memberRolesRows, recentAudit] =
        await Promise.all([
          client.project.findFirst({
            where: { id: input.projectId, workspaceId: workspace.id, deletedAt: null },
            include: { owner: { select: { id: true, name: true, email: true } } },
          }),
          client.projectMembership.count({ where: { projectId: input.projectId } }),
          client.task.count({ where: { projectId: input.projectId, deletedAt: null } }),
          client.task.count({
            where: { projectId: input.projectId, deletedAt: null, status: 'APPROVED' },
          }),
          client.projectMembership.groupBy({
            by: ['role'],
            where: { projectId: input.projectId },
            _count: { role: true },
          }),
          client.auditLog.findMany({
            where: { targetType: 'Project', targetId: input.projectId },
            include: { actor: { select: { id: true, name: true, email: true } } },
            orderBy: { createdAt: 'desc' },
            take: 5,
          }),
        ]);
      if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
      const memberRoles: any = { PROJECT_MANAGER: 0, MEMBER: 0, VIEWER: 0 };
      for (const r of memberRolesRows) memberRoles[r.role] = r._count.role;
      const recentActivity: ProjectActivityEntry[] = recentAudit.map((e) => ({
        id: e.id,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        actor: e.actor ? { id: e.actor.id, name: e.actor.name, email: e.actor.email } : null,
        metadata: e.metadata,
        createdAt: e.createdAt,
      }));
      return {
        ...toSummary(project, memberCount, taskCount),
        memberRoles,
        completedTaskCount,
        recentActivity,
      };
    },

    async overview(input): Promise<ProjectOverview> {
      await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const [total, byStatusRows, byVisibilityRows, projectsWithDue] = await Promise.all([
        client.project.count({ where: { workspaceId: input.workspaceId, deletedAt: null } }),
        client.project.groupBy({
          by: ['status'],
          where: { workspaceId: input.workspaceId, deletedAt: null },
          _count: { status: true },
        }),
        client.project.groupBy({
          by: ['visibility'],
          where: { workspaceId: input.workspaceId, deletedAt: null },
          _count: { visibility: true },
        }),
        client.project.findMany({
          where: { workspaceId: input.workspaceId, deletedAt: null, status: { not: 'ARCHIVED' } },
          select: { dueDate: true },
        }),
      ]);
      const byStatus: any = { PLANNING: 0, ACTIVE: 0, ON_HOLD: 0, COMPLETED: 0, ARCHIVED: 0 };
      for (const r of byStatusRows) byStatus[r.status] = r._count.status;
      const byVisibility: any = { PRIVATE: 0, WORKSPACE: 0 };
      for (const r of byVisibilityRows) byVisibility[r.visibility] = r._count.visibility;
      let overdue = 0,
        dueSoon = 0;
      for (const p of projectsWithDue) {
        if (isOverdue(p.dueDate)) overdue += 1;
        else if (isDueSoon(p.dueDate)) dueSoon += 1;
      }
      return { total, byStatus, byVisibility, overdue, dueSoon };
    },

    async update(input, ctx): Promise<ProjectSummary> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const { project } = await requireProjectAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        projectId: input.projectId,
        workspaceRole: membership.role,
        capability: ProjectCapability.UpdateProject,
      });
      if (project.status === 'ARCHIVED')
        throw new AppError(409, 'PROJECT_ARCHIVED', 'An archived project cannot be updated');
      if (input.teamId) {
        const team = await client.team.findFirst({
          where: { id: input.teamId, workspaceId: workspace.id, deletedAt: null },
          select: { id: true },
        });
        if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', 'That team does not exist');
      }
      if (input.status && input.status !== project.status) {
        if (!canTransitionProjectStatus(project.status, input.status))
          throw new AppError(
            400,
            'INVALID_PROJECT_STATUS_TRANSITION',
            'That project status transition is not allowed',
          );
      }
      const updated = await client.$transaction(async (tx) => {
        const changed = await tx.project.update({
          where: { id: project.id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
            ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
            ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
            ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
            ...(input.settings !== undefined ? { settings: input.settings as unknown as object } : {}),
          } as any,
          include: { owner: { select: { id: true, name: true, email: true } } },
        });
        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: ProjectAuditAction.ProjectUpdated,
          targetType: 'Project',
          targetId: changed.id,
          metadata: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return changed;
      });
      const memberCount = await client.projectMembership.count({
        where: { projectId: updated.id },
      });
      const taskCount = await client.task.count({
        where: { projectId: updated.id, deletedAt: null },
      });
      return toSummary(updated, memberCount, taskCount);
    },

    async archive(input, ctx): Promise<ProjectSummary> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const { project } = await requireProjectAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        projectId: input.projectId,
        workspaceRole: membership.role,
        capability: ProjectCapability.ArchiveProject,
      });
      if (project.status === 'ARCHIVED')
        throw new AppError(409, 'PROJECT_ALREADY_ARCHIVED', 'This project is already archived');
      const archived = await client.$transaction(async (tx) => {
        const changed = await tx.project.update({
          where: { id: project.id },
          data: { status: 'ARCHIVED' },
          include: { owner: { select: { id: true, name: true, email: true } } },
        });
        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: ProjectAuditAction.ProjectArchived,
          targetType: 'Project',
          targetId: changed.id,
          metadata: { name: changed.name },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return changed;
      });
      const memberCount = await client.projectMembership.count({
        where: { projectId: archived.id },
      });
      const taskCount = await client.task.count({
        where: { projectId: archived.id, deletedAt: null },
      });
      return toSummary(archived, memberCount, taskCount);
    },

    async remove(input, ctx): Promise<void> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const { project } = await requireProjectAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        projectId: input.projectId,
        workspaceRole: membership.role,
        capability: ProjectCapability.DeleteProject,
      });
      const members = await client.projectMembership.findMany({
        where: { projectId: project.id },
        select: { userId: true },
      });
      await client.$transaction(async (tx) => {
        await tx.project.update({
          where: { id: project.id },
          data: { deletedAt: new Date(), status: 'ARCHIVED' },
        });
        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: ProjectAuditAction.ProjectDeleted,
          targetType: 'Project',
          targetId: project.id,
          metadata: { name: project.name },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        for (const m of members) {
          if (m.userId !== input.userId) {
            await createNotification(tx, {
              userId: m.userId,
              type: 'PROJECT_UPDATE',
              title: `Project "${project.name}" was deleted`,
              body: `The project ${project.name} has been removed from the workspace.`,
              data: { workspaceId: workspace.id, projectId: project.id },
            });
          }
        }
      });
    },

    async listMembers(input): Promise<ProjectMemberSummary[]> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      await requireProjectAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        projectId: input.projectId,
        workspaceRole: membership.role,
        capability: ProjectCapability.ViewProject,
      });
      const memberships = await client.projectMembership.findMany({
        where: { projectId: input.projectId },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      });
      return memberships.map(toMember);
    },

    async addMember(input, ctx): Promise<ProjectMemberSummary> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const { project } = await requireProjectAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        projectId: input.projectId,
        workspaceRole: membership.role,
        capability: ProjectCapability.ManageMembers,
      });
      const targetWs = await client.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: input.targetUserId } },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      if (!targetWs)
        throw new AppError(
          404,
          'WORKSPACE_MEMBER_NOT_FOUND',
          'The user must be a member of the workspace',
        );
      const existing = await client.projectMembership.findUnique({
        where: { projectId_userId: { projectId: project.id, userId: input.targetUserId } },
      });
      if (existing)
        throw new AppError(409, 'ALREADY_A_MEMBER', 'This user is already a member of the project');
      const newMembership = await client.$transaction(async (tx) => {
        const created = await tx.projectMembership.create({
          data: {
            projectId: project.id,
            userId: input.targetUserId,
            role: input.role as ProjectRole,
          },
          include: { user: { select: { id: true, name: true, email: true } } },
        });
        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: ProjectAuditAction.MemberAdded,
          targetType: 'ProjectMembership',
          targetId: created.id,
          metadata: { projectId: project.id, userId: input.targetUserId, role: input.role },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        await createNotification(tx, {
          userId: input.targetUserId,
          type: 'PROJECT_UPDATE',
          title: `You joined ${project.name}`,
          body: `Your role in the project is ${String(input.role).toLowerCase().replace('_', ' ')}.`,
          data: { workspaceId: workspace.id, projectId: project.id, role: input.role },
        });
        return created;
      });
      return toMember(newMembership);
    },

    async updateMemberRole(input, ctx): Promise<ProjectMemberSummary> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const { project } = await requireProjectAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        projectId: input.projectId,
        workspaceRole: membership.role,
        capability: ProjectCapability.ManageMembers,
      });
      const target = await client.projectMembership.findUnique({
        where: { projectId_userId: { projectId: project.id, userId: input.targetUserId } },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      if (!target)
        throw new AppError(404, 'MEMBER_NOT_FOUND', 'That user is not a member of this project');
      if (input.targetUserId === project.ownerId && input.role !== 'PROJECT_MANAGER') {
        throw new AppError(
          403,
          'OWNER_ROLE_REQUIRED',
          'The project owner must remain a project manager or ownership must be transferred',
        );
      }
      const updated = await client.$transaction(async (tx) => {
        const previousRole = target.role;
        const changed = await tx.projectMembership.update({
          where: { id: target.id },
          data: { role: input.role as ProjectRole },
          include: { user: { select: { id: true, name: true, email: true } } },
        });
        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: ProjectAuditAction.MemberRoleChanged,
          targetType: 'ProjectMembership',
          targetId: changed.id,
          metadata: {
            projectId: project.id,
            userId: changed.user.id,
            previousRole,
            role: input.role,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        await createNotification(tx, {
          userId: changed.user.id,
          type: 'PROJECT_UPDATE',
          title: `Your role in ${project.name} changed`,
          body: `Your project role is now ${String(input.role).toLowerCase().replace('_', ' ')}.`,
          data: { workspaceId: workspace.id, projectId: project.id, role: input.role },
        });
        return changed;
      });
      return toMember(updated);
    },

    async removeMember(input, ctx): Promise<void> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const { project } = await requireProjectAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        projectId: input.projectId,
        workspaceRole: membership.role,
        capability: ProjectCapability.ManageMembers,
      });
      if (input.targetUserId === project.ownerId)
        throw new AppError(
          403,
          'OWNER_CANNOT_BE_REMOVED',
          'Transfer ownership before removing the project owner',
        );
      const target = await client.projectMembership.findUnique({
        where: { projectId_userId: { projectId: project.id, userId: input.targetUserId } },
        include: { user: { select: { id: true, name: true, email: true } } },
      });
      if (!target)
        throw new AppError(404, 'MEMBER_NOT_FOUND', 'That user is not a member of this project');
      await client.$transaction(async (tx) => {
        await tx.projectMembership.delete({ where: { id: target.id } });
        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: ProjectAuditAction.MemberRemoved,
          targetType: 'ProjectMembership',
          targetId: target.id,
          metadata: { projectId: project.id, userId: target.user.id, role: target.role },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        if (target.userId !== input.userId) {
          await createNotification(tx, {
            userId: target.userId,
            type: 'PROJECT_UPDATE',
            title: `You were removed from ${project.name}`,
            body: `Your membership in the project ${project.name} was removed.`,
            data: { workspaceId: workspace.id, projectId: project.id },
          });
        }
      });
    },

    async changeOwner(input, ctx): Promise<ProjectSummary> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      if (membership.role !== 'OWNER')
        throw new AppError(
          403,
          'INSUFFICIENT_ROLE',
          'Only the workspace owner can change the project owner',
        );
      const project = await client.project.findFirst({
        where: { id: input.projectId, workspaceId: workspace.id, deletedAt: null },
      });
      if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
      const newOwnerId = ((input as any).userId as string) ?? ((input as ChangeProjectOwnerInput).userId);
      if (newOwnerId === project.ownerId)
        throw new AppError(400, 'SAME_OWNER', 'The selected user is already the project owner');
      const newOwnerWs = await client.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: newOwnerId } },
      });
      if (!newOwnerWs)
        throw new AppError(
          404,
          'OWNER_NOT_FOUND',
          'The new owner must be a member of the workspace',
        );
      const updated = await client.$transaction(async (tx) => {
        const changed = await tx.project.update({
          where: { id: project.id },
          data: { ownerId: newOwnerId },
          include: { owner: { select: { id: true, name: true, email: true } } },
        });
        const existing = await tx.projectMembership.findUnique({
          where: { projectId_userId: { projectId: project.id, userId: newOwnerId } },
        });
        if (!existing)
          await tx.projectMembership.create({
            data: { projectId: project.id, userId: newOwnerId, role: 'PROJECT_MANAGER' },
          });
        else if (existing.role !== 'PROJECT_MANAGER')
          await tx.projectMembership.update({
            where: { id: existing.id },
            data: { role: 'PROJECT_MANAGER' },
          });
        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: ProjectAuditAction.OwnerChanged,
          targetType: 'Project',
          targetId: changed.id,
          metadata: { previousOwnerId: project.ownerId, newOwnerId },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        await createNotification(tx, {
          userId: newOwnerId,
          type: 'PROJECT_UPDATE',
          title: `You own ${changed.name}`,
          body: `You have been assigned as the owner of the project ${changed.name}.`,
          data: { workspaceId: workspace.id, projectId: changed.id },
        });
        return changed;
      });
      const memberCount = await client.projectMembership.count({
        where: { projectId: updated.id },
      });
      const taskCount = await client.task.count({
        where: { projectId: updated.id, deletedAt: null },
      });
      return toSummary(updated, memberCount, taskCount);
    },

    async activity(input): Promise<ProjectActivityResult> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      await requireProjectAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        projectId: input.projectId,
        workspaceRole: membership.role,
        capability: ProjectCapability.ViewProject,
      });
      const [rows, total] = await Promise.all([
        client.auditLog.findMany({
          where: { targetType: 'Project', targetId: input.projectId },
          include: { actor: { select: { id: true, name: true, email: true } } },
          orderBy: { createdAt: 'desc' },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        client.auditLog.count({ where: { targetType: 'Project', targetId: input.projectId } }),
      ]);
      const items: ProjectActivityEntry[] = rows.map((e) => ({
        id: e.id,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        actor: e.actor ? { id: e.actor.id, name: e.actor.name, email: e.actor.email } : null,
        metadata: e.metadata,
        createdAt: e.createdAt,
      }));
      return { items, pagination: pagination(input.page, input.pageSize, total) };
    },
  };
}
