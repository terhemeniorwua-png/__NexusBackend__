import { Prisma, type PrismaClient, type Project, type ProjectRole } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { TeamAuditAction, recordAuditEvent } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { AppError } from '../../utils/errors';
import { assertProjectWritable } from './project-archive';
import {
  DepartmentCapability,
  ProjectPermission,
  TeamCapability,
  WorkspaceCapability,
  assertMayManageProjectMember,
  authorizeProject,
  maximumProjectRoleForMember,
  organizationRoleCanOwnProjects,
  requireDepartmentAccess,
  requireTeamAccess,
  requireWorkspaceAccess,
  type ProjectPermissionValue,
} from '../authorization';
import {
  effectiveWorkspaceRole,
  isOrganizationRoleForWorkspace,
} from '../authorization/organization-role';
import type { RequestContext } from '../auth/auth.types';
import type {
  AddProjectTeamInput,
  AssignProjectManagersInput,
  BulkAddProjectMembersByTeamInput,
  CompleteProjectInput,
  CreateProjectInput,
  ListProjectsQuery,
  UpdateProjectInput,
} from './project.schemas';
import { projectVisibleToUser } from './project-visibility';

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
  | 'objectives'
  | 'category'
  | 'labels'
  | 'status'
  | 'visibility'
  | 'commentPolicy'
  | 'startDate'
  | 'dueDate'
  | 'ownerId'
  | 'completedAt'
  | 'completedById'
  | 'archivedAt'
  | 'archivedById'
  | 'createdAt'
  | 'updatedAt'
> & {
  owner: { id: string; name: string };
  teamIds: string[];
  teams: Array<{ id: string; name: string; status: 'ACTIVE' | 'ARCHIVED' }>;
  memberCount: number;
  taskCount: number;
  myRole: ProjectRole | null;
  overdue: boolean;
};

const projectInclude = {
  owner: { select: { id: true, name: true } },
  projectTeams: {
    include: { team: { select: { id: true, name: true, status: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
  _count: { select: { members: true, tasks: true } },
} as const;

function isProjectOverdue(project: Pick<Project, 'dueDate' | 'status'>): boolean {
  if (!project.dueDate) return false;
  if (project.status === 'COMPLETED' || project.status === 'ARCHIVED') return false;
  return project.dueDate.getTime() < Date.now();
}

function toSummary(
  row: Prisma.ProjectGetPayload<{ include: typeof projectInclude }>,
  myRole: ProjectRole | null,
): ProjectSummary {
  const { _count, projectTeams, ...project } = row;
  const teams = projectTeams.map((pt) => ({
    id: pt.team.id,
    name: pt.team.name,
    status: pt.team.status,
  }));
  const teamIds = teams.map((t) => t.id);
  return {
    ...project,
    teamIds,
    teams,
    memberCount: _count.members,
    taskCount: _count.tasks,
    myRole,
    overdue: isProjectOverdue(project),
  };
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

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function normalizeTeamIds(input: { teamId?: string | null; teamIds?: string[] }): string[] {
  const ids = [...(input.teamIds ?? [])];
  if (input.teamId) ids.unshift(input.teamId);
  return uniqueIds(ids.filter(Boolean));
}

function taskIsComplete(status: string): boolean {
  return status === 'APPROVED';
}

export function createProjectService(prisma: PrismaClient = getPrismaClient()) {
  const authorize = async (
    input: Input & { projectId: string },
    permission: ProjectPermissionValue,
  ) => {
    const workspace = await requireWorkspaceAccess(prisma, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });
    return authorizeProject(prisma, {
      actor: {
        userId: input.userId,
        workspaceId: input.workspaceId,
        workspaceRole: workspace.effectiveRole,
      },
      projectId: input.projectId,
      permission,
    });
  };

  async function syncProjectTeams(
    tx: Prisma.TransactionClient,
    params: {
      workspaceId: string;
      projectId: string;
      actorId: string;
      previousTeamIds: string[];
      nextTeamIds: string[];
      context: RequestContext;
    },
  ): Promise<void> {
    const prev = new Set(params.previousTeamIds);
    const next = new Set(params.nextTeamIds);
    const toAdd = params.nextTeamIds.filter((id) => !prev.has(id));
    const toRemove = params.previousTeamIds.filter((id) => !next.has(id));

    if (toRemove.length > 0) {
      await tx.projectTeam.deleteMany({
        where: { projectId: params.projectId, teamId: { in: toRemove } },
      });
    }
    if (toAdd.length > 0) {
      await tx.projectTeam.createMany({
        data: toAdd.map((teamId) => ({ projectId: params.projectId, teamId })),
        skipDuplicates: true,
      });
    }

    for (const teamId of toAdd) {
      await recordAuditEvent(tx, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        action: TeamAuditAction.ProjectLinked,
        targetType: 'Team',
        targetId: teamId,
        metadata: { projectId: params.projectId, teamId },
        ...params.context,
      });
    }
    for (const teamId of toRemove) {
      await recordAuditEvent(tx, {
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        action: TeamAuditAction.ProjectUnlinked,
        targetType: 'Team',
        targetId: teamId,
        metadata: { projectId: params.projectId, teamId },
        ...params.context,
      });
    }
  }

  async function resolveTeamScope(
    input: Input & {
      workspaceRole: string;
      teamIds: string[];
      departmentId?: string | null;
    },
  ): Promise<{ primaryTeamId: string | null; departmentId: string | null }> {
    let departmentId = input.departmentId ?? null;
    const primaryTeamId: string | null = input.teamIds[0] ?? null;

    for (const teamId of input.teamIds) {
      const team = await requireTeamAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        teamId,
        workspaceRole: input.workspaceRole as never,
        capability: TeamCapability.ViewTeam,
      });
      if (team.team.status !== 'ACTIVE' || team.team.deletedAt) {
        throw new AppError(404, 'TEAM_NOT_FOUND', 'That team does not exist');
      }
      if (team.team.departmentId) {
        if (departmentId && departmentId !== team.team.departmentId) {
          throw new AppError(
            409,
            'PROJECT_ORGANIZATION_MISMATCH',
            'The project teams and department must belong together',
          );
        }
        departmentId = team.team.departmentId;
      }
    }

    if (departmentId) {
      await requireDepartmentAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        departmentId,
        capability: DepartmentCapability.ManageProjects,
      });
    }

    return { primaryTeamId, departmentId };
  }

  async function loadProjectTeamIds(projectId: string): Promise<string[]> {
    const rows = await prisma.projectTeam.findMany({
      where: { projectId },
      select: { teamId: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.teamId);
  }

  async function notifyProjectMembers(
    tx: Prisma.TransactionClient | PrismaClient,
    projectId: string,
    workspaceId: string,
    notification: { type: 'PROJECT_UPDATE' | 'MEMBERSHIP_CHANGED'; title: string; body?: string },
    excludeUserId?: string,
  ): Promise<void> {
    const members = await tx.projectMembership.findMany({
      where: { projectId },
      select: { userId: true },
    });
    for (const m of members) {
      if (excludeUserId && m.userId === excludeUserId) continue;
      await createNotification(tx, {
        userId: m.userId,
        type: notification.type,
        title: notification.title,
        ...(notification.body ? { body: notification.body } : {}),
        data: { workspaceId, projectId },
      });
    }
  }

  return {
    async list(input: Input & ListProjectsQuery) {
      const access = await requireWorkspaceAccess(prisma, {
        ...input,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const manager =
        access.effectiveRole === 'OWNER' || access.effectiveRole === 'PROJECT_MANAGER';
      const unrestrictedLegacyManager = manager && !access.membership.organizationRole;

      const teamFilter = input.teamId
        ? { OR: [{ teamId: input.teamId }, { projectTeams: { some: { teamId: input.teamId } } }] }
        : {};

      const rows = await prisma.project.findMany({
        where: {
          workspaceId: input.workspaceId,
          deletedAt: null,
          ...(input.status ? { status: input.status } : {}),
          ...(!input.includeArchived ? { status: input.status ?? { not: 'ARCHIVED' } } : {}),
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...teamFilter,
          ...(input.departmentId ? { departmentId: input.departmentId } : {}),
          ...(input.search
            ? {
                OR: [
                  { name: { contains: input.search, mode: 'insensitive' } },
                  { key: { contains: input.search, mode: 'insensitive' } },
                ],
              }
            : {}),
          ...(!unrestrictedLegacyManager ? { AND: [projectVisibleToUser(input.userId)] } : {}),
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

      const requestedTeamIds = normalizeTeamIds({ teamId: input.teamId, teamIds: input.teamIds });
      const scoped = await resolveTeamScope({
        userId: input.userId,
        workspaceId: input.workspaceId,
        workspaceRole: workspace.effectiveRole,
        teamIds: requestedTeamIds,
        departmentId: input.departmentId ?? null,
      });
      const primaryTeamId = scoped.primaryTeamId;
      const departmentId = scoped.departmentId;

      if (
        input.visibility === 'DEPARTMENT_TEAM' &&
        requestedTeamIds.length === 0 &&
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
          const project = await tx.project.create({
            data: {
              workspaceId: input.workspaceId,
              ownerId: input.userId,
              name: input.name,
              key: input.key.toUpperCase(),
              description: input.description ?? null,
              objectives:
                input.objectives === undefined
                  ? undefined
                  : input.objectives === null
                    ? Prisma.JsonNull
                    : (input.objectives as Prisma.InputJsonValue),
              category: input.category ?? null,
              labels: input.labels ?? [],
              visibility: input.visibility,
              teamId: primaryTeamId,
              departmentId,
              startDate: dateOrNull(input.startDate) ?? null,
              dueDate: dateOrNull(input.dueDate) ?? null,
            },
            include: projectInclude,
          });
          await tx.projectMembership.create({
            data: { projectId: project.id, userId: input.userId, role: 'PROJECT_MANAGER' },
          });

          if (requestedTeamIds.length > 0) {
            await syncProjectTeams(tx, {
              workspaceId: input.workspaceId,
              projectId: project.id,
              actorId: input.userId,
              previousTeamIds: [],
              nextTeamIds: requestedTeamIds,
              context,
            });
          }

          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: 'project.created',
            targetType: 'Project',
            targetId: project.id,
            metadata: {
              name: project.name,
              key: project.key,
              visibility: project.visibility,
              teamIds: requestedTeamIds,
            },
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
      const access = await authorize(input, ProjectPermission.View);
      const row = await prisma.project.findUniqueOrThrow({
        where: { id: access.project.id },
        include: projectInclude,
      });
      return toSummary(row, access.projectRole);
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
      const initialAccess = await authorize(input, ProjectPermission.View);
      assertProjectWritable(initialAccess.project);
      if (input.newOwnerId === initialAccess.project.ownerId)
        throw new AppError(
          400,
          'PROJECT_OWNER_UNCHANGED',
          'The new owner must be different from the current owner',
        );

      const initiallyOwner = initialAccess.project.ownerId === input.userId;
      const initiallyAdmin =
        initialAccess.workspaceRole === 'OWNER' ||
        initialAccess.workspaceRole === 'PROJECT_MANAGER';
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

      // Org owners/admins only hold read access on projects they are not members of, so the
      // owner-or-workspace-admin check above is the transfer rule. Non-admin owners must
      // still hold ManageMembers.
      if (!initiallyAdmin && !initialAccess.permissions.includes(ProjectPermission.ManageMembers)) {
        throw new AppError(
          403,
          'PERMISSION_DENIED',
          'Your project role does not allow this action',
          { requiredPermission: ProjectPermission.ManageMembers },
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

        const txAccess = await authorizeProject(tx, {
          actor: {
            userId: input.userId,
            workspaceId: input.workspaceId,
            workspaceRole: actorRole,
          },
          projectId: input.projectId,
          permission: ProjectPermission.View,
        });
        if (
          !actorIsWorkspaceAdmin &&
          !txAccess.permissions.includes(ProjectPermission.ManageMembers)
        ) {
          throw new AppError(
            403,
            'PERMISSION_DENIED',
            'Your project role does not allow this action',
            { requiredPermission: ProjectPermission.ManageMembers },
          );
        }

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
        // has team associations, membership in any associated active team is sufficient.
        if (locked.visibility === 'DEPARTMENT_TEAM') {
          let eligibleParentMember = false;
          const associatedTeamRows = await tx.projectTeam.findMany({
            where: { projectId: locked.id },
            select: { teamId: true },
          });
          const teamIds = uniqueIds(
            [locked.teamId, ...associatedTeamRows.map((r) => r.teamId)].filter(
              (id): id is string => Boolean(id),
            ),
          );
          if (teamIds.length > 0) {
            const teamMember = await tx.teamMembership.findFirst({
              where: {
                userId: input.newOwnerId,
                teamId: { in: teamIds },
                team: { workspaceId: input.workspaceId, status: 'ACTIVE', deletedAt: null },
              },
              select: { id: true },
            });
            eligibleParentMember = Boolean(teamMember);
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
      const access = await authorize(input, ProjectPermission.Update);
      assertProjectWritable(access.project);

      const existingTeamIds = await loadProjectTeamIds(access.project.id);
      const hasTeamInput = input.teamId !== undefined || input.teamIds !== undefined;
      const nextTeamIds = hasTeamInput
        ? normalizeTeamIds({
            teamId: input.teamId === undefined ? access.project.teamId : input.teamId,
            teamIds: input.teamIds,
          })
        : uniqueIds([access.project.teamId, ...existingTeamIds].filter((id): id is string => Boolean(id)));

      let departmentId =
        input.departmentId === undefined ? access.project.departmentId : input.departmentId;

      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      if (hasTeamInput || input.departmentId !== undefined) {
        const scoped = await resolveTeamScope({
          userId: input.userId,
          workspaceId: input.workspaceId,
          workspaceRole: workspace.effectiveRole,
          teamIds: nextTeamIds,
          departmentId,
        });
        departmentId = scoped.departmentId;
      } else if (access.project.teamId) {
        // preserve existing behavior: ensure single team still valid? not necessary
      }

      const primaryTeamId = nextTeamIds[0] ?? null;
      const effectiveVisibility = input.visibility ?? access.project.visibility;
      if (effectiveVisibility === 'DEPARTMENT_TEAM' && nextTeamIds.length === 0 && !departmentId) {
        throw new AppError(
          400,
          'PROJECT_SCOPE_REQUIRED',
          'Department/team-only projects require a team or department',
        );
      }

      // Handle completion/archival timestamps when status changes via update.
      const statusChanging = input.status !== undefined && input.status !== access.project.status;
      const completing = statusChanging && input.status === 'COMPLETED';
      const uncompleting = statusChanging && access.project.status === 'COMPLETED' && input.status !== 'COMPLETED';
      const now = new Date();

      try {
        return await prisma.$transaction(async (tx) => {
          const row = await tx.project.update({
            where: { id: access.project.id },
            data: {
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.key !== undefined ? { key: input.key.toUpperCase() } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
              ...(input.objectives !== undefined
                ? {
                    objectives:
                      input.objectives === null
                        ? Prisma.JsonNull
                        : (input.objectives as Prisma.InputJsonValue),
                  }
                : {}),
              ...(input.category !== undefined ? { category: input.category } : {}),
              ...(input.labels !== undefined ? { labels: input.labels } : {}),
              ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
              ...(input.commentPolicy !== undefined ? { commentPolicy: input.commentPolicy } : {}),
              ...(input.status !== undefined ? { status: input.status } : {}),
              ...(hasTeamInput ? { teamId: primaryTeamId } : {}),
              ...(hasTeamInput || input.departmentId !== undefined ? { departmentId } : {}),
              ...(input.startDate !== undefined ? { startDate: dateOrNull(input.startDate) } : {}),
              ...(input.dueDate !== undefined ? { dueDate: dateOrNull(input.dueDate) } : {}),
              ...(completing
                ? { completedAt: (access.project as { completedAt?: Date | null }).completedAt ?? now, completedById: input.userId }
                : {}),
              ...(uncompleting ? { completedAt: null, completedById: null } : {}),
            },
            include: projectInclude,
          });

          if (hasTeamInput) {
            await syncProjectTeams(tx, {
              workspaceId: input.workspaceId,
              projectId: row.id,
              actorId: input.userId,
              previousTeamIds: existingTeamIds,
              nextTeamIds,
              context,
            });
          }

          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: completing ? 'project.completed' : 'project.updated',
            targetType: 'Project',
            targetId: row.id,
            metadata: {
              visibility: row.visibility,
              status: row.status,
              name: row.name,
              key: row.key,
              ...(hasTeamInput ? { teamIds: nextTeamIds } : {}),
            },
            ...context,
          });

          if (completing) {
            await notifyProjectMembers(
              tx,
              row.id,
              input.workspaceId,
              { type: 'PROJECT_UPDATE', title: `Project "${row.name}" completed` },
              input.userId,
            );
          }

          const myMembership = await tx.projectMembership.findUnique({
            where: { projectId_userId: { projectId: row.id, userId: input.userId } },
          });
          return toSummary(row, access.projectRole ?? myMembership?.role ?? null);
        });
      } catch (error) {
        return mapConflict(error);
      }
    },

    async complete(
      input: Input & { projectId: string } & CompleteProjectInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.Update);
      assertProjectWritable(access.project);
      if (access.project.status === 'COMPLETED') {
        const row = await prisma.project.findUniqueOrThrow({ where: { id: access.project.id }, include: projectInclude });
        return toSummary(row, access.projectRole);
      }

      const openTasksCount = await prisma.task.count({
        where: {
          projectId: access.project.id,
          deletedAt: null,
          archivedAt: null,
          status: { not: 'APPROVED' },
        },
      });
      if (openTasksCount > 0 && !input.force) {
        throw new AppError(
          409,
          'PROJECT_HAS_OPEN_TASKS',
          'Project has open tasks. Provide force=true to complete anyway.',
          { details: { openTasksCount } },
        );
      }

      const now = new Date();
      return prisma.$transaction(async (tx) => {
        const row = await tx.project.update({
          where: { id: access.project.id },
          data: {
            status: 'COMPLETED',
            completedAt: (access.project as { completedAt?: Date | null }).completedAt ?? now,
            completedById: input.userId,
          },
          include: projectInclude,
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'project.completed',
          targetType: 'Project',
          targetId: row.id,
          metadata: { previousStatus: access.project.status, openTasksCount, forced: input.force ?? false },
          ...context,
        });
        await notifyProjectMembers(
          tx,
          row.id,
          input.workspaceId,
          { type: 'PROJECT_UPDATE', title: `Project "${row.name}" completed` },
          input.userId,
        );
        return toSummary(row, access.projectRole);
      });
    },

    async archive(input: Input & { projectId: string }, context: RequestContext) {
      const access = await authorize(input, ProjectPermission.Archive);
      if (access.project.status === 'ARCHIVED')
        return { id: access.project.id, status: access.project.status };
      const now = new Date();
      return prisma.$transaction(async (tx) => {
        const row = await tx.project.update({
          where: { id: access.project.id },
          data: { status: 'ARCHIVED', archivedAt: now, archivedById: input.userId },
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
        await notifyProjectMembers(
          tx,
          row.id,
          input.workspaceId,
          { type: 'PROJECT_UPDATE', title: `Project "${access.project.name}" archived` },
          input.userId,
        );
        return { id: row.id, status: row.status };
      });
    },

    async restore(input: Input & { projectId: string }, context: RequestContext) {
      const access = await authorize(input, ProjectPermission.Archive);
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
        const row = await tx.project.update({
          where: { id: access.project.id },
          data: { status, archivedAt: null, archivedById: null },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'project.restored',
          targetType: 'Project',
          targetId: row.id,
          metadata: { status: row.status },
          ...context,
        });
        await notifyProjectMembers(
          tx,
          row.id,
          input.workspaceId,
          { type: 'PROJECT_UPDATE', title: `Project "${access.project.name}" restored` },
          input.userId,
        );
        return { id: row.id, status: row.status };
      });
    },

    async remove(input: Input & { projectId: string }, context: RequestContext) {
      const access = await authorize(input, ProjectPermission.Delete);
      assertProjectWritable(access.project);
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
      const access = await authorize(input, ProjectPermission.View);
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
      const access = await authorize(input, ProjectPermission.ManageMembers);
      assertProjectWritable(access.project);
      const target = await prisma.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: input.workspaceId, userId: input.targetUserId },
        },
        include: { workspace: { select: { type: true } } },
      });
      if (!target || target.status !== 'ACTIVE')
        throw new AppError(
          404,
          'WORKSPACE_MEMBER_NOT_FOUND',
          'That active workspace member does not exist',
        );

      const existing = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: access.project.id, userId: input.targetUserId } },
        select: { role: true },
      });
      const targetCeiling = maximumProjectRoleForMember({
        workspaceType: target.workspace.type,
        workspaceRole: effectiveWorkspaceRole(
          target.workspace.type,
          target.role,
          target.organizationRole,
        ),
        organizationRole: target.organizationRole,
      });
      assertMayManageProjectMember({
        actorId: input.userId,
        actorIsWorkspaceAdmin: access.isWorkspaceAdmin,
        actorProjectRole: access.projectRole,
        targetUserId: input.targetUserId,
        targetProjectRole: existing?.role ?? input.role,
        targetIsOwner: input.targetUserId === access.project.ownerId,
        targetCeiling,
        requestedRole: input.role,
        action: existing ? 'update' : 'add',
      });

      return prisma.$transaction(async (tx) => {
        const managers =
          existing?.role === 'PROJECT_MANAGER' && input.role !== 'PROJECT_MANAGER'
            ? await tx.projectMembership.count({
                where: { projectId: access.project.id, role: 'PROJECT_MANAGER' },
              })
            : null;
        if (managers !== null && managers <= 1)
          throw new AppError(
            409,
            'PROJECT_LAST_MANAGER',
            'A project must retain at least one project manager',
          );

        const membership = await tx.projectMembership.upsert({
          where: { projectId_userId: { projectId: access.project.id, userId: input.targetUserId } },
          create: { projectId: access.project.id, userId: input.targetUserId, role: input.role },
          update: { role: input.role },
          select: { projectId: true, userId: true, role: true, createdAt: true },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: existing ? 'project.member_role_changed' : 'project.member_added',
          targetType: 'ProjectMembership',
          targetId: membership.userId,
          metadata: {
            projectId: access.project.id,
            ...(existing ? { previousRole: existing.role } : {}),
            role: membership.role,
          },
          ...context,
        });
        if (!existing) {
          await createNotification(tx, {
            userId: input.targetUserId,
            type: 'MEMBERSHIP_CHANGED',
            title: 'Added to a project',
            data: { workspaceId: input.workspaceId, projectId: access.project.id },
          });
        }
        return membership;
      });
    },

    async bulkAddMembersByTeam(
      input: Input & { projectId: string } & BulkAddProjectMembersByTeamInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.ManageMembers);
      assertProjectWritable(access.project);

      // Verify team is in same workspace and accessible in context
      const team = await prisma.team.findFirst({
        where: { id: input.teamId, workspaceId: input.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!team) throw new AppError(404, 'TEAM_NOT_FOUND', 'That team does not exist');

      const teamMembers = await prisma.teamMembership.findMany({
        where: { teamId: input.teamId },
        select: { userId: true },
      });

      const added: Array<{ userId: string; role: ProjectRole }> = [];
      const skipped: Array<{ userId: string; reason: string }> = [];

      for (const tm of teamMembers) {
        const targetWs = await prisma.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: tm.userId } },
          include: { workspace: { select: { type: true } } },
        });
        if (!targetWs || targetWs.status !== 'ACTIVE') {
          skipped.push({ userId: tm.userId, reason: 'WORKSPACE_MEMBER_NOT_ACTIVE' });
          continue;
        }
        const existing = await prisma.projectMembership.findUnique({
          where: { projectId_userId: { projectId: access.project.id, userId: tm.userId } },
          select: { role: true },
        });
        if (existing) {
          skipped.push({ userId: tm.userId, reason: 'ALREADY_A_MEMBER' });
          continue;
        }
        try {
          const targetCeiling = maximumProjectRoleForMember({
            workspaceType: targetWs.workspace.type,
            workspaceRole: effectiveWorkspaceRole(
              targetWs.workspace.type,
              targetWs.role,
              targetWs.organizationRole,
            ),
            organizationRole: targetWs.organizationRole,
          });
          assertMayManageProjectMember({
            actorId: input.userId,
            actorIsWorkspaceAdmin: access.isWorkspaceAdmin,
            actorProjectRole: access.projectRole,
            targetUserId: tm.userId,
            targetProjectRole: input.role,
            targetIsOwner: tm.userId === access.project.ownerId,
            targetCeiling,
            requestedRole: input.role,
            action: 'add',
          });
        } catch {
          skipped.push({ userId: tm.userId, reason: 'NOT_ELIGIBLE' });
          continue;
        }

        await prisma.$transaction(async (tx) => {
          await tx.projectMembership.create({
            data: { projectId: access.project.id, userId: tm.userId, role: input.role },
          });
          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: 'project.member_added',
            targetType: 'ProjectMembership',
            targetId: tm.userId,
            metadata: { projectId: access.project.id, role: input.role, source: 'team_bulk', teamId: input.teamId },
            ...context,
          });
          await createNotification(tx, {
            userId: tm.userId,
            type: 'MEMBERSHIP_CHANGED',
            title: 'Added to a project',
            data: { workspaceId: input.workspaceId, projectId: access.project.id, teamId: input.teamId },
          });
        });
        added.push({ userId: tm.userId, role: input.role });
      }

      return { teamId: input.teamId, added, skipped };
    },

    async assignManagers(
      input: Input & { projectId: string } & AssignProjectManagersInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.ManageMembers);
      assertProjectWritable(access.project);

      const uniqueUserIds = uniqueIds(input.userIds);
      const assigned: Array<{ userId: string; role: ProjectRole }> = [];
      for (const targetUserId of uniqueUserIds) {
        const result = await this.addMember(
          { userId: input.userId, workspaceId: input.workspaceId, projectId: input.projectId, targetUserId, role: 'PROJECT_MANAGER' },
          context,
        );
        assigned.push({ userId: result.userId, role: result.role });
      }
      return { projectId: input.projectId, managers: assigned };
    },

    async updateMember(
      input: Input & { projectId: string; targetUserId: string; role: ProjectRole },
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.ManageMembers);
      assertProjectWritable(access.project);
      const existing = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: access.project.id, userId: input.targetUserId } },
      });
      if (!existing)
        throw new AppError(404, 'PROJECT_MEMBER_NOT_FOUND', 'That project member does not exist');
      const target = await prisma.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: input.workspaceId, userId: input.targetUserId },
        },
        include: { workspace: { select: { type: true } } },
      });
      if (!target || target.status !== 'ACTIVE')
        throw new AppError(
          404,
          'WORKSPACE_MEMBER_NOT_FOUND',
          'That active workspace member does not exist',
        );
      const targetCeiling = maximumProjectRoleForMember({
        workspaceType: target.workspace.type,
        workspaceRole: effectiveWorkspaceRole(
          target.workspace.type,
          target.role,
          target.organizationRole,
        ),
        organizationRole: target.organizationRole,
      });
      assertMayManageProjectMember({
        actorId: input.userId,
        actorIsWorkspaceAdmin: access.isWorkspaceAdmin,
        actorProjectRole: access.projectRole,
        targetUserId: input.targetUserId,
        targetProjectRole: existing.role,
        targetIsOwner: access.project.ownerId === input.targetUserId,
        targetCeiling,
        requestedRole: input.role,
        action: 'update',
      });
      return prisma.$transaction(async (tx) => {
        const managers =
          existing.role === 'PROJECT_MANAGER' && input.role !== 'PROJECT_MANAGER'
            ? await tx.projectMembership.count({
                where: { projectId: access.project.id, role: 'PROJECT_MANAGER' },
              })
            : null;
        if (managers !== null && managers <= 1)
          throw new AppError(
            409,
            'PROJECT_LAST_MANAGER',
            'A project must retain at least one project manager',
          );
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
      const access = await authorize(input, ProjectPermission.ManageMembers);
      assertProjectWritable(access.project);
      const existing = await prisma.projectMembership.findUnique({
        where: { projectId_userId: { projectId: access.project.id, userId: input.targetUserId } },
        select: { role: true },
      });
      if (!existing)
        throw new AppError(404, 'PROJECT_MEMBER_NOT_FOUND', 'That project member does not exist');

      const target = await prisma.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: input.workspaceId, userId: input.targetUserId },
        },
        include: { workspace: { select: { type: true } } },
      });
      assertMayManageProjectMember({
        actorId: input.userId,
        actorIsWorkspaceAdmin: access.isWorkspaceAdmin,
        actorProjectRole: access.projectRole,
        targetUserId: input.targetUserId,
        targetProjectRole: existing.role,
        targetIsOwner: access.project.ownerId === input.targetUserId,
        targetCeiling: target
          ? maximumProjectRoleForMember({
              workspaceType: target.workspace.type,
              workspaceRole: effectiveWorkspaceRole(
                target.workspace.type,
                target.role,
                target.organizationRole,
              ),
              organizationRole: target.organizationRole,
            })
          : 'VIEWER',
        action: 'remove',
      });

      return prisma.$transaction(async (tx) => {
        if (existing.role === 'PROJECT_MANAGER') {
          const managers = await tx.projectMembership.count({
            where: { projectId: access.project.id, role: 'PROJECT_MANAGER' },
          });
          if (managers <= 1)
            throw new AppError(
              409,
              'PROJECT_LAST_MANAGER',
              'A project must retain at least one project manager',
            );
        }
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
          metadata: { projectId: access.project.id, role: existing.role },
          ...context,
        });
        await createNotification(tx, {
          userId: input.targetUserId,
          type: 'MEMBERSHIP_CHANGED',
          title: 'Removed from a project',
          body: `Your access to project "${access.project.name}" was removed.`,
          data: { workspaceId: input.workspaceId, projectId: access.project.id },
        });
        return { projectId: access.project.id, userId: input.targetUserId, removed: true };
      });
    },

    async activity(input: Input & { projectId: string; cursor?: Date; limit: number }) {
      const access = await authorize(input, ProjectPermission.View);
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
      const page = rows.slice(0, input.limit);
      const actorIds = uniqueIds(page.map((r) => r.actorId).filter((id): id is string => Boolean(id)));
      const actors = actorIds.length
        ? await prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, name: true, email: true },
          })
        : [];
      const actorById = new Map(actors.map((a) => [a.id, a]));
      const items = page.map((r) => {
        const actor = r.actorId ? actorById.get(r.actorId) ?? null : null;
        return {
          id: r.id,
          action: r.action,
          actorId: r.actorId ?? null,
          actor: actor ? { id: actor.id, name: actor.name, email: actor.email } : null,
          metadata: r.metadata,
          createdAt: r.createdAt,
          timestamp: r.createdAt,
        };
      });
      return {
        items,
        nextCursor: hasMore ? (items.at(-1)?.createdAt.toISOString() ?? null) : null,
      };
    },

    async progress(input: Input & { projectId: string }) {
      const access = await authorize(input, ProjectPermission.View);
      const now = new Date();
      const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      const [statusGroups, overdueCount, upcoming, milestones, milestoneTaskGroups] = await Promise.all([
        prisma.task.groupBy({
          by: ['status'],
          where: { projectId: access.project.id, deletedAt: null, archivedAt: null },
          _count: { _all: true },
        }),
        prisma.task.count({
          where: {
            projectId: access.project.id,
            deletedAt: null,
            archivedAt: null,
            dueDate: { lt: now },
            status: { not: 'APPROVED' },
          },
        }),
        prisma.task.findMany({
          where: {
            projectId: access.project.id,
            deletedAt: null,
            archivedAt: null,
            dueDate: { gte: now, lte: in7Days },
            status: { not: 'APPROVED' },
          },
          orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
          take: 10,
          select: { id: true, key: true, title: true, dueDate: true, status: true, priority: true },
        }),
        prisma.projectMilestone.findMany({
          where: { projectId: access.project.id },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        }),
        prisma.task.groupBy({
          by: ['milestoneId', 'status'],
          where: {
            projectId: access.project.id,
            deletedAt: null,
            archivedAt: null,
            milestoneId: { not: null },
          },
          _count: { _all: true },
        }),
      ]);

      const taskCountsByStatus: Record<string, number> = {
        ASSIGNED: 0,
        IN_PROGRESS: 0,
        SUBMITTED: 0,
        UNDER_REVIEW: 0,
        APPROVED: 0,
        CHANGES_REQUESTED: 0,
      };
      let totalTasks = 0;
      let completedTasks = 0;
      for (const g of statusGroups) {
        taskCountsByStatus[g.status] = g._count._all;
        totalTasks += g._count._all;
        if (taskIsComplete(g.status)) completedTasks += g._count._all;
      }

      const milestoneProgressMap = new Map<string, { total: number; completed: number }>();
      for (const g of milestoneTaskGroups) {
        if (!g.milestoneId) continue;
        const entry = milestoneProgressMap.get(g.milestoneId) ?? { total: 0, completed: 0 };
        entry.total += g._count._all;
        if (taskIsComplete(g.status)) entry.completed += g._count._all;
        milestoneProgressMap.set(g.milestoneId, entry);
      }

      return {
        projectId: access.project.id,
        taskCountsByStatus,
        totalTasks,
        completedTasks,
        percentComplete: totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100),
        overdueCount,
        upcomingDeadlines: upcoming,
        milestones: milestones.map((m) => {
          const mp = milestoneProgressMap.get(m.id) ?? { total: 0, completed: 0 };
          return {
            id: m.id,
            name: m.name,
            dueDate: m.dueDate,
            completedAt: m.completedAt,
            progress: {
              completedTasks: mp.completed,
              totalTasks: mp.total,
              percentComplete: mp.total === 0 ? 0 : Math.round((mp.completed / mp.total) * 100),
            },
          };
        }),
      };
    },

    async listMilestones(input: Input & { projectId: string }) {
      const access = await authorize(input, ProjectPermission.View);
      const milestones = await prisma.projectMilestone.findMany({
        where: { projectId: access.project.id },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      const groups = await prisma.task.groupBy({
        by: ['milestoneId', 'status'],
        where: { projectId: access.project.id, deletedAt: null, archivedAt: null, milestoneId: { not: null } },
        _count: { _all: true },
      });
      const progressMap = new Map<string, { total: number; completed: number }>();
      for (const g of groups) {
        if (!g.milestoneId) continue;
        const entry = progressMap.get(g.milestoneId) ?? { total: 0, completed: 0 };
        entry.total += g._count._all;
        if (taskIsComplete(g.status)) entry.completed += g._count._all;
        progressMap.set(g.milestoneId, entry);
      }
      return milestones.map((m) => {
        const mp = progressMap.get(m.id) ?? { total: 0, completed: 0 };
        return {
          ...m,
          progress: {
            completedTasks: mp.completed,
            totalTasks: mp.total,
            percentComplete: mp.total === 0 ? 0 : Math.round((mp.completed / mp.total) * 100),
          },
        };
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
      const access = await authorize(input, ProjectPermission.Update);
      assertProjectWritable(access.project);
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
        return { ...milestone, progress: { completedTasks: 0, totalTasks: 0, percentComplete: 0 } };
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
      const access = await authorize(input, ProjectPermission.Update);
      assertProjectWritable(access.project);
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
        const taskGroups = await tx.task.groupBy({
          by: ['status'],
          where: { projectId: access.project.id, milestoneId: milestone.id, deletedAt: null, archivedAt: null },
          _count: { _all: true },
        });
        let total = 0;
        let completed = 0;
        for (const g of taskGroups) {
          total += g._count._all;
          if (taskIsComplete(g.status)) completed += g._count._all;
        }
        return {
          ...milestone,
          progress: {
            completedTasks: completed,
            totalTasks: total,
            percentComplete: total === 0 ? 0 : Math.round((completed / total) * 100),
          },
        };
      });
    },

    async deleteMilestone(
      input: Input & { projectId: string; milestoneId: string },
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.Update);
      assertProjectWritable(access.project);
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

    async addTeam(
      input: Input & { projectId: string } & AddProjectTeamInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.Update);
      assertProjectWritable(access.project);
      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const teamAccess = await requireTeamAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        teamId: input.teamId,
        workspaceRole: workspace.effectiveRole,
        capability: TeamCapability.ViewTeam,
      });
      if (teamAccess.team.status !== 'ACTIVE' || teamAccess.team.deletedAt)
        throw new AppError(404, 'TEAM_NOT_FOUND', 'That team does not exist');

      const existingTeamIds = await loadProjectTeamIds(access.project.id);
      if (existingTeamIds.includes(input.teamId)) {
        const row = await prisma.project.findUniqueOrThrow({ where: { id: access.project.id }, include: projectInclude });
        return toSummary(row, access.projectRole);
      }
      const nextTeamIds = uniqueIds([...existingTeamIds, input.teamId]);
      const primaryTeamId = access.project.teamId ?? nextTeamIds[0] ?? null;
      let departmentId = access.project.departmentId;
      if (teamAccess.team.departmentId) {
        if (departmentId && departmentId !== teamAccess.team.departmentId) {
          throw new AppError(409, 'PROJECT_ORGANIZATION_MISMATCH', 'The project teams and department must belong together');
        }
        departmentId = teamAccess.team.departmentId;
      }

      return prisma.$transaction(async (tx) => {
        await tx.project.update({ where: { id: access.project.id }, data: { teamId: primaryTeamId, departmentId } });
        await syncProjectTeams(tx, {
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          actorId: input.userId,
          previousTeamIds: existingTeamIds,
          nextTeamIds,
          context,
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'project.updated',
          targetType: 'Project',
          targetId: access.project.id,
          metadata: { teamAdded: input.teamId, teamIds: nextTeamIds },
          ...context,
        });
        const row = await tx.project.findUniqueOrThrow({ where: { id: access.project.id }, include: projectInclude });
        return toSummary(row, access.projectRole);
      });
    },

    async removeTeam(
      input: Input & { projectId: string; teamId: string },
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.Update);
      assertProjectWritable(access.project);
      const existingTeamIds = await loadProjectTeamIds(access.project.id);
      if (!existingTeamIds.includes(input.teamId)) {
        throw new AppError(404, 'TEAM_NOT_FOUND', 'That team is not associated with this project');
      }
      const nextTeamIds = existingTeamIds.filter((id) => id !== input.teamId);
      const primaryTeamId = nextTeamIds[0] ?? null;
      const effectiveVisibility = access.project.visibility;
      if (effectiveVisibility === 'DEPARTMENT_TEAM' && nextTeamIds.length === 0 && !access.project.departmentId) {
        throw new AppError(
          409,
          'PROJECT_SCOPE_REQUIRED',
          'Department/team-only projects require a team or department',
        );
      }

      return prisma.$transaction(async (tx) => {
        await tx.project.update({ where: { id: access.project.id }, data: { teamId: primaryTeamId } });
        await syncProjectTeams(tx, {
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          actorId: input.userId,
          previousTeamIds: existingTeamIds,
          nextTeamIds,
          context,
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'project.updated',
          targetType: 'Project',
          targetId: access.project.id,
          metadata: { teamRemoved: input.teamId, teamIds: nextTeamIds },
          ...context,
        });
        const row = await tx.project.findUniqueOrThrow({ where: { id: access.project.id }, include: projectInclude });
        return toSummary(row, access.projectRole);
      });
    },
  };
}
