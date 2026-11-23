import {
  Prisma,
  type PrismaClient,
  type Sprint,
  type SprintStatus,
  type TaskStatus,
} from '@prisma/client';
import type { RequestContext } from '../auth/auth.types';
import { effectiveWorkspaceRole } from '../authorization/organization-role';
import {
  ProjectPermission,
  type ProjectPermissionValue,
} from '../authorization/project.permissions';
import { resolveProjectAuthorization, type ProjectActor } from '../authorization/project.authorization';
import { resolveSprintAuthorization } from './sprint.authorization';
import { recordAuditEvent, SprintAuditAction } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { requireSprintsEnabled } from './sprint.guards';
import {
  SPRINT_BOARD_COLUMN_ORDER,
  DONE_STATUS,
  calculateBurndown,
  evaluateScopeReconstructability,
  getOwnCompletionEvent,
  reconstructCompletedFinalScope,
  reconstructScopeAt,
  type SprintAuditEvent,
} from './sprint-report';
import type {
  CompleteSprintInput,
  CreateSprintInput,
  ListSprintsQuery,
  UpdateSprintInput,
} from './sprint.schemas';

const UNFINISHED_TASK_STATUSES: TaskStatus[] = [
  'ASSIGNED',
  'AWAITING_CLARIFICATION',
  'IN_PROGRESS',
  'SUBMITTED',
  'UNDER_REVIEW',
  'CHANGES_REQUESTED',
];

type SprintSummary = {
  id: string;
  projectId: string;
  name: string;
  goal: string | null;
  startDate: Date | null;
  endDate: Date | null;
  status: SprintStatus;
  createdById: string;
  completedAt: Date | null;
  completedById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SprintListResult = {
  items: SprintSummary[];
  nextCursor: string | null;
};

type CompleteSprintResult = {
  sprint: SprintSummary;
  movedTaskCount: number;
  archivedUnfinishedMovedCount: number;
  destination: {
    type: 'BACKLOG' | 'NEXT_SPRINT';
    nextSprintId?: string;
  };
};

function toSummary(sprint: Sprint): SprintSummary {
  return {
    id: sprint.id,
    projectId: sprint.projectId,
    name: sprint.name,
    goal: sprint.goal,
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    status: sprint.status,
    createdById: sprint.createdById,
    completedAt: sprint.completedAt,
    completedById: sprint.completedById,
    createdAt: sprint.createdAt,
    updatedAt: sprint.updatedAt,
  };
}

function dateOrNull(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return new Date(value);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

async function getMaxBacklogPosition(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<number> {
  const row = await tx.task.findFirst({
    where: { projectId, deletedAt: null },
    orderBy: [{ position: 'desc' }, { id: 'desc' }],
    select: { position: true },
  });
  return row?.position ?? 0;
}

async function getMaxSprintPosition(
  tx: Prisma.TransactionClient,
  sprintId: string,
): Promise<number> {
  const row = await tx.task.findFirst({
    where: { sprintId, deletedAt: null },
    orderBy: [{ sprintPosition: 'desc' }, { id: 'desc' }],
    select: { sprintPosition: true },
  });
  return row?.sprintPosition ?? 0;
}

async function lockProjectRow(tx: Prisma.TransactionClient, projectId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Project" WHERE id = ${projectId} FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockSprintRow(tx: Prisma.TransactionClient, sprintId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "Sprint" WHERE id = ${sprintId} FOR UPDATE
  `;
  return rows[0] ?? null;
}

function assertProjectNotArchived(project: { status: string }) {
  if (project.status === 'ARCHIVED') {
    throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
  }
}

function isManagerOrAdmin(access: { permissions: readonly ProjectPermissionValue[] }): boolean {
  return access.permissions.includes(ProjectPermission.Update);
}

export class SprintService {
  constructor(private readonly prisma: PrismaClient) {}

  private async actor(userId: string, workspaceId: string): Promise<ProjectActor> {
    const membership = await this.prisma.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      include: { workspace: { select: { type: true } } },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new AppError(403, 'PROJECT_ACCESS_DENIED', 'You are not an active workspace member');
    }
    const workspaceRole = effectiveWorkspaceRole(
      membership.workspace.type,
      membership.role,
      membership.organizationRole,
    );
    return { userId, workspaceId, workspaceRole };
  }

  private async authorizeProject(
    actor: ProjectActor,
    projectId: string,
    permission: ProjectPermissionValue,
  ) {
    const authorization = await resolveProjectAuthorization(this.prisma, actor, projectId);
    if (!authorization.permissions.includes(permission)) {
      throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission to perform this action.', {
        details: { permission },
      });
    }
    return authorization;
  }

  async list(
    input: { workspaceId: string; projectId: string; actorUserId: string } & ListSprintsQuery,
  ): Promise<SprintListResult> {
    const actor = await this.actor(input.actorUserId, input.workspaceId);
    const auth = await resolveProjectAuthorization(this.prisma, actor, input.projectId);
    if (!auth.permissions.includes(ProjectPermission.View)) {
      throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission to perform this action.', {
        details: { permission: ProjectPermission.View },
      });
    }
    assertProjectNotArchived(auth.project);
    requireSprintsEnabled({ id: auth.project.id, workflowMode: auth.project.workflowMode });

    const limit = input.limit ?? 25;
    const rows = await this.prisma.sprint.findMany({
      where: {
        projectId: input.projectId,
        ...(input.status ? { status: input.status } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: items.map(toSummary),
      nextCursor: hasMore ? items[items.length - 1]!.id : null,
    };
  }

  async create(
    input: { workspaceId: string; projectId: string; actorUserId: string } & CreateSprintInput,
    context: RequestContext,
  ): Promise<SprintSummary> {
    const actor = await this.actor(input.actorUserId, input.workspaceId);
    const auth = await this.authorizeProject(actor, input.projectId, ProjectPermission.Update);
    assertProjectNotArchived(auth.project);
    requireSprintsEnabled({ id: auth.project.id, workflowMode: auth.project.workflowMode });

    const sprint = await this.prisma.sprint.create({
      data: {
        projectId: input.projectId,
        name: input.name,
        goal: input.goal ?? null,
        startDate: dateOrNull(input.startDate) ?? null,
        endDate: dateOrNull(input.endDate) ?? null,
        status: 'PLANNED',
        createdById: input.actorUserId,
      },
    });

    await recordAuditEvent(this.prisma, {
      workspaceId: input.workspaceId,
      actorId: input.actorUserId,
      action: SprintAuditAction.SprintCreated,
      targetType: 'Sprint',
      targetId: sprint.id,
      metadata: {
        projectId: input.projectId,
        sprintId: sprint.id,
        status: sprint.status,
      },
      ...context,
    });

    return toSummary(sprint);
  }

  async update(
    input: { workspaceId: string; projectId: string; sprintId: string; actorUserId: string } & UpdateSprintInput,
    context: RequestContext,
  ): Promise<SprintSummary> {
    const actor = await this.actor(input.actorUserId, input.workspaceId);
    const authorization = await resolveProjectAuthorization(this.prisma, actor, input.projectId);
    if (!authorization.permissions.includes(ProjectPermission.Update)) {
      throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission to perform this action.', {
        details: { permission: ProjectPermission.Update },
      });
    }
    assertProjectNotArchived(authorization.project);
    requireSprintsEnabled({ id: authorization.project.id, workflowMode: authorization.project.workflowMode });

    const sprint = await this.prisma.sprint.findFirst({
      where: { id: input.sprintId, projectId: input.projectId, project: { workspaceId: input.workspaceId, deletedAt: null } },
    });
    if (!sprint) {
      throw new AppError(404, 'SPRINT_NOT_FOUND', 'That sprint does not exist');
    }

    // Metadata updates allowed for PLANNED sprints (and limited fields for others can be extended; doc says PLANNED/metadata)
    if (sprint.status !== 'PLANNED') {
      throw new AppError(409, 'SPRINT_NOT_EDITABLE', 'Only PLANNED sprints can be edited in stage 2.', {
        details: { sprintId: sprint.id, status: sprint.status },
      });
    }

    const startDate = dateOrNull(input.startDate);
    const endDate = dateOrNull(input.endDate);
    const nextStart = startDate !== undefined ? startDate : sprint.startDate;
    const nextEnd = endDate !== undefined ? endDate : sprint.endDate;
    if (nextStart && nextEnd && nextStart > nextEnd) {
      throw new AppError(422, 'VALIDATION_ERROR', 'Start date must be on or before the end date');
    }

    const updated = await this.prisma.sprint.update({
      where: { id: sprint.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(startDate !== undefined ? { startDate } : {}),
        ...(endDate !== undefined ? { endDate } : {}),
      },
    });

    await recordAuditEvent(this.prisma, {
      workspaceId: input.workspaceId,
      actorId: input.actorUserId,
      action: SprintAuditAction.SprintUpdated,
      targetType: 'Sprint',
      targetId: updated.id,
      metadata: {
        projectId: input.projectId,
        sprintId: updated.id,
        changedFields: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined),
      },
      ...context,
    });

    return toSummary(updated);
  }

  async start(
    input: { workspaceId: string; projectId: string; sprintId: string; actorUserId: string },
    context: RequestContext,
  ): Promise<SprintSummary> {
    const actor = await this.actor(input.actorUserId, input.workspaceId);

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await lockProjectRow(tx, input.projectId);
        const authorization = await resolveProjectAuthorization(tx as unknown as PrismaClient, actor, input.projectId);
        if (!authorization.permissions.includes(ProjectPermission.Update)) {
          throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission to perform this action.', {
            details: { permission: ProjectPermission.Update },
          });
        }
        assertProjectNotArchived(authorization.project);
        requireSprintsEnabled({ id: authorization.project.id, workflowMode: authorization.project.workflowMode });

        const sprint = await tx.sprint.findFirst({
          where: { id: input.sprintId, projectId: input.projectId, project: { workspaceId: input.workspaceId, deletedAt: null } },
        });
        if (!sprint) {
          throw new AppError(404, 'SPRINT_NOT_FOUND', 'That sprint does not exist');
        }

        await lockSprintRow(tx, sprint.id);
        const current = await tx.sprint.findUniqueOrThrow({ where: { id: sprint.id } });
        if (current.status === 'ACTIVE') {
          throw new AppError(409, 'SPRINT_ALREADY_ACTIVE', 'Sprint is already active.', {
            details: { sprintId: current.id },
          });
        }
        if (current.status !== 'PLANNED') {
          throw new AppError(409, 'SPRINT_NOT_STARTABLE', 'Only PLANNED sprints can be started.', {
            details: { sprintId: current.id, status: current.status },
          });
        }

        const existingActive = await tx.sprint.findFirst({
          where: { projectId: input.projectId, status: 'ACTIVE', id: { not: sprint.id } },
          select: { id: true },
        });
        if (existingActive) {
          throw new AppError(409, 'ACTIVE_SPRINT_EXISTS', 'An active sprint already exists for this project.', {
            details: { projectId: input.projectId, activeSprintId: existingActive.id },
          });
        }

        const started = await tx.sprint.update({
          where: { id: sprint.id },
          data: { status: 'ACTIVE', completedAt: null, completedById: null },
        });

        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.actorUserId,
          action: SprintAuditAction.SprintStarted,
          targetType: 'Sprint',
          targetId: started.id,
          metadata: { projectId: input.projectId, sprintId: started.id },
          ...context,
        });

        return started;
      });

      return toSummary(updated);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'ACTIVE_SPRINT_EXISTS', 'An active sprint already exists for this project.', {
          details: { projectId: input.projectId },
        });
      }
      throw error;
    }
  }

  async complete(
    input: { workspaceId: string; projectId: string; sprintId: string; actorUserId: string } & CompleteSprintInput,
    context: RequestContext,
  ): Promise<CompleteSprintResult> {
    const actor = await this.actor(input.actorUserId, input.workspaceId);

    const result = await this.prisma.$transaction(async (tx) => {
      await lockProjectRow(tx, input.projectId);
      const authorization = await resolveProjectAuthorization(tx as unknown as PrismaClient, actor, input.projectId);
      if (!authorization.permissions.includes(ProjectPermission.Update)) {
        throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission to perform this action.', {
          details: { permission: ProjectPermission.Update },
        });
      }
      assertProjectNotArchived(authorization.project);
      requireSprintsEnabled({ id: authorization.project.id, workflowMode: authorization.project.workflowMode });

      const sprint = await tx.sprint.findFirst({
        where: { id: input.sprintId, projectId: input.projectId, project: { workspaceId: input.workspaceId, deletedAt: null } },
      });
      if (!sprint) {
        throw new AppError(404, 'SPRINT_NOT_FOUND', 'That sprint does not exist');
      }

      await lockSprintRow(tx, sprint.id);
      const current = await tx.sprint.findUniqueOrThrow({ where: { id: sprint.id } });
      if (current.status !== 'ACTIVE') {
        throw new AppError(409, 'SPRINT_NOT_ACTIVE', 'Only an ACTIVE sprint can be completed.', {
          details: { sprintId: current.id, status: current.status },
        });
      }

      let nextSprint: Sprint | null = null;
      if (input.target === 'NEXT_SPRINT') {
        if (!input.nextSprintId) {
          throw new AppError(422, 'VALIDATION_ERROR', 'nextSprintId is required when target is NEXT_SPRINT');
        }
        nextSprint = await tx.sprint.findFirst({
          where: { id: input.nextSprintId, projectId: input.projectId },
        });
        if (!nextSprint) {
          throw new AppError(404, 'SPRINT_NOT_FOUND', 'Target sprint was not found in this project.', {
            details: { sprintId: input.nextSprintId, projectId: input.projectId },
          });
        }
        if (nextSprint.status !== 'PLANNED') {
          throw new AppError(422, 'SPRINT_NOT_ASSIGNABLE', 'Target sprint must be PLANNED.', {
            details: { sprintId: nextSprint.id, status: nextSprint.status },
          });
        }
        await lockSprintRow(tx, nextSprint.id);
      }

      const unfinishedTasks = await tx.task.findMany({
        where: {
          projectId: input.projectId,
          sprintId: current.id,
          deletedAt: null,
          status: { in: UNFINISHED_TASK_STATUSES },
        },
        orderBy: [{ sprintPosition: 'asc' }, { id: 'asc' }],
        select: { id: true, archivedAt: true },
      });
      const retainedTasks = await tx.task.findMany({
        where: {
          projectId: input.projectId,
          sprintId: current.id,
          deletedAt: null,
          status: 'APPROVED',
        },
        orderBy: [{ sprintPosition: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });

      const archivedUnfinishedMovedCount = unfinishedTasks.filter((t) => t.archivedAt !== null).length;
      const movedTaskCount = unfinishedTasks.length;
      const carriedOverTaskIds = unfinishedTasks.map((t) => t.id);
      const retainedTaskIds = retainedTasks.map((t) => t.id);

      if (input.target === 'BACKLOG') {
        let pos = await getMaxBacklogPosition(tx, input.projectId);
        for (const task of unfinishedTasks) {
          pos += 1;
          await tx.task.update({
            where: { id: task.id },
            data: { sprintId: null, sprintPosition: null, position: pos },
          });
        }
      } else if (nextSprint) {
        let sprintPos = await getMaxSprintPosition(tx, nextSprint.id);
        for (const task of unfinishedTasks) {
          sprintPos += 1;
          await tx.task.update({
            where: { id: task.id },
            data: { sprintId: nextSprint.id, sprintPosition: sprintPos },
          });
        }
      }

      const completed = await tx.sprint.update({
        where: { id: current.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          completedById: input.actorUserId,
        },
      });

      await recordAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: SprintAuditAction.SprintCompleted,
        targetType: 'Sprint',
        targetId: completed.id,
        metadata: {
          projectId: input.projectId,
          sprintId: completed.id,
          movedTaskCount,
          archivedUnfinishedMovedCount,
          destinationType: input.target,
          ...(input.target === 'NEXT_SPRINT' ? { nextSprintId: input.nextSprintId } : {}),
          carriedOverTaskIds,
          retainedTaskIds,
        },
        ...context,
      });

      return {
        sprint: toSummary(completed),
        movedTaskCount,
        archivedUnfinishedMovedCount,
        destination: {
          type: input.target,
          ...(input.target === 'NEXT_SPRINT' && input.nextSprintId
            ? { nextSprintId: input.nextSprintId }
            : {}),
        },
      } satisfies CompleteSprintResult;
    });

    return result;
  }

  async restore(
    input: { workspaceId: string; projectId: string; sprintId: string; actorUserId: string },
    context: RequestContext,
  ): Promise<SprintSummary> {
    const actor = await this.actor(input.actorUserId, input.workspaceId);
    const authorization = await resolveProjectAuthorization(this.prisma, actor, input.projectId);
    if (!authorization.permissions.includes(ProjectPermission.Update)) {
      throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission to perform this action.', {
        details: { permission: ProjectPermission.Update },
      });
    }
    assertProjectNotArchived(authorization.project);
    requireSprintsEnabled({ id: authorization.project.id, workflowMode: authorization.project.workflowMode });

    const sprint = await this.prisma.sprint.findFirst({
      where: { id: input.sprintId, projectId: input.projectId, project: { workspaceId: input.workspaceId, deletedAt: null } },
    });
    if (!sprint) {
      throw new AppError(404, 'SPRINT_NOT_FOUND', 'That sprint does not exist');
    }

    if (sprint.status !== 'ARCHIVED') {
      throw new AppError(409, 'SPRINT_NOT_RESTORABLE', 'Only ARCHIVED sprints can be restored.', {
        details: { sprintId: sprint.id, status: sprint.status },
      });
    }

    const restored = await this.prisma.sprint.update({
      where: { id: sprint.id },
      data: { status: 'PLANNED', completedAt: null, completedById: null },
    });

    await recordAuditEvent(this.prisma, {
      workspaceId: input.workspaceId,
      actorId: input.actorUserId,
      action: SprintAuditAction.SprintRestored,
      targetType: 'Sprint',
      targetId: restored.id,
      metadata: { projectId: input.projectId, sprintId: restored.id },
      ...context,
    });

    return toSummary(restored);
  }

  async addTasks(
    input: { workspaceId: string; projectId: string; sprintId: string; actorUserId: string; taskIds: string[] },
    context: RequestContext,
  ): Promise<{ sprint: SprintSummary; addedTaskIds: string[] }> {
    const actor = await this.actor(input.actorUserId, input.workspaceId);

    const result = await this.prisma.$transaction(async (tx) => {
      await lockProjectRow(tx, input.projectId);
      const authorization = await resolveProjectAuthorization(tx as unknown as PrismaClient, actor, input.projectId);
      if (!authorization.permissions.includes(ProjectPermission.TaskUpdate)) {
        throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission to perform this action.', {
          details: { permission: ProjectPermission.TaskUpdate },
        });
      }
      assertProjectNotArchived(authorization.project);
      requireSprintsEnabled({ id: authorization.project.id, workflowMode: authorization.project.workflowMode });

      const sprint = await tx.sprint.findFirst({
        where: { id: input.sprintId, projectId: input.projectId, project: { workspaceId: input.workspaceId, deletedAt: null } },
      });
      if (!sprint) {
        throw new AppError(404, 'SPRINT_NOT_FOUND', 'That sprint does not exist');
      }

      await lockSprintRow(tx, sprint.id);
      const currentSprint = await tx.sprint.findUniqueOrThrow({ where: { id: sprint.id } });
      if (currentSprint.status === 'COMPLETED' || currentSprint.status === 'ARCHIVED') {
        throw new AppError(422, 'SPRINT_NOT_ASSIGNABLE', 'Tasks cannot be assigned to a COMPLETED or ARCHIVED sprint.', {
          details: { sprintId: currentSprint.id, status: currentSprint.status },
        });
      }

      const uniqueTaskIds = Array.from(new Set(input.taskIds));
      const tasks = await tx.task.findMany({
        where: { id: { in: uniqueTaskIds }, projectId: input.projectId, deletedAt: null },
        select: { id: true, sprintId: true },
      });
      const byId = new Map(tasks.map((t) => [t.id, t]));
      for (const taskId of uniqueTaskIds) {
        if (!byId.has(taskId)) {
          throw new AppError(404, 'TASK_NOT_FOUND', 'Task was not found in this project.', {
            details: { taskId, projectId: input.projectId },
          });
        }
      }

      let sprintPos = await getMaxSprintPosition(tx, currentSprint.id);
      const addedTaskIds: string[] = [];
      for (const taskId of uniqueTaskIds) {
        const task = byId.get(taskId)!;
        if (task.sprintId === currentSprint.id) continue;
        sprintPos += 1;
        await tx.task.update({
          where: { id: taskId },
          data: { sprintId: currentSprint.id, sprintPosition: sprintPos },
        });
        addedTaskIds.push(taskId);
      }

      await recordAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: SprintAuditAction.SprintTaskAdded,
        targetType: 'Sprint',
        targetId: currentSprint.id,
        metadata: {
          projectId: input.projectId,
          sprintId: currentSprint.id,
          taskIds: addedTaskIds,
          count: addedTaskIds.length,
        },
        ...context,
      });

      return { sprint: toSummary(currentSprint), addedTaskIds };
    });

    return result;
  }

  async removeTask(
    input: { workspaceId: string; projectId: string; sprintId: string; taskId: string; actorUserId: string },
    context: RequestContext,
  ): Promise<{ sprint: SprintSummary; taskId: string }> {
    const actor = await this.actor(input.actorUserId, input.workspaceId);

    const result = await this.prisma.$transaction(async (tx) => {
      await lockProjectRow(tx, input.projectId);
      const authorization = await resolveProjectAuthorization(tx as unknown as PrismaClient, actor, input.projectId);
      if (!authorization.permissions.includes(ProjectPermission.TaskUpdate)) {
        throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission to perform this action.', {
          details: { permission: ProjectPermission.TaskUpdate },
        });
      }
      assertProjectNotArchived(authorization.project);
      requireSprintsEnabled({ id: authorization.project.id, workflowMode: authorization.project.workflowMode });

      const sprint = await tx.sprint.findFirst({
        where: { id: input.sprintId, projectId: input.projectId, project: { workspaceId: input.workspaceId, deletedAt: null } },
      });
      if (!sprint) {
        throw new AppError(404, 'SPRINT_NOT_FOUND', 'That sprint does not exist');
      }

      const task = await tx.task.findFirst({
        where: { id: input.taskId, projectId: input.projectId, deletedAt: null },
        select: { id: true, sprintId: true },
      });
      if (!task) {
        throw new AppError(404, 'TASK_NOT_FOUND', 'Task was not found in this project.', {
          details: { taskId: input.taskId, projectId: input.projectId },
        });
      }
      if (task.sprintId !== sprint.id) {
        throw new AppError(404, 'TASK_NOT_IN_SPRINT', 'Task is not in this sprint.', {
          details: { taskId: input.taskId, sprintId: sprint.id },
        });
      }

      const maxBacklogPos = await getMaxBacklogPosition(tx, input.projectId);
      await tx.task.update({
        where: { id: task.id },
        data: { sprintId: null, sprintPosition: null, position: maxBacklogPos + 1 },
      });

      await recordAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actorId: input.actorUserId,
        action: SprintAuditAction.SprintTaskRemoved,
        targetType: 'Sprint',
        targetId: sprint.id,
        metadata: {
          projectId: input.projectId,
          sprintId: sprint.id,
          taskId: task.id,
          count: 1,
        },
        ...context,
      });

      return { sprint: toSummary(sprint), taskId: task.id };
    });

    return result;
  }

  private async authorizeSprintView(input: { workspaceId: string; projectId: string; sprintId: string; actorUserId: string }) {
    const actor = await this.actor(input.actorUserId, input.workspaceId);
    const { sprint, authorization } = await resolveSprintAuthorization(
      this.prisma,
      actor,
      input.workspaceId,
      input.projectId,
      input.sprintId,
    );
    if (!authorization.permissions.includes(ProjectPermission.View)) {
      throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission to perform this action.', {
        details: { permission: ProjectPermission.View },
      });
    }
    assertProjectNotArchived(authorization.project);
    requireSprintsEnabled({ id: authorization.project.id, workflowMode: authorization.project.workflowMode });
    return { sprint, authorization };
  }

  private async loadSprintScopeEvents(sprintId: string): Promise<SprintAuditEvent[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        targetType: 'Sprint',
        OR: [
          { targetId: sprintId, action: { in: ['sprint.task_added', 'sprint.task_removed', 'sprint.completed'] } },
          {
            action: 'sprint.completed',
            metadata: { path: ['nextSprintId'], equals: sprintId } as unknown as Prisma.JsonNullableFilter,
          },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { action: true, createdAt: true, targetId: true, metadata: true },
    });

    return rows.map((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      const toIds = (v: unknown) => (Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : undefined);
      return {
        action: r.action as SprintAuditEvent['action'],
        createdAt: r.createdAt,
        sprintId: r.targetId,
        taskIds: toIds(meta.taskIds),
        carriedOverTaskIds: toIds(meta.carriedOverTaskIds),
        retainedTaskIds: toIds(meta.retainedTaskIds),
        nextSprintId: typeof meta.nextSprintId === 'string' ? meta.nextSprintId : null,
      };
    });
  }

  private async filterDeletedTaskIds(taskIds: string[]): Promise<string[]> {
    if (taskIds.length === 0) return [];
    const existing = await this.prisma.task.findMany({
      where: { id: { in: taskIds }, deletedAt: null },
      select: { id: true },
    });
    const ok = new Set(existing.map((t: { id: string }) => t.id));
    return taskIds.filter((id) => ok.has(id));
  }

  async board(input: { workspaceId: string; projectId: string; sprintId: string; actorUserId: string }) {
    const { sprint } = await this.authorizeSprintView(input);
    const tasks = await this.prisma.task.findMany({
      where: { sprintId: sprint.id, deletedAt: null },
      orderBy: [{ sprintPosition: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        key: true,
        title: true,
        status: true,
        priority: true,
        sprintId: true,
        sprintPosition: true,
        dueDate: true,
        archivedAt: true,
        assignees: { select: { user: { select: { id: true, name: true } } } },
      },
    });

    const columns = SPRINT_BOARD_COLUMN_ORDER.map((status) => {
      const columnTasks = tasks
        .filter((t) => t.status === status)
        .map((t) => ({
          id: t.id,
          key: t.key,
          title: t.title,
          status: t.status,
          priority: t.priority,
          sprintId: t.sprintId,
          sprintPosition: t.sprintPosition,
          assignees: (t.assignees ?? []).map((a) => ({ userId: a.user.id, name: a.user.name })),
          dueDate: t.dueDate,
          archivedAt: t.archivedAt,
        }));
      return { status, count: columnTasks.length, tasks: columnTasks };
    });

    const doneCount = tasks.filter((t) => t.status === DONE_STATUS).length;
    return {
      sprint: toSummary(sprint),
      columns,
      totals: { taskCount: tasks.length, doneCount },
    };
  }

  async reportSummary(input: { workspaceId: string; projectId: string; sprintId: string; actorUserId: string }) {
    const { sprint } = await this.authorizeSprintView(input);
    const now = new Date();

    if (sprint.status === 'ACTIVE' || sprint.status === 'PLANNED') {
      const tasks = await this.prisma.task.findMany({
        where: { sprintId: sprint.id, deletedAt: null },
        select: { id: true, status: true },
      });
      const doneTasks = tasks.filter((t) => t.status === DONE_STATUS).length;
      const totalTasks = tasks.length;
      const remainingTasks = totalTasks - doneTasks;
      return {
        sprint: toSummary(sprint),
        scopeReconstructable: true,
        summary: {
          metric: 'TASK_COUNT',
          totalTasks,
          doneTasks,
          remainingTasks,
          completionRate: totalTasks === 0 ? 0 : doneTasks / totalTasks,
        },
        generatedAt: now.toISOString(),
      };
    }

    // COMPLETED
    const events = await this.loadSprintScopeEvents(sprint.id);
    const scopeInput = {
      sprintId: sprint.id,
      sprintCreatedAt: sprint.createdAt,
      sprintStatus: sprint.status as "PLANNED" | "ACTIVE" | "COMPLETED" | "ARCHIVED",
      events,
    };
    const check = evaluateScopeReconstructability(scopeInput);
    if (!check.reconstructable) {
      return {
        sprint: toSummary(sprint),
        scopeReconstructable: false,
        reason: check.reason,
        summary: null,
        generatedAt: now.toISOString(),
      };
    }
    // COMPLETED final scope = retainedTaskIds + carriedOverTaskIds from own sprint.completed row.
    const own = getOwnCompletionEvent(scopeInput)!;
    const toIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : []);
    const retainedIds = await this.filterDeletedTaskIds(toIds(own.retainedTaskIds));
    const carriedIds = await this.filterDeletedTaskIds(toIds(own.carriedOverTaskIds));
    const totalTasks = new Set([...retainedIds, ...carriedIds]).size;
    const doneTasks = new Set(retainedIds).size;
    const remainingTasks = Math.max(0, totalTasks - doneTasks);
    return {
      sprint: toSummary(sprint),
      scopeReconstructable: true,
      summary: {
        metric: 'TASK_COUNT',
        totalTasks,
        doneTasks,
        remainingTasks,
        completionRate: totalTasks === 0 ? 0 : doneTasks / totalTasks,
      },
      generatedAt: now.toISOString(),
    };
  }

  async reportBurndown(input: { workspaceId: string; projectId: string; sprintId: string; actorUserId: string }) {
    const { sprint } = await this.authorizeSprintView(input);
    const now = new Date();
    const events = await this.loadSprintScopeEvents(sprint.id);
    const scopeInput = {
      sprintId: sprint.id,
      sprintCreatedAt: sprint.createdAt,
      sprintStatus: sprint.status as "PLANNED" | "ACTIVE" | "COMPLETED" | "ARCHIVED",
      events,
    };
    const check = evaluateScopeReconstructability(scopeInput);
    if (!check.reconstructable) {
      return {
        sprint: toSummary(sprint),
        scopeReconstructable: false,
        reason: check.reason,
        series: [],
        generatedAt: now.toISOString(),
      };
    }

    let scope = reconstructScopeAt(scopeInput, now);
    scope = { ...scope, taskIds: await this.filterDeletedTaskIds(scope.taskIds) };

    const completionEvents = await this.loadCompletionEvents(scope.taskIds);
    const burndown = calculateBurndown({
      sprint: {
        id: sprint.id,
        status: sprint.status as "PLANNED" | "ACTIVE" | "COMPLETED" | "ARCHIVED",
        startDate: sprint.startDate,
        endDate: sprint.endDate,
        createdAt: sprint.createdAt,
        completedAt: sprint.completedAt,
      },
      scope,
      completionEvents,
      now,
    });

    // For COMPLETED sprints, total/remaining/completed should be based on final scope.
    let finalBurndown = burndown;
    if (sprint.status === 'COMPLETED') {
      const finalScope = reconstructCompletedFinalScope(scopeInput);
      const finalIds = await this.filterDeletedTaskIds(finalScope.taskIds);
      const finalCompletionEvents = await this.loadCompletionEvents(finalIds);
      finalBurndown = calculateBurndown({
        sprint: {
          id: sprint.id,
          status: sprint.status as "PLANNED" | "ACTIVE" | "COMPLETED" | "ARCHIVED",
          startDate: sprint.startDate,
          endDate: sprint.endDate,
          createdAt: sprint.createdAt,
          completedAt: sprint.completedAt,
        },
        scope: { reconstructable: true, taskIds: finalIds },
        completionEvents: finalCompletionEvents,
        now,
      });
    }

    return {
      sprint: toSummary(sprint),
      scopeReconstructable: true,
      ...finalBurndown,
      generatedAt: now.toISOString(),
    };
  }

  private async loadCompletionEvents(taskIds: string[]): Promise<{ taskId: string; completedAt: Date | string }[]> {
    if (taskIds.length === 0) return [];
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: taskIds } },
      select: { id: true, completedAt: true, status: true },
    });
    const result: { taskId: string; completedAt: Date | string }[] = [];
    const missing: string[] = [];
    for (const t of tasks) {
      if (t.status === DONE_STATUS && t.completedAt) {
        result.push({ taskId: t.id, completedAt: t.completedAt });
      } else if (t.status === DONE_STATUS && !t.completedAt) {
        missing.push(t.id);
      }
    }
    if (missing.length > 0) {
      const audits = await this.prisma.auditLog.findMany({
        where: {
          targetType: 'Task',
          targetId: { in: missing },
          action: { in: ['task.approved', 'task.completed'] },
        },
        orderBy: [{ createdAt: 'desc' }],
        select: { targetId: true, createdAt: true },
      });
      const seen = new Set<string>();
      for (const a of audits) {
        if (seen.has(a.targetId)) continue;
        seen.add(a.targetId);
        result.push({ taskId: a.targetId, completedAt: a.createdAt });
      }
    }
    return result;
  }

  async history(
    input: { workspaceId: string; projectId: string; actorUserId: string } & ListSprintsQuery,
  ): Promise<SprintListResult> {
    const actor = await this.actor(input.actorUserId, input.workspaceId);
    const auth = await resolveProjectAuthorization(this.prisma, actor, input.projectId);
    if (!isManagerOrAdmin(auth)) {
      throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission to perform this action.', {
        details: { permission: ProjectPermission.Update },
      });
    }
    assertProjectNotArchived(auth.project);
    // History works in both modes (no requireSprintsEnabled).

    const limit = input.limit ?? 25;
    const statusFilter = input.status;
    const historyStatuses: SprintStatus[] = ['COMPLETED', 'ARCHIVED'];
    const statuses =
      statusFilter && historyStatuses.includes(statusFilter as SprintStatus)
        ? [statusFilter as SprintStatus]
        : historyStatuses;

    const rows = await this.prisma.sprint.findMany({
      where: {
        projectId: input.projectId,
        status: { in: statuses },
      },
      orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: items.map(toSummary),
      nextCursor: hasMore ? items[items.length - 1]!.id : null,
    };
  }
}
