import type { Prisma, PrismaClient, Project, ProjectRole, WorkspaceRole } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { AppError } from '../../utils/errors';
import {
  DepartmentCapability,
  ProjectCapability,
  organizationRoleCanOwnProjects,
  requireDepartmentAccess,
  requireProjectAccess,
  requireTeamAccess,
  requireWorkspaceAccess,
  TeamCapability,
  WorkspaceCapability,
} from '../authorization';
import {
  effectiveWorkspaceRole,
  isOrganizationRoleForWorkspace,
} from '../authorization/organization-role';
import type { RequestContext } from '../auth/auth.types';
import type { CreateProjectInput, ListProjectsQuery, UpdateProjectInput } from './project.schemas';

type Input = { userId: string; workspaceId: string };
type ProjectSummary = Pick<
  Project,
  | 'id'
  | 'workspaceId'
  | 'teamId'
  | 'departmentId'
  | 'name'
  | 'key'
  | 'description'
  | 'category'
  | 'labels'
  | 'status'
  | 'visibility'
  | 'startDate'
  | 'dueDate'
  | 'ownerId'
  | 'createdAt'
  | 'updatedAt'
> & {
  owner: { id: string; name: string };
  memberCount: number;
  taskCount: number;
  myRole: ProjectRole | null;
};

const projectInclude = {
  owner: { select: { id: true, name: true } },
  _count: { select: { members: true, tasks: true } },
} as const;

function toSummary(
  row: Prisma.ProjectGetPayload<{ include: typeof projectInclude }>,
  myRole: ProjectRole | null,
): ProjectSummary {
  const { _count, ...project } = row;
  return { ...project, memberCount: _count.members, taskCount: _count.tasks, myRole };
}

function effectiveProjectRole(
  workspaceRole: WorkspaceRole,
  membership: ProjectRole | null,
  isOwner: boolean,
): ProjectRole | null {
  if (isOwner) return 'PROJECT_MANAGER';
  if (membership) return membership;
  if (workspaceRole === 'OWNER' || workspaceRole === 'PROJECT_MANAGER') return 'PROJECT_MANAGER';
  return null;
}

function mapConflict(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
    throw new AppError(
      409,
      'PROJECT_KEY_CONFLICT',
      'A project with that key already exists in this workspace',
    );
  }
  throw error;
}

function dateOrNull(value: string | null | undefined): Date | null | undefined {
  return value === undefined ? undefined : value === null ? null : new Date(value);
}

export function createProjectService(prisma: PrismaClient = getPrismaClient()) {
  return {
    async list(input: Input & ListProjectsQuery) {
      const access = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const manager =
        access.effectiveRole === 'OWNER' || access.effectiveRole === 'PROJECT_MANAGER';
      const unrestrictedLegacyManager = manager && !access.membership.organizationRole;
      const rows = await prisma.project.findMany({
        where: {
          workspaceId: input.workspaceId,
          deletedAt: null,
          ...(input.status ? { status: input.status } : {}),
          ...(!input.includeArchived ? { status: input.status ?? { not: 'ARCHIVED' } } : {}),
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(input.teamId ? { teamId: input.teamId } : {}),
          ...(input.departmentId ? { departmentId: input.departmentId } : {}),
          ...(input.search
            ? {
                OR: [
                  { name: { contains: input.search, mode: 'insensitive' } },
                  { key: { contains: input.search, mode: 'insensitive' } },
                ],
              }
            : {}),
          ...(!unrestrictedLegacyManager
            ? {
                AND: [
                  {
                    OR: [
                      { visibility: 'WORKSPACE' },
                      { ownerId: input.userId },
                      { members: { some: { userId: input.userId } } },
                      {
                        AND: [
                          { visibility: 'DEPARTMENT_TEAM' },
                          {
                            team: {
                              is: {
                                status: 'ACTIVE',
                                deletedAt: null,
                                members: { some: { userId: input.userId } },
                              },
                            },
                          },
                        ],
                      },
                      {
                        AND: [
                          { visibility: 'DEPARTMENT_TEAM' },
                          { teamId: null },
                          { department: { is: { members: { some: { userId: input.userId } } } } },
                        ],
                      },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        take: input.limit + 1,
        include: projectInclude,
      });
      const hasMore = rows.length > input.limit;
      const page = rows.slice(0, input.limit);
      const projectIds = page.map((row) => row.id);
      const memberships = projectIds.length
        ? await prisma.projectMembership.findMany({
            where: { userId: input.userId, projectId: { in: projectIds } },
            select: { projectId: true, role: true },
          })
        : [];
      const roleByProject = new Map(
        memberships.map((membership) => [membership.projectId, membership.role]),
      );
      const items = page.map((row) =>
        toSummary(
          row,
          roleByProject.get(row.id) ??
            (row.ownerId === input.userId ||
            (unrestrictedLegacyManager && !access.membership.organizationRole)
              ? 'PROJECT_MANAGER'
              : null),
        ),
      );
      return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
    },

    async create(input: Input & CreateProjectInput, context: RequestContext) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.UpdateWorkspace,
      });
      let teamDepartmentId: string | null = null;
      if (input.teamId) {
        const team = await requireTeamAccess(prisma, {
          ...input,
          teamId: input.teamId,
          workspaceRole: workspace.effectiveRole,
          capability: TeamCapability.ViewTeam,
        });
        if (team.team.status !== 'ACTIVE' || team.team.deletedAt)
          throw new AppError(404, 'TEAM_NOT_FOUND', 'That team does not exist');
        teamDepartmentId = team.team.departmentId;
      }
      if (input.departmentId) {
        await requireDepartmentAccess(prisma, {
          ...input,
          departmentId: input.departmentId,
          capability: DepartmentCapability.ManageProjects,
        });
      }
      if (teamDepartmentId && input.departmentId && teamDepartmentId !== input.departmentId) {
        throw new AppError(
          409,
          'PROJECT_ORGANIZATION_MISMATCH',
          'The project team and department must belong together',
        );
      }
      if (teamDepartmentId && !input.departmentId && input.teamId) {
        // Keep project visibility and its department relationship aligned with a department-bound team.
        input = { ...input, departmentId: teamDepartmentId };
      }
      if (input.visibility === 'DEPARTMENT_TEAM' && !input.teamId && !input.departmentId) {
        throw new AppError(
          400,
          'PROJECT_SCOPE_REQUIRED',
          'Department/team-only projects require a team or department',
        );
      }
      try {
        return await prisma.$transaction(async (tx) => {
          const project = await tx.project.create({
            data: {
              workspaceId: input.workspaceId,
              ownerId: input.userId,
              name: input.name,
              key: input.key.toUpperCase(),
              description: input.description ?? null,
              category: input.category ?? null,
              labels: input.labels ?? [],
              visibility: input.visibility,
              teamId: input.teamId ?? null,
              departmentId: input.departmentId ?? null,
              startDate: dateOrNull(input.startDate) ?? null,
              dueDate: dateOrNull(input.dueDate) ?? null,
            },
            include: projectInclude,
          });
          await tx.projectMembership.create({
            data: { projectId: project.id, userId: input.userId, role: 'PROJECT_MANAGER' },
          });
          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: 'project.created',
            targetType: 'Project',
            targetId: project.id,
            metadata: { name: project.name, key: project.key, visibility: project.visibility },
            ...context,
          });
          const created = await tx.project.findUniqueOrThrow({
            where: { id: project.id },
            include: projectInclude,
          });
          return toSummary(created, 'PROJECT_MANAGER');
        });
      } catch (error) {
        return mapConflict(error);
      }
    },

    async get(input: Input & { projectId: string }) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const access = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.ViewProject,
      });
      const row = await prisma.project.findUniqueOrThrow({
        where: { id: access.project.id },
        include: projectInclude,
      });
      return toSummary(
        row,
        effectiveProjectRole(
          access.workspaceRole,
          access.projectMembership?.role ?? null,
          row.ownerId === input.userId,
        ),
      );
    },

    async transferOwnership(
      input: Input & {
        projectId: string;
        newOwnerId: string;
        previousOwnerRole: 'MANAGER' | 'MEMBER' | 'REMOVE';
      },
      context: RequestContext,
    ) {
      const requestStartedAt = new Date();
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const initialAccess = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.ViewProject,
      });
      if (input.newOwnerId === initialAccess.project.ownerId)
        throw new AppError(
          400,
          'PROJECT_OWNER_UNCHANGED',
          'The new owner must be different from the current owner',
        );

      const initiallyOwner = initialAccess.project.ownerId === input.userId;
      const initiallyAdmin =
        workspace.effectiveRole === 'OWNER' || workspace.effectiveRole === 'PROJECT_MANAGER';
      if (!initiallyOwner && !initiallyAdmin) {
        const racingTransfer = await prisma.auditLog.findFirst({
          where: {
            targetType: 'Project',
            targetId: input.projectId,
            action: 'project.ownership_transferred',
            createdAt: { gte: requestStartedAt },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { metadata: true },
        });
        if (
          racingTransfer?.metadata &&
          typeof racingTransfer.metadata === 'object' &&
          'previousOwnerId' in racingTransfer.metadata &&
          racingTransfer.metadata.previousOwnerId === input.userId
        ) {
          throw new AppError(
            409,
            'PROJECT_OWNERSHIP_CHANGED',
            'Project ownership changed while this transfer was in progress',
          );
        }
        throw new AppError(
          403,
          'PROJECT_TRANSFER_FORBIDDEN',
          'Only the project owner or a workspace administrator can transfer ownership',
        );
      }

      return prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Project[]>`
          SELECT * FROM "Project"
          WHERE "id" = ${input.projectId} AND "workspaceId" = ${input.workspaceId}
          FOR UPDATE
        `;
        if (!locked || locked.deletedAt)
          throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
        if (locked.ownerId !== initialAccess.project.ownerId)
          throw new AppError(
            409,
            'PROJECT_OWNERSHIP_CHANGED',
            'Project ownership changed before this transfer could complete',
          );
        if (locked.ownerId === input.newOwnerId)
          throw new AppError(
            400,
            'PROJECT_OWNER_UNCHANGED',
            'The new owner must be different from the current owner',
          );

        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT wm."id" FROM "WorkspaceMembership" wm
          JOIN "User" u ON u."id" = wm."userId"
          WHERE wm."workspaceId" = ${input.workspaceId} AND wm."userId" = ${input.userId}
          FOR UPDATE OF wm, u
        `;
        const actorMembership = await tx.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } },
          include: { workspace: { select: { type: true } } },
        });
        if (!actorMembership || actorMembership.status !== 'ACTIVE')
          throw new AppError(
            403,
            'PROJECT_TRANSFER_FORBIDDEN',
            'An active workspace membership is required',
          );
        const actorRole = effectiveWorkspaceRole(
          actorMembership.workspace.type,
          actorMembership.role,
          actorMembership.organizationRole,
        );
        const actorIsOwner = locked.ownerId === input.userId;
        const actorIsWorkspaceAdmin = actorRole === 'OWNER' || actorRole === 'PROJECT_MANAGER';
        if (!actorIsOwner && !actorIsWorkspaceAdmin)
          throw new AppError(
            403,
            'PROJECT_TRANSFER_FORBIDDEN',
            'Only the project owner or a workspace administrator can transfer ownership',
          );

        await requireProjectAccess(tx, {
          userId: input.userId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          workspaceRole: actorRole,
          capability: ProjectCapability.ViewProject,
        });

        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT wm."id" FROM "WorkspaceMembership" wm
          JOIN "User" u ON u."id" = wm."userId"
          WHERE wm."workspaceId" = ${input.workspaceId} AND wm."userId" = ${input.newOwnerId}
          FOR UPDATE OF wm, u
        `;
        const target = await tx.workspaceMembership.findUnique({
          where: {
            workspaceId_userId: { workspaceId: input.workspaceId, userId: input.newOwnerId },
          },
          include: {
            user: { select: { status: true, deletedAt: true } },
            workspace: { select: { type: true } },
          },
        });
        if (
          !target ||
          target.status !== 'ACTIVE' ||
          target.user.status !== 'ACTIVE' ||
          target.user.deletedAt !== null ||
          (target.organizationRole &&
            !isOrganizationRoleForWorkspace(target.workspace.type, target.organizationRole)) ||
          !organizationRoleCanOwnProjects(target.organizationRole)
        ) {
          throw new AppError(
            422,
            'PROJECT_OWNER_TARGET_INELIGIBLE',
            'The new owner must be an eligible active workspace member',
          );
        }

        // Parent eligibility is OR across supported scope types. If a project
        // has a team, that narrower team membership takes precedence; its
        // department link is not an alternate access path.
        if (locked.visibility === 'DEPARTMENT_TEAM') {
          let eligibleParentMember = false;
          if (locked.teamId) {
            await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "Team"
              WHERE "id" = ${locked.teamId} AND "workspaceId" = ${input.workspaceId}
                AND "status" = 'ACTIVE' AND "deletedAt" IS NULL
              FOR UPDATE
            `;
            const team = await tx.team.findFirst({
              where: {
                id: locked.teamId,
                workspaceId: input.workspaceId,
                status: 'ACTIVE',
                deletedAt: null,
              },
              select: { id: true },
            });
            if (team) {
              await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "TeamMembership"
                WHERE "teamId" = ${team.id} AND "userId" = ${input.newOwnerId}
                FOR UPDATE
              `;
              eligibleParentMember = Boolean(
                await tx.teamMembership.findUnique({
                  where: { teamId_userId: { teamId: team.id, userId: input.newOwnerId } },
                  select: { id: true },
                }),
              );
            }
          } else if (locked.departmentId) {
            await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "Department"
              WHERE "id" = ${locked.departmentId} AND "workspaceId" = ${input.workspaceId}
              FOR UPDATE
            `;
            const department = await tx.department.findFirst({
              where: { id: locked.departmentId, workspaceId: input.workspaceId },
              select: { id: true },
            });
            if (department) {
              await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM "DepartmentMembership"
                WHERE "departmentId" = ${department.id} AND "userId" = ${input.newOwnerId}
                FOR UPDATE
              `;
              eligibleParentMember = Boolean(
                await tx.departmentMembership.findUnique({
                  where: {
                    departmentId_userId: { departmentId: department.id, userId: input.newOwnerId },
                  },
                  select: { id: true },
                }),
              );
            }
          }
          if (!eligibleParentMember)
            throw new AppError(
              422,
              'PROJECT_OWNER_TARGET_INELIGIBLE',
              'The new owner must belong to the project team or department',
            );
        }

        const previousOwnerId = locked.ownerId;
        const previousMembershipRole: ProjectRole =
          input.previousOwnerRole === 'MANAGER' ? 'PROJECT_MANAGER' : 'MEMBER';
        const previousOwnerResultingRole =
          input.previousOwnerRole === 'REMOVE' ? 'REMOVED' : previousMembershipRole;
        const newMembership = await tx.projectMembership.upsert({
          where: { projectId_userId: { projectId: input.projectId, userId: input.newOwnerId } },
          create: { projectId: input.projectId, userId: input.newOwnerId, role: 'PROJECT_MANAGER' },
          update: { role: 'PROJECT_MANAGER' },
        });
        if (input.previousOwnerRole === 'REMOVE') {
          await tx.projectMembership.deleteMany({
            where: { projectId: input.projectId, userId: previousOwnerId },
          });
        } else {
          await tx.projectMembership.upsert({
            where: { projectId_userId: { projectId: input.projectId, userId: previousOwnerId } },
            create: {
              projectId: input.projectId,
              userId: previousOwnerId,
              role: previousMembershipRole,
            },
            update: { role: previousMembershipRole },
          });
        }
        const managers = await tx.projectMembership.count({
          where: { projectId: input.projectId, role: 'PROJECT_MANAGER' },
        });
        if (managers < 1)
          throw new AppError(
            409,
            'PROJECT_MANAGER_REQUIRED',
            'A project must retain at least one owner or project manager',
          );

        const now = new Date();
        const updated = await tx.project.updateMany({
          where: {
            id: input.projectId,
            workspaceId: input.workspaceId,
            ownerId: previousOwnerId,
            deletedAt: null,
          },
          data: { ownerId: input.newOwnerId, updatedAt: now },
        });
        if (updated.count !== 1)
          throw new AppError(
            409,
            'PROJECT_OWNERSHIP_CHANGED',
            'Project ownership changed before this transfer could complete',
          );

        const forcedAdminTransfer = !actorIsOwner;
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'project.ownership_transferred',
          targetType: 'Project',
          targetId: input.projectId,
          metadata: {
            actorId: input.userId,
            previousOwnerId,
            newOwnerId: input.newOwnerId,
            previousOwnerRole: previousOwnerResultingRole,
            previousOwnerRoleChoice: input.previousOwnerRole,
            forcedAdminTransfer,
          },
          ...context,
        });
        return {
          projectId: input.projectId,
          previousOwnerId,
          ownerId: input.newOwnerId,
          ownerRole: newMembership.role,
          previousOwnerRole: input.previousOwnerRole,
          previousOwnerResultingRole,
          forcedAdminTransfer,
          updatedAt: now,
        };
      });
    },

    async update(
      input: Input & { projectId: string } & UpdateProjectInput,
      context: RequestContext,
    ) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const access = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.UpdateProject,
      });
      if (access.project.status === 'ARCHIVED')
        throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
      const teamId = input.teamId === undefined ? access.project.teamId : input.teamId;
      let departmentId =
        input.departmentId === undefined ? access.project.departmentId : input.departmentId;
      if (teamId) {
        const team = await requireTeamAccess(prisma, {
          ...input,
          teamId,
          workspaceRole: workspace.effectiveRole,
          capability: TeamCapability.ViewTeam,
        });
        if (team.team.status !== 'ACTIVE' || team.team.deletedAt)
          throw new AppError(404, 'TEAM_NOT_FOUND', 'That team does not exist');
        if (team.team.departmentId) {
          if (departmentId && departmentId !== team.team.departmentId)
            throw new AppError(
              409,
              'PROJECT_ORGANIZATION_MISMATCH',
              'The project team and department must belong together',
            );
          departmentId = team.team.departmentId;
        }
      }
      if (departmentId)
        await requireDepartmentAccess(prisma, {
          ...input,
          departmentId,
          capability: DepartmentCapability.ManageProjects,
        });
      if (
        (input.visibility ?? access.project.visibility) === 'DEPARTMENT_TEAM' &&
        !teamId &&
        !departmentId
      ) {
        throw new AppError(
          400,
          'PROJECT_SCOPE_REQUIRED',
          'Department/team-only projects require a team or department',
        );
      }
      try {
        return await prisma.$transaction(async (tx) => {
          const row = await tx.project.update({
            where: { id: access.project.id },
            data: {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.key !== undefined ? { key: input.key.toUpperCase() } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
              ...(input.category !== undefined ? { category: input.category } : {}),
              ...(input.labels !== undefined ? { labels: input.labels } : {}),
              ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
              ...(input.status !== undefined ? { status: input.status } : {}),
              ...(input.teamId !== undefined ? { teamId } : {}),
              ...(input.departmentId !== undefined || input.teamId !== undefined
                ? { departmentId }
                : {}),
              ...(input.startDate !== undefined ? { startDate: dateOrNull(input.startDate) } : {}),
              ...(input.dueDate !== undefined ? { dueDate: dateOrNull(input.dueDate) } : {}),
            },
            include: projectInclude,
          });
          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: 'project.updated',
            targetType: 'Project',
            targetId: row.id,
            metadata: {
              visibility: row.visibility,
              status: row.status,
              name: row.name,
              key: row.key,
            },
            ...context,
          });
          const myMembership = await tx.projectMembership.findUnique({
            where: { projectId_userId: { projectId: row.id, userId: input.userId } },
          });
          return toSummary(
            row,
            effectiveProjectRole(
              access.workspaceRole,
              myMembership?.role ?? null,
              row.ownerId === input.userId,
            ),
          );
        });
      } catch (error) {
        return mapConflict(error);
      }
    },

    async archive(input: Input & { projectId: string }, context: RequestContext) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const access = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.ArchiveProject,
      });
      if (access.project.status === 'ARCHIVED')
        return { id: access.project.id, status: access.project.status };
      return prisma.$transaction(async (tx) => {
        const row = await tx.project.update({
          where: { id: access.project.id },
          data: { status: 'ARCHIVED' },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'project.archived',
          targetType: 'Project',
          targetId: row.id,
          metadata: { previousStatus: access.project.status },
          ...context,
        });
        return { id: row.id, status: row.status };
      });
    },

    async restore(input: Input & { projectId: string }, context: RequestContext) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const access = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.ArchiveProject,
      });
      if (access.project.status !== 'ARCHIVED')
        return { id: access.project.id, status: access.project.status };
      const previous = await prisma.auditLog.findFirst({
        where: { targetType: 'Project', targetId: access.project.id, action: 'project.archived' },
        orderBy: { createdAt: 'desc' },
        select: { metadata: true },
      });
      const status =
        previous?.metadata &&
        typeof previous.metadata === 'object' &&
        'previousStatus' in previous.metadata &&
        ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED'].includes(
          String(previous.metadata.previousStatus),
        )
          ? (previous.metadata.previousStatus as 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED')
          : 'PLANNING';
      return prisma.$transaction(async (tx) => {
        const row = await tx.project.update({ where: { id: access.project.id }, data: { status } });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'project.restored',
          targetType: 'Project',
          targetId: row.id,
          metadata: { status: row.status },
          ...context,
        });
        return { id: row.id, status: row.status };
      });
    },

    async remove(input: Input & { projectId: string }, context: RequestContext) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const access = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.DeleteProject,
      });
      await prisma.$transaction(async (tx) => {
        await tx.project.update({
          where: { id: access.project.id },
          data: { deletedAt: new Date() },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'project.deleted',
          targetType: 'Project',
          targetId: access.project.id,
          ...context,
        });
      });
      return { id: access.project.id, deleted: true };
    },

    async listMembers(input: Input & { projectId: string }) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const access = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.ManageMembers,
      });
      return prisma.projectMembership.findMany({
        where: { projectId: access.project.id },
        orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
        select: {
          userId: true,
          role: true,
          createdAt: true,
          user: { select: { id: true, name: true, email: true } },
        },
      });
    },

    async addMember(
      input: Input & { projectId: string; targetUserId: string; role: ProjectRole },
      context: RequestContext,
    ) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const access = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.ManageMembers,
      });
      if (access.project.status === 'ARCHIVED')
        throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
      const target = await prisma.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: input.workspaceId, userId: input.targetUserId },
        },
      });
      if (!target || target.status !== 'ACTIVE')
        throw new AppError(
          404,
          'WORKSPACE_MEMBER_NOT_FOUND',
          'That active workspace member does not exist',
        );
      if (input.targetUserId === access.project.ownerId && input.role !== 'PROJECT_MANAGER')
        throw new AppError(
          409,
          'PROJECT_OWNER_ROLE_REQUIRED',
          'The project owner must retain the project manager role',
        );
      return prisma.$transaction(async (tx) => {
        const membership = await tx.projectMembership.upsert({
          where: { projectId_userId: { projectId: access.project.id, userId: input.targetUserId } },
          create: { projectId: access.project.id, userId: input.targetUserId, role: input.role },
          update: { role: input.role },
          select: { projectId: true, userId: true, role: true, createdAt: true },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'project.member_added',
          targetType: 'ProjectMembership',
          targetId: membership.userId,
          metadata: { projectId: access.project.id, role: membership.role },
          ...context,
        });
        await createNotification(tx, {
          userId: input.targetUserId,
          type: 'MEMBERSHIP_CHANGED',
          title: 'Added to a project',
          data: { workspaceId: input.workspaceId, projectId: access.project.id },
        });
        return membership;
      });
    },

    async updateMember(
      input: Input & { projectId: string; targetUserId: string; role: ProjectRole },
      context: RequestContext,
    ) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const access = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.ManageMembers,
      });
      if (access.project.ownerId === input.targetUserId && input.role !== 'PROJECT_MANAGER')
        throw new AppError(
          409,
          'PROJECT_OWNER_ROLE_REQUIRED',
          'The project owner must retain the project manager role',
        );
      const existing = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: access.project.id, userId: input.targetUserId } },
      });
      if (!existing)
        throw new AppError(404, 'PROJECT_MEMBER_NOT_FOUND', 'That project member does not exist');
      return prisma.$transaction(async (tx) => {
        const row = await tx.projectMembership.update({
          where: { projectId_userId: { projectId: access.project.id, userId: input.targetUserId } },
          data: { role: input.role },
          select: { projectId: true, userId: true, role: true, createdAt: true },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'project.member_role_changed',
          targetType: 'ProjectMembership',
          targetId: row.userId,
          metadata: { projectId: access.project.id, previousRole: existing.role, role: row.role },
          ...context,
        });
        return row;
      });
    },

    async removeMember(
      input: Input & { projectId: string; targetUserId: string },
      context: RequestContext,
    ) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const access = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.ManageMembers,
      });
      if (access.project.ownerId === input.targetUserId)
        throw new AppError(
          409,
          'PROJECT_OWNER_CANNOT_BE_REMOVED',
          'Transfer project ownership before removing the project owner',
        );
      return prisma.$transaction(async (tx) => {
        const result = await tx.projectMembership.deleteMany({
          where: { projectId: access.project.id, userId: input.targetUserId },
        });
        if (!result.count)
          throw new AppError(404, 'PROJECT_MEMBER_NOT_FOUND', 'That project member does not exist');
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'project.member_removed',
          targetType: 'ProjectMembership',
          targetId: input.targetUserId,
          metadata: { projectId: access.project.id },
          ...context,
        });
        return { projectId: access.project.id, userId: input.targetUserId, removed: true };
      });
    },

    async activity(input: Input & { projectId: string; cursor?: Date; limit: number }) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const access = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.ViewProject,
      });
      const rows = await prisma.auditLog.findMany({
        where: {
          targetType: 'Project',
          targetId: access.project.id,
          ...(input.cursor ? { createdAt: { lt: input.cursor } } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: { id: true, action: true, actorId: true, metadata: true, createdAt: true },
      });
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit);
      return {
        items,
        nextCursor: hasMore ? (items.at(-1)?.createdAt.toISOString() ?? null) : null,
      };
    },

    async listMilestones(input: Input & { projectId: string }) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const access = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.ViewProject,
      });
      return prisma.projectMilestone.findMany({
        where: { projectId: access.project.id },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
    },

    async createMilestone(
      input: Input & {
        projectId: string;
        name: string;
        description?: string | null;
        dueDate?: string | null;
        position?: number;
      },
      context: RequestContext,
    ) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const access = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.UpdateProject,
      });
      if (access.project.status === 'ARCHIVED')
        throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
      return prisma.$transaction(async (tx) => {
        const milestone = await tx.projectMilestone.create({
          data: {
            projectId: access.project.id,
            name: input.name,
            description: input.description ?? null,
            dueDate: dateOrNull(input.dueDate) ?? null,
            position: input.position ?? 0,
          },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'project.milestone_created',
          targetType: 'Project',
          targetId: access.project.id,
          metadata: { milestoneId: milestone.id, name: milestone.name },
          ...context,
        });
        return milestone;
      });
    },

    async updateMilestone(
      input: Input & {
        projectId: string;
        milestoneId: string;
        name?: string;
        description?: string | null;
        dueDate?: string | null;
        completed?: boolean;
        position?: number;
      },
      context: RequestContext,
    ) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const access = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.UpdateProject,
      });
      if (access.project.status === 'ARCHIVED')
        throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
      const existing = await prisma.projectMilestone.findFirst({
        where: { id: input.milestoneId, projectId: access.project.id },
      });
      if (!existing)
        throw new AppError(
          404,
          'PROJECT_MILESTONE_NOT_FOUND',
          'That project milestone does not exist',
        );
      return prisma.$transaction(async (tx) => {
        const milestone = await tx.projectMilestone.update({
          where: { id: existing.id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.dueDate !== undefined ? { dueDate: dateOrNull(input.dueDate) } : {}),
            ...(input.completed !== undefined
              ? { completedAt: input.completed ? (existing.completedAt ?? new Date()) : null }
              : {}),
            ...(input.position !== undefined ? { position: input.position } : {}),
          },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'project.milestone_updated',
          targetType: 'Project',
          targetId: access.project.id,
          metadata: { milestoneId: milestone.id },
          ...context,
        });
        return milestone;
      });
    },

    async deleteMilestone(
      input: Input & { projectId: string; milestoneId: string },
      context: RequestContext,
    ) {
      const workspace = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const access = await requireProjectAccess(prisma, {
        ...input,
        workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.UpdateProject,
      });
      if (access.project.status === 'ARCHIVED')
        throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
      const existing = await prisma.projectMilestone.findFirst({
        where: { id: input.milestoneId, projectId: access.project.id },
        select: { id: true },
      });
      if (!existing)
        throw new AppError(
          404,
          'PROJECT_MILESTONE_NOT_FOUND',
          'That project milestone does not exist',
        );
      await prisma.$transaction(async (tx) => {
        await tx.projectMilestone.delete({ where: { id: existing.id } });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'project.milestone_deleted',
          targetType: 'Project',
          targetId: access.project.id,
          metadata: { milestoneId: existing.id },
          ...context,
        });
      });
      return { id: existing.id, deleted: true };
    },
  };
}
