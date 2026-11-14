import type { TaskAssignmentNotifier } from '../../services/task-assignment-notifier';
import type { MentionEmailNotifier } from '../../services/mention-email-notifier';
import type { Prisma, PrismaClient, TaskStatus } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { enqueueAutomationRunsSafely } from '../automation/automation.events';
import { AppError } from '../../utils/errors';
import {
  ProjectPermission,
  assertNotSelfReview,
  authorizeProject,
  requireWorkspaceAccess,
  WorkspaceCapability,
  type ProjectAuthorizationResource,
  type ProjectPermissionValue,
} from '../authorization';
import type { RequestContext } from '../auth/auth.types';
import type {
  AddAssigneeInput,
  AddDependencyInput,
  CreateCommentInput,
  CreateTaskInput,
  ListTasksQuery,
  UpdateCommentInput,
  UpdateTaskInput,
} from './task.schemas';

type Input = { userId: string; workspaceId: string };

const taskInclude = {
  creator: { select: { id: true, name: true } },
  assignees: {
    include: { user: { select: { id: true, name: true, email: true } } },
  },
  dependencies: {
    include: {
      dependsOnTask: { select: { id: true, key: true, title: true, status: true } },
    },
  },
  blockers: {
    include: {
      task: { select: { id: true, key: true, title: true, status: true } },
    },
  },
  _count: { select: { subTasks: true, comments: true, attachments: true } },
} as const;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

interface TaskSummary extends Omit<TaskRow, '_count'> {
  subTaskCount: number;
  commentCount: number;
  attachmentCount: number;
}

function toSummary(row: TaskRow): TaskSummary {
  const { _count, ...task } = row;
  return {
    ...task,
    subTaskCount: _count.subTasks,
    commentCount: _count.comments,
    attachmentCount: _count.attachments,
  };
}

const PRIORITY_RANK: Record<string, number> = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function dateOrNull(value: string | null | undefined): Date | null | undefined {
  return value === undefined ? undefined : value === null ? null : new Date(value);
}

/**
 * Generates the next sequential task key for a project.
 *
 * The key is `{projectKey}-{N}` where N is the highest existing suffix + 1.
 * We use a count-based heuristic as a fallback when no tasks exist yet.
 */
export async function generateTaskKey(
  tx: Prisma.TransactionClient,
  projectId: string,
  projectKey: string,
): Promise<string> {
  const lastTask = await tx.task.findFirst({
    where: { projectId },
    orderBy: { key: 'desc' },
    select: { key: true },
  });

  let nextNumber = 1;
  if (lastTask) {
    const match = lastTask.key.match(/(\d+)$/);
    if (match?.[1]) {
      nextNumber = parseInt(match[1], 10) + 1;
    }
  }

  // Ensure uniqueness against concurrent creates — the unique constraint
  // [projectId, key] will catch a collision, but the count fallback covers
  // the edge case where key parsing fails.
  let key = `${projectKey}-${nextNumber}`;
  let attempt = 0;
  while (attempt < 50) {
    const existing = await tx.task.findUnique({
      where: { projectId_key: { projectId, key } },
      select: { id: true },
    });
    if (!existing) return key;
    nextNumber += 1;
    key = `${projectKey}-${nextNumber}`;
    attempt += 1;
  }
  throw new AppError(409, 'TASK_KEY_CONFLICT', 'Could not generate a unique task key');
}

/**
 * Detects whether adding `dependsOnTaskId` as a dependency of `taskId`
 * would create a cycle. We do a DFS from the proposed dependency looking
 * back towards `taskId`.
 */
async function wouldCreateCycle(
  tx: Prisma.TransactionClient,
  projectId: string,
  taskId: string,
  dependsOnTaskId: string,
): Promise<boolean> {
  if (taskId === dependsOnTaskId) return true;
  const visited = new Set<string>();
  const queue: string[] = [dependsOnTaskId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const deps = await tx.taskDependency.findMany({
      where: { taskId: current, task: { projectId } },
      select: { dependsOnTaskId: true },
    });
    for (const dep of deps) {
      if (!visited.has(dep.dependsOnTaskId)) {
        queue.push(dep.dependsOnTaskId);
      }
    }
  }

  return false;
}

export interface TaskServiceDependencies {
  assignmentNotifier?: TaskAssignmentNotifier;
  mentionNotifier?: MentionEmailNotifier;
}

export function createTaskService(
  prisma: PrismaClient = getPrismaClient(),
  deps: TaskServiceDependencies = {},
) {
  const authorize = async (
    input: Input & { projectId: string },
    permission: ProjectPermissionValue,
    resource?: ProjectAuthorizationResource,
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
      ...(resource ? { resource } : {}),
    });
  };

  return {
    // -------------------------------------------------------------------------
    // List
    // -------------------------------------------------------------------------

    async list(input: Input & { projectId: string } & ListTasksQuery) {
      const access = await authorize(input, ProjectPermission.TaskView);

      const orderBy: Prisma.TaskOrderByWithRelationInput[] = (() => {
        switch (input.sortBy) {
          case 'dueDate':
            return [{ dueDate: input.sortOrder === 'desc' ? 'desc' : 'asc' }, { id: 'asc' }];
          case 'priority': {
            // Prisma can't order by enum priority natively; we order by
            // createdAt as a tiebreaker and let the service layer handle
            // priority sorting on the client side. The DB order is a stable
            // fallback.
            return [{ createdAt: input.sortOrder === 'desc' ? 'desc' : 'asc' }, { id: 'asc' }];
          }
          case 'createdAt':
            return [{ createdAt: input.sortOrder === 'desc' ? 'desc' : 'asc' }, { id: 'asc' }];
          case 'position':
          default:
            return [{ position: input.sortOrder === 'desc' ? 'desc' : 'asc' }, { id: 'asc' }];
        }
      })();

      const rows = await prisma.task.findMany({
        where: {
          projectId: input.projectId,
          deletedAt: null,
          ...(access.projectRole === 'COLLABORATOR'
            ? { assignees: { some: { userId: input.userId } } }
            : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.assigneeId
            ? { assignees: { some: { userId: input.assigneeId } } }
            : {}),
          ...(input.labels && input.labels.length
            ? { labels: { hasSome: input.labels } }
            : {}),
          ...(input.search
            ? {
                OR: [
                  { title: { contains: input.search, mode: 'insensitive' } },
                  { key: { contains: input.search, mode: 'insensitive' } },
                ],
              }
            : {}),
          ...(!input.includeArchived ? { archivedAt: null } : {}),
        },
        orderBy,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        take: input.limit + 1,
        include: taskInclude,
      });

      const hasMore = rows.length > input.limit;
      const page = rows.slice(0, input.limit);
      const items = page.map(toSummary);

      // Sort by priority in memory when requested, since Prisma can't order
      // by enum rank directly.
      if (input.sortBy === 'priority') {
        items.sort((a, b) => {
          const aRank = PRIORITY_RANK[a.priority] ?? 99;
          const bRank = PRIORITY_RANK[b.priority] ?? 99;
          const diff = aRank - bRank;
          if (diff !== 0) return input.sortOrder === 'desc' ? -diff : diff;
          return a.id.localeCompare(b.id);
        });
      }

      return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
    },

    // -------------------------------------------------------------------------
    // Create
    // -------------------------------------------------------------------------

    async create(
      input: Input & { projectId: string } & CreateTaskInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.TaskCreate);
      if (access.project.status === 'ARCHIVED')
        throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
      if (
        input.assigneeIds?.length &&
        !access.permissions.includes(ProjectPermission.TaskAssign)
      ) {
        throw new AppError(
          403,
          'PERMISSION_DENIED',
          'Your project role does not allow assigning tasks',
          { requiredPermission: ProjectPermission.TaskAssign },
        );
      }

      const projectKey = access.project.key;

      const created = await prisma.$transaction(async (tx) => {
        const key = await generateTaskKey(tx, access.project.id, projectKey);

        // Verify parent task exists in the same project if provided.
        if (input.parentTaskId) {
          const parent = await tx.task.findFirst({
            where: {
              id: input.parentTaskId,
              projectId: access.project.id,
              deletedAt: null,
            },
            select: { id: true },
          });
          if (!parent)
            throw new AppError(404, 'TASK_NOT_FOUND', 'The parent task does not exist');
        }

        const task = await tx.task.create({
          data: {
            projectId: access.project.id,
            key,
            title: input.title,
            description: input.description ?? null,
            status: input.status ?? 'ASSIGNED',
            priority: input.priority ?? 'MEDIUM',
            category: input.category ?? null,
            labels: input.labels ?? [],
            startDate: dateOrNull(input.startDate) ?? null,
            dueDate: dateOrNull(input.dueDate) ?? null,
            position: input.position ?? 0,
            parentTaskId: input.parentTaskId ?? null,
            creatorId: input.userId,
            ...(input.assigneeIds?.length
              ? {
                  assignees: {
                    create: input.assigneeIds.map((userId) => ({
                      userId,
                      assignedBy: input.userId,
                    })),
                  },
                }
              : {}),
          },
          include: taskInclude,
        });

        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.created',
          targetType: 'Task',
          targetId: task.id,
          metadata: { key: task.key, title: task.title, projectId: access.project.id },
          ...context,
        });

        // Create notifications for each assignee (other than the creator).
        if (input.assigneeIds?.length) {
          for (const assigneeId of input.assigneeIds) {
            if (assigneeId === input.userId) continue;
            await createNotification(tx, {
              userId: assigneeId,
              type: 'TASK_ASSIGNED',
              title: 'Task assigned to you',
              data: {
                workspaceId: input.workspaceId,
                projectId: access.project.id,
                taskId: task.id,
              },
            });
          }
        }

        return toSummary(task);
      });

      await enqueueAutomationRunsSafely({
        workspaceId: input.workspaceId,
        trigger: 'EVENT_TASK_CREATED',
        eventKey: `task.created:${created.id}`,
        payload: {
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          taskId: created.id,
          key: created.key,
          title: created.title,
          status: created.status,
          priority: created.priority,
          creatorId: input.userId,
        },
      });

      return created;
    },

    // -------------------------------------------------------------------------
    // Get
    // -------------------------------------------------------------------------

    async get(input: Input & { projectId: string; taskId: string }) {
      const access = await authorize(input, ProjectPermission.TaskView, {
        kind: 'task',
        taskId: input.taskId,
      });
      const task = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        include: taskInclude,
      });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      return toSummary(task);
    },

    // -------------------------------------------------------------------------
    // Update
    // -------------------------------------------------------------------------

    async update(
      input: Input & { projectId: string; taskId: string } & UpdateTaskInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.TaskUpdate, {
        kind: 'task',
        taskId: input.taskId,
      });
      const existing = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: {
          id: true,
          title: true,
          key: true,
          status: true,
          creatorId: true,
          assignees: { select: { userId: true } },
        },
      });
      if (!existing) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      // A task status decision is a submission review action. `task.update`
      // never implies the ability to approve, review or request changes.
      const submissionAction: 'approve' | 'review' | 'request_revision' | null =
        input.status === 'APPROVED'
          ? 'approve'
          : input.status === 'UNDER_REVIEW'
            ? 'review'
            : input.status === 'CHANGES_REQUESTED'
              ? 'request_revision'
              : null;
      if (submissionAction) {
        const requiredPermission =
          submissionAction === 'approve'
            ? ProjectPermission.SubmissionApprove
            : submissionAction === 'review'
              ? ProjectPermission.SubmissionReview
              : ProjectPermission.SubmissionRequestRevision;
        if (!access.permissions.includes(requiredPermission)) {
          throw new AppError(
            403,
            'PERMISSION_DENIED',
            'Your project role does not allow this submission decision',
            { requiredPermission },
          );
        }
        const isSelf =
          existing.creatorId === input.userId ||
          existing.assignees.some((assignee) => assignee.userId === input.userId);
        if (isSelf) {
          assertNotSelfReview({
            actorId: input.userId,
            subjectUserId: input.userId,
            action: submissionAction,
          });
        }
      }

      // Verify parent task if changing.
      if (input.parentTaskId !== undefined && input.parentTaskId) {
        if (input.parentTaskId === input.taskId)
          throw new AppError(
            400,
            'TASK_SELF_PARENT',
            'A task cannot be its own parent',
          );
        const parent = await prisma.task.findFirst({
          where: {
            id: input.parentTaskId,
            projectId: access.project.id,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!parent)
          throw new AppError(404, 'TASK_NOT_FOUND', 'The parent task does not exist');
      }

      return prisma.$transaction(async (tx) => {
        const row = await tx.task.update({
          where: { id: existing.id },
          data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.category !== undefined ? { category: input.category } : {}),
            ...(input.labels !== undefined ? { labels: input.labels } : {}),
            ...(input.startDate !== undefined ? { startDate: dateOrNull(input.startDate) } : {}),
            ...(input.dueDate !== undefined ? { dueDate: dateOrNull(input.dueDate) } : {}),
            ...(input.position !== undefined ? { position: input.position } : {}),
            ...(input.parentTaskId !== undefined
              ? { parentTaskId: input.parentTaskId }
              : {}),
          },
          include: taskInclude,
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.updated',
          targetType: 'Task',
          targetId: row.id,
          metadata: {
            key: row.key,
            title: row.title,
            projectId: access.project.id,
            changes: Object.keys(input).filter(
              (k) => k !== 'userId' && k !== 'workspaceId' && k !== 'projectId' && k !== 'taskId',
            ),
          },
          ...context,
        });
        if (submissionAction === 'approve' || submissionAction === 'request_revision') {
          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action:
              submissionAction === 'approve' ? 'task.approved' : 'task.changes_requested',
            targetType: 'Task',
            targetId: row.id,
            metadata: {
              key: row.key,
              projectId: access.project.id,
              previousStatus: existing.status,
              status: row.status,
            },
            ...context,
          });
        }
        return toSummary(row);
      });
    },

    // -------------------------------------------------------------------------
    // Remove (soft delete)
    // -------------------------------------------------------------------------

    async remove(input: Input & { projectId: string; taskId: string }, context: RequestContext) {
      const access = await authorize(input, ProjectPermission.TaskDelete, {
        kind: 'task',
        taskId: input.taskId,
      });
      const existing = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true },
      });
      if (!existing) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      await prisma.$transaction(async (tx) => {
        await tx.task.update({
          where: { id: existing.id },
          data: { deletedAt: new Date() },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.deleted',
          targetType: 'Task',
          targetId: existing.id,
          metadata: { key: existing.key, projectId: access.project.id },
          ...context,
        });
      });
      return { id: existing.id, deleted: true };
    },

    // -------------------------------------------------------------------------
    // Archive / Restore
    // -------------------------------------------------------------------------

    async archive(input: Input & { projectId: string; taskId: string }, context: RequestContext) {
      const access = await authorize(input, ProjectPermission.TaskDelete, {
        kind: 'task',
        taskId: input.taskId,
      });
      const existing = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true, archivedAt: true },
      });
      if (!existing) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      if (existing.archivedAt) return { id: existing.id, archived: true };

      return prisma.$transaction(async (tx) => {
        const row = await tx.task.update({
          where: { id: existing.id },
          data: { archivedAt: new Date() },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.archived',
          targetType: 'Task',
          targetId: row.id,
          metadata: { key: existing.key, projectId: access.project.id },
          ...context,
        });
        return { id: row.id, archived: true };
      });
    },

    async restore(input: Input & { projectId: string; taskId: string }, context: RequestContext) {
      const access = await authorize(input, ProjectPermission.TaskDelete, {
        kind: 'task',
        taskId: input.taskId,
      });
      const existing = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true, archivedAt: true },
      });
      if (!existing) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      if (!existing.archivedAt) return { id: existing.id, archived: false };

      return prisma.$transaction(async (tx) => {
        const row = await tx.task.update({
          where: { id: existing.id },
          data: { archivedAt: null },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.restored',
          targetType: 'Task',
          targetId: row.id,
          metadata: { key: existing.key, projectId: access.project.id },
          ...context,
        });
        return { id: row.id, archived: false };
      });
    },

    // -------------------------------------------------------------------------
    // Complete / Reopen
    // -------------------------------------------------------------------------

    async complete(
      input: Input & { projectId: string; taskId: string },
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.TaskComplete, {
        kind: 'task',
        taskId: input.taskId,
      });
      const existing = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true, title: true, status: true },
      });
      if (!existing) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      if (existing.status === 'APPROVED')
        return { id: existing.id, status: 'APPROVED', completedAt: null as Date | null };

      const completed = await prisma.$transaction(async (tx) => {
        const row = await tx.task.update({
          where: { id: existing.id },
          data: { status: 'APPROVED', completedAt: new Date() },
          select: { id: true, status: true, completedAt: true },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.completed',
          targetType: 'Task',
          targetId: row.id,
          metadata: {
            key: existing.key,
            title: existing.title,
            previousStatus: existing.status,
            projectId: access.project.id,
          },
          ...context,
        });
        return { id: row.id, status: row.status, completedAt: row.completedAt };
      });

      await enqueueAutomationRunsSafely({
        workspaceId: input.workspaceId,
        trigger: 'EVENT_TASK_COMPLETED',
        eventKey: `task.completed:${completed.id}:${completed.completedAt?.toISOString() ?? 'unknown'}`,
        payload: {
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          taskId: completed.id,
          key: existing.key,
          title: existing.title,
          previousStatus: existing.status,
          status: completed.status,
          completedAt: completed.completedAt?.toISOString() ?? null,
        },
      });

      return completed;
    },

    async reopen(input: Input & { projectId: string; taskId: string }, context: RequestContext) {
      const access = await authorize(input, ProjectPermission.TaskUpdate, {
        kind: 'task',
        taskId: input.taskId,
      });
      const existing = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true, title: true, status: true },
      });
      if (!existing) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      if (existing.status !== 'APPROVED')
        return { id: existing.id, status: existing.status as TaskStatus, completedAt: null };

      return prisma.$transaction(async (tx) => {
        const row = await tx.task.update({
          where: { id: existing.id },
          data: { status: 'IN_PROGRESS', completedAt: null },
          select: { id: true, status: true, completedAt: true },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.reopened',
          targetType: 'Task',
          targetId: row.id,
          metadata: {
            key: existing.key,
            title: existing.title,
            previousStatus: existing.status,
            projectId: access.project.id,
          },
          ...context,
        });
        return { id: row.id, status: row.status, completedAt: row.completedAt };
      });
    },

    // -------------------------------------------------------------------------
    // Assignee management
    // -------------------------------------------------------------------------

    async addAssignee(
      input: Input & { projectId: string; taskId: string } & AddAssigneeInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.TaskAssign, {
        kind: 'task',
        taskId: input.taskId,
      });
      const task = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true, title: true, status: true },
      });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      // Verify the target is an active workspace member.
      const target = await prisma.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: input.workspaceId,
            userId: input.targetUserId,
          },
        },
      });
      if (!target || target.status !== 'ACTIVE')
        throw new AppError(
          404,
          'WORKSPACE_MEMBER_NOT_FOUND',
          'That active workspace member does not exist',
        );

      const result = await prisma.$transaction(async (tx) => {
        const assignee = await tx.taskAssignee.upsert({
          where: {
            taskId_userId: { taskId: task.id, userId: input.targetUserId },
          },
          create: {
            taskId: task.id,
            userId: input.targetUserId,
            assignedBy: input.userId,
          },
          update: {},
          include: { user: { select: { id: true, name: true, email: true } } },
        });

        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.assignee_added',
          targetType: 'TaskAssignee',
          targetId: assignee.userId,
          metadata: { taskId: task.id, taskKey: task.key, projectId: access.project.id },
          ...context,
        });

        // In-app notification for the new assignee (skip self-assignment).
        if (input.targetUserId !== input.userId) {
          await createNotification(tx, {
            userId: input.targetUserId,
            type: 'TASK_ASSIGNED',
            title: 'Task assigned to you',
            data: {
              workspaceId: input.workspaceId,
              projectId: access.project.id,
              taskId: task.id,
            },
          });
        }

        return {
          taskId: task.id,
          userId: assignee.userId,
          user: assignee.user,
          assignedBy: input.userId,
        };
      });

      if (deps.assignmentNotifier && input.targetUserId !== input.userId) {
        try {
          await deps.assignmentNotifier.notify({
            taskId: task.id,
            assigneeId: input.targetUserId,
          });
        } catch {
          // The email seam is non-fatal: the assignment already committed.
        }
      }

      return result;
    },

    async removeAssignee(
      input: Input & { projectId: string; taskId: string; targetUserId: string },
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.TaskReassign, {
        kind: 'task',
        taskId: input.taskId,
      });
      const task = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true },
      });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      return prisma.$transaction(async (tx) => {
        const result = await tx.taskAssignee.deleteMany({
          where: { taskId: task.id, userId: input.targetUserId },
        });
        if (!result.count)
          throw new AppError(404, 'ASSIGNEE_NOT_FOUND', 'That assignee does not exist');

        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.assignee_removed',
          targetType: 'TaskAssignee',
          targetId: input.targetUserId,
          metadata: { taskId: task.id, taskKey: task.key, projectId: access.project.id },
          ...context,
        });
        return { taskId: task.id, userId: input.targetUserId, removed: true };
      });
    },

    // -------------------------------------------------------------------------
    // Dependency management
    // -------------------------------------------------------------------------

    async addDependency(
      input: Input & { projectId: string; taskId: string } & AddDependencyInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.TaskUpdate, {
        kind: 'task',
        taskId: input.taskId,
      });
      const task = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true },
      });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      // Prevent self-dependency.
      if (input.taskId === input.dependsOnTaskId)
        throw new AppError(
          400,
          'TASK_SELF_DEPENDENCY',
          'A task cannot depend on itself',
        );

      // Verify the blocking task exists in the same project.
      const blockingTask = await prisma.task.findFirst({
        where: {
          id: input.dependsOnTaskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true, title: true },
      });
      if (!blockingTask)
        throw new AppError(404, 'TASK_NOT_FOUND', 'The blocking task does not exist');

      // Prevent duplicate dependency.
      const existing = await prisma.taskDependency.findUnique({
        where: {
          taskId_dependsOnTaskId: {
            taskId: task.id,
            dependsOnTaskId: blockingTask.id,
          },
        },
        select: { id: true },
      });
      if (existing)
        throw new AppError(
          409,
          'DEPENDENCY_EXISTS',
          'This dependency already exists',
        );

      // Prevent circular dependency.
      const cyclic = await wouldCreateCycle(
        prisma,
        access.project.id,
        task.id,
        blockingTask.id,
      );
      if (cyclic)
        throw new AppError(
          409,
          'CIRCULAR_DEPENDENCY',
          'Adding this dependency would create a circular reference',
        );

      return prisma.$transaction(async (tx) => {
        const dependency = await tx.taskDependency.create({
          data: { taskId: task.id, dependsOnTaskId: blockingTask.id },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.dependency_added',
          targetType: 'TaskDependency',
          targetId: dependency.id,
          metadata: {
            taskId: task.id,
            taskKey: task.key,
            dependsOnTaskId: blockingTask.id,
            dependsOnTaskKey: blockingTask.key,
            projectId: access.project.id,
          },
          ...context,
        });
        return {
          id: dependency.id,
          taskId: task.id,
          dependsOnTaskId: blockingTask.id,
          dependsOnTask: {
            id: blockingTask.id,
            key: blockingTask.key,
            title: blockingTask.title,
          },
        };
      });
    },

    async removeDependency(
      input: Input & { projectId: string; taskId: string; dependsOnTaskId: string },
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.TaskUpdate, {
        kind: 'task',
        taskId: input.taskId,
      });
      const task = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true },
      });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      return prisma.$transaction(async (tx) => {
        const result = await tx.taskDependency.deleteMany({
          where: { taskId: task.id, dependsOnTaskId: input.dependsOnTaskId },
        });
        if (!result.count)
          throw new AppError(
            404,
            'DEPENDENCY_NOT_FOUND',
            'That dependency does not exist',
          );

        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.dependency_removed',
          targetType: 'TaskDependency',
          targetId: input.dependsOnTaskId,
          metadata: {
            taskId: task.id,
            taskKey: task.key,
            dependsOnTaskId: input.dependsOnTaskId,
            projectId: access.project.id,
          },
          ...context,
        });
        return {
          taskId: task.id,
          dependsOnTaskId: input.dependsOnTaskId,
          removed: true,
        };
      });
    },

    // -------------------------------------------------------------------------
    // Comment management
    // -------------------------------------------------------------------------

    async addComment(
      input: Input & { projectId: string; taskId: string } & CreateCommentInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.TaskComment, {
        kind: 'task',
        taskId: input.taskId,
      });
      const task = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true },
      });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      const mentionedUserIds = [...new Set(input.mentionedUserIds ?? [])]
        .filter((mentionedUserId) => mentionedUserId !== input.userId);
      for (const mentionedUserId of mentionedUserIds) {
        try {
          const mentionedWorkspace = await requireWorkspaceAccess(prisma, {
            userId: mentionedUserId,
            workspaceId: input.workspaceId,
            capability: WorkspaceCapability.ViewWorkspace,
          });
          await authorizeProject(prisma, {
            actor: {
              userId: mentionedUserId,
              workspaceId: input.workspaceId,
              workspaceRole: mentionedWorkspace.effectiveRole,
            },
            projectId: access.project.id,
            permission: ProjectPermission.TaskView,
            resource: { kind: 'task', taskId: task.id },
          });
        } catch (error) {
          if (error instanceof AppError && error.statusCode < 500) {
            throw new AppError(
              400,
              'INVALID_MENTION_RECIPIENT',
              'One or more mentioned users cannot access this task',
            );
          }
          throw error;
        }
      }

      // Verify parent comment if this is a reply.
      if (input.parentId) {
        const parent = await prisma.comment.findFirst({
          where: {
            id: input.parentId,
            taskId: task.id,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!parent)
          throw new AppError(404, 'COMMENT_NOT_FOUND', 'The parent comment does not exist');
      }

      const comment = await prisma.$transaction(async (tx) => {
        const comment = await tx.comment.create({
          data: {
            taskId: task.id,
            authorId: input.userId,
            body: input.body,
            parentId: input.parentId ?? null,
          },
          include: {
            author: { select: { id: true, name: true } },
            replies: {
              include: { author: { select: { id: true, name: true } } },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            },
          },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.comment_created',
          targetType: 'Comment',
          targetId: comment.id,
          metadata: {
            taskId: task.id,
            taskKey: task.key,
            projectId: access.project.id,
            isReply: Boolean(input.parentId),
          },
          ...context,
        });
        if (mentionedUserIds.length) {
          await tx.commentMention.createMany({
            data: mentionedUserIds.map((userId) => ({ commentId: comment.id, userId })),
          });
          for (const mentionedUserId of mentionedUserIds) {
            await createNotification(tx, {
              userId: mentionedUserId,
              type: 'MENTION',
              title: `${comment.author.name} mentioned you in a task comment`,
              data: {
                workspaceId: input.workspaceId,
                projectId: access.project.id,
                taskId: task.id,
                commentId: comment.id,
              },
            });
          }
        }
        return { ...comment, mentions: mentionedUserIds.map((userId) => ({ userId })) };
      });
      if (deps.mentionNotifier) {
        for (const mentionedUserId of mentionedUserIds) {
          try {
            await deps.mentionNotifier.notify({ commentId: comment.id, mentionedUserId });
          } catch {
            // Email is post-commit and must not roll back the persisted comment.
          }
        }
      }
      return comment;
    },

    async updateComment(
      input: Input & {
        projectId: string;
        taskId: string;
        commentId: string;
      } & UpdateCommentInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.TaskComment, {
        kind: 'comment',
        taskId: input.taskId,
        commentId: input.commentId,
      });
      const task = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true },
      });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      const comment = await prisma.comment.findFirst({
        where: {
          id: input.commentId,
          taskId: task.id,
          deletedAt: null,
        },
        select: { id: true, authorId: true, body: true },
      });
      if (!comment)
        throw new AppError(404, 'COMMENT_NOT_FOUND', 'That comment does not exist');

      // Only the author may edit a comment.
      if (comment.authorId !== input.userId)
        throw new AppError(403, 'COMMENT_NOT_YOURS', 'You can only edit your own comments');

      return prisma.$transaction(async (tx) => {
        const row = await tx.comment.update({
          where: { id: comment.id },
          data: {
            body: input.body,
            editedAt: new Date(),
          },
          include: {
            author: { select: { id: true, name: true } },
            replies: {
              include: { author: { select: { id: true, name: true } } },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            },
          },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.comment_updated',
          targetType: 'Comment',
          targetId: row.id,
          metadata: {
            taskId: task.id,
            taskKey: task.key,
            projectId: access.project.id,
          },
          ...context,
        });
        return row;
      });
    },

    async deleteComment(
      input: Input & { projectId: string; taskId: string; commentId: string },
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.TaskComment, {
        kind: 'comment',
        taskId: input.taskId,
        commentId: input.commentId,
      });
      const task = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true },
      });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      const comment = await prisma.comment.findFirst({
        where: {
          id: input.commentId,
          taskId: task.id,
          deletedAt: null,
        },
        select: { id: true, authorId: true },
      });
      if (!comment)
        throw new AppError(404, 'COMMENT_NOT_FOUND', 'That comment does not exist');

      // Only the author or a project manager may delete a comment.
      const isAuthor = comment.authorId === input.userId;
      const isManager =
        access.isWorkspaceAdmin || access.projectRole === 'PROJECT_MANAGER';
      if (!isAuthor && !isManager) {
        throw new AppError(
          403,
          'COMMENT_DELETE_FORBIDDEN',
          'You can only delete your own comments',
        );
      }

      await prisma.$transaction(async (tx) => {
        await tx.comment.update({
          where: { id: comment.id },
          data: { deletedAt: new Date() },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.comment_deleted',
          targetType: 'Comment',
          targetId: comment.id,
          metadata: {
            taskId: task.id,
            taskKey: task.key,
            projectId: access.project.id,
            byManager: !isAuthor,
          },
          ...context,
        });
      });
      return { id: comment.id, deleted: true };
    },

    async listComments(
      input: Input & { projectId: string; taskId: string; limit: number },
    ) {
      const access = await authorize(input, ProjectPermission.TaskView, {
        kind: 'task',
        taskId: input.taskId,
      });
      const task = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      // Fetch top-level comments and their replies.
      const comments = await prisma.comment.findMany({
        where: {
          taskId: task.id,
          parentId: null,
          deletedAt: null,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: input.limit,
        include: {
          author: { select: { id: true, name: true } },
          replies: {
            where: { deletedAt: null },
            include: { author: { select: { id: true, name: true } } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
        },
      });

      return { items: comments };
    },
  };
}
