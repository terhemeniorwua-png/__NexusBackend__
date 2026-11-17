import type { TaskAssignmentNotifier } from '../../services/task-assignment-notifier';
import type { MentionEmailNotifier } from '../../services/mention-email-notifier';
import { Prisma, type PrismaClient, type TaskStatus } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { emitDomainEvent } from '../../realtime/domain-events';
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
  type WorkspaceAccessContext,
} from '../authorization';
import type { RequestContext } from '../auth/auth.types';
import type {
  AddAssigneeInput,
  AddDependencyInput,
  CompleteSubtaskInput,
  CreateCommentInput,
  CreateTaskInput,
  ListTasksQuery,
  ReviewTaskInput,
  SubmitTaskInput,
  UpdateCommentInput,
  UpdateTaskInput,
} from './task.schemas';

type Input = { userId: string; workspaceId: string; context: WorkspaceAccessContext };

const taskInclude = {
  creator: { select: { id: true, name: true } },
  submittedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
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
  reportedBlockers: {
    orderBy: [{ createdAt: 'desc' as const }],
    include: {
      reportedBy: { select: { id: true, name: true } },
      notifyUser: { select: { id: true, name: true } },
      resolvedBy: { select: { id: true, name: true } },
    },
  },
  _count: { select: { subTasks: true, comments: true, attachments: true } },
};

type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

interface TaskSummary extends Omit<TaskRow, '_count'> {
  subTaskCount: number;
  commentCount: number;
  attachmentCount: number;
  hasOpenBlocker: boolean;
}

function toSummary(row: TaskRow): TaskSummary {
  const { _count, reportedBlockers, ...task } = row;
  const hasOpenBlocker = reportedBlockers.some((b) => b.status === 'OPEN');
  return {
    ...task,
    reportedBlockers,
    subTaskCount: _count.subTasks,
    commentCount: _count.comments,
    attachmentCount: _count.attachments,
    hasOpenBlocker,
  };
}

function isSubtaskApproved(status: TaskStatus): boolean {
  return status === 'APPROVED';
}

function computeProgress(
  subtasks: Array<{ status: TaskStatus; weight?: number | null }>,
): { percent: number; completed: number; total: number } {
  const total = subtasks.length;
  const completed = subtasks.filter((task) => isSubtaskApproved(task.status)).length;
  if (total === 0) return { percent: 0, completed: 0, total: 0 };
  const totalWeight = subtasks.reduce((sum, task) => sum + (task.weight ?? 1), 0);
  const completedWeight = subtasks.reduce(
    (sum, task) => sum + (isSubtaskApproved(task.status) ? (task.weight ?? 1) : 0),
    0,
  );
  const percent = totalWeight === 0 ? 0 : Math.round((completedWeight / totalWeight) * 100);
  return { percent, completed, total };
}

function getRequiredDeliverables(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is { label?: string; required?: boolean } => Boolean(item) && typeof item === 'object')
    .filter((item) => item.required !== false)
    .map((item) => (typeof item.label === 'string' ? item.label.trim() : ''))
    .filter(Boolean);
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

type DateLike = Date | string | null | undefined;
function toDate(value: DateLike): Date | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function effectiveStart(task: { startDate: Date | null; dueDate: Date | null }): Date | null {
  return task.startDate ?? task.dueDate;
}

function effectiveEnd(task: { startDate: Date | null; dueDate: Date | null }): Date | null {
  return task.dueDate ?? task.startDate;
}

export async function assertDependencyDateConsistency(
  tx: Prisma.TransactionClient | PrismaClient,
  projectId: string,
  taskId: string,
  dates: { startDate?: DateLike; dueDate?: DateLike },
  options: { isCreate?: boolean } = {},
): Promise<void> {
  const current = await tx.task.findFirst({
    where: { id: taskId, projectId, deletedAt: null },
    select: {
      id: true,
      key: true,
      startDate: true,
      dueDate: true,
      dependencies: {
        select: {
          dependsOnTask: { select: { id: true, key: true, startDate: true, dueDate: true, deletedAt: true } },
        },
      },
      blockers: {
        select: {
          task: { select: { id: true, key: true, startDate: true, dueDate: true, deletedAt: true } },
        },
      },
    },
  });
  if (!current && !options.isCreate) return;

  const start = dates.startDate !== undefined ? toDate(dates.startDate) : (current?.startDate ?? null);
  const due = dates.dueDate !== undefined ? toDate(dates.dueDate) : (current?.dueDate ?? null);
  const candidate = { startDate: start, dueDate: due };
  const candidateStart = effectiveStart(candidate);
  const candidateEnd = effectiveEnd(candidate);

  if (current) {
    for (const dep of current.dependencies) {
      const blocker = dep.dependsOnTask;
      if (blocker.deletedAt) continue;
      const blockerEnd = effectiveEnd(blocker);
      if (candidateStart && blockerEnd && candidateStart.getTime() < blockerEnd.getTime()) {
        throw new AppError(
          400,
          'TASK_DATE_CONFLICT',
          `Task dates conflict with dependency ${blocker.key}: this task cannot start before its dependency ends`,
          { details: { dependencyTaskId: blocker.id, dependencyKey: blocker.key } },
        );
      }
    }
    for (const rel of current.blockers) {
      const dependent = rel.task;
      if (dependent.deletedAt) continue;
      const dependentStart = effectiveStart(dependent);
      if (candidateEnd && dependentStart && dependentStart.getTime() < candidateEnd.getTime()) {
        throw new AppError(
          400,
          'TASK_DATE_CONFLICT',
          `Task dates conflict with dependent task ${dependent.key}: dependent tasks cannot start before this task ends`,
          { details: { dependentTaskId: dependent.id, dependentKey: dependent.key } },
        );
      }
    }
  }
}

export async function assertDependencyPairDateConsistency(
  tx: Prisma.TransactionClient | PrismaClient,
  projectId: string,
  taskId: string,
  dependsOnTaskId: string,
): Promise<void> {
  const [task, blocker] = await Promise.all([
    tx.task.findFirst({
      where: { id: taskId, projectId, deletedAt: null },
      select: { id: true, key: true, startDate: true, dueDate: true },
    }),
    tx.task.findFirst({
      where: { id: dependsOnTaskId, projectId, deletedAt: null },
      select: { id: true, key: true, startDate: true, dueDate: true },
    }),
  ]);
  if (!task || !blocker) return;
  const taskStart = effectiveStart(task);
  const blockerEnd = effectiveEnd(blocker);
  if (taskStart && blockerEnd && taskStart.getTime() < blockerEnd.getTime()) {
    throw new AppError(
      400,
      'TASK_DATE_CONFLICT',
      `Task ${task.key} cannot start before dependency ${blocker.key} ends`,
      { details: { taskId: task.id, dependencyTaskId: blocker.id } },
    );
  }
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
      context: input.context,
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

        if (input.weight !== undefined && !input.parentTaskId) {
          throw new AppError(
            400,
            'INVALID_REQUEST',
            'Weight can only be set on subtasks',
          );
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
            ...(input.weight !== undefined ? { weight: input.weight } : {}),
            creatorId: input.userId,
            requiresApproval: input.requiresApproval ?? false,
            expectedDeliverables:
              input.expectedDeliverables === undefined
                ? undefined
                : input.expectedDeliverables === null
                  ? Prisma.JsonNull
                  : (input.expectedDeliverables as Prisma.InputJsonValue),
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

        return toSummary(task as TaskRow);
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

      emitDomainEvent('task.created', {
        workspaceId: input.workspaceId,
        projectId: access.project.id,
        taskId: created.id,
        actorId: input.userId,
        task: { id: created.id, key: created.key, title: created.title, status: created.status },
      });
      for (const assigneeId of input.assigneeIds ?? []) {
        if (assigneeId !== input.userId) {
          emitDomainEvent('task.assigned', {
            workspaceId: input.workspaceId,
            projectId: access.project.id,
            taskId: created.id,
            assigneeId,
            actorId: input.userId,
          });
        }
        await enqueueAutomationRunsSafely({
          workspaceId: input.workspaceId,
          trigger: 'EVENT_TASK_ASSIGNED' as never,
          eventKey: `task.assigned:${created.id}:${assigneeId}`,
          payload: {
            workspaceId: input.workspaceId,
            projectId: access.project.id,
            taskId: created.id,
            key: created.key,
            title: created.title,
            status: created.status,
            assigneeId,
            actorId: input.userId,
          },
        });
      }

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
          parentTaskId: true,
          assignees: { select: { userId: true } },
        },
      });
      if (!existing) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      if (input.weight !== undefined && !existing.parentTaskId) {
        throw new AppError(
          400,
          'INVALID_REQUEST',
          'Weight can only be set on subtasks',
        );
      }

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

      if (input.startDate !== undefined || input.dueDate !== undefined) {
        await assertDependencyDateConsistency(prisma, access.project.id, existing.id, {
          ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
          ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        });
      }

      const updatedTask = await prisma.$transaction(async (tx) => {
        const statusChanging = input.status !== undefined && input.status !== existing.status;
        const submissionFields: Prisma.TaskUpdateInput = {};
        if (statusChanging && input.status === 'SUBMITTED') {
          submissionFields.submittedAt = new Date();
          submissionFields.submittedBy = { connect: { id: input.userId } };
          submissionFields.reviewFeedback = null;
          submissionFields.reviewedAt = null;
          submissionFields.reviewedBy = { disconnect: true };
        }
        if (submissionAction === 'approve' || submissionAction === 'request_revision') {
          submissionFields.reviewedAt = new Date();
          submissionFields.reviewedBy = { connect: { id: input.userId } };
          if (submissionAction === 'request_revision' && input.description === undefined) {
            // keep existing reviewFeedback unless explicitly managed via dedicated endpoints
          }
        }
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
            ...(input.weight !== undefined ? { weight: input.weight } : {}),
            ...(input.requiresApproval !== undefined
              ? { requiresApproval: input.requiresApproval }
              : {}),
            ...(input.expectedDeliverables !== undefined
              ? {
                  expectedDeliverables:
                    input.expectedDeliverables === null
                      ? Prisma.JsonNull
                      : (input.expectedDeliverables as Prisma.InputJsonValue),
                }
              : {}),
            ...(submissionFields as Prisma.TaskUpdateInput),
          } as Prisma.TaskUpdateInput,
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
        return toSummary(row as TaskRow);
      });
      emitDomainEvent('task.updated', {
        workspaceId: input.workspaceId,
        projectId: access.project.id,
        taskId: updatedTask.id,
        actorId: input.userId,
        changes: Object.keys(input).filter(
          (k) => k !== 'userId' && k !== 'workspaceId' && k !== 'projectId' && k !== 'taskId',
        ),
        task: { id: updatedTask.id, key: (updatedTask as { key?: string }).key, status: updatedTask.status },
      });
      if (input.status !== undefined && input.status !== existing.status) {
        await enqueueAutomationRunsSafely({
          workspaceId: input.workspaceId,
          trigger: 'EVENT_TASK_STATUS_CHANGED' as never,
          eventKey: `task.status_changed:${updatedTask.id}:${updatedTask.updatedAt}`,
          payload: {
            workspaceId: input.workspaceId,
            projectId: access.project.id,
            taskId: updatedTask.id,
            key: (updatedTask as { key?: string }).key,
            previousStatus: existing.status,
            status: updatedTask.status,
            actorId: input.userId,
          },
        });
      }
      return updatedTask;
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
      await enqueueAutomationRunsSafely({
        workspaceId: input.workspaceId,
        trigger: 'EVENT_TASK_STATUS_CHANGED' as never,
        eventKey: `task.status_changed:${completed.id}:${existing.status}:${completed.status}:${completed.completedAt?.toISOString() ?? Date.now()}`,
        payload: {
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          taskId: completed.id,
          key: existing.key,
          previousStatus: existing.status,
          status: completed.status,
          actorId: input.userId,
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

      const reopened = await prisma.$transaction(async (tx) => {
        const row = await tx.task.update({
          where: { id: existing.id },
          data: { status: 'IN_PROGRESS', completedAt: null },
          select: { id: true, key: true, status: true, completedAt: true, updatedAt: true },
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
        return { id: row.id, key: row.key, status: row.status, completedAt: row.completedAt, updatedAt: row.updatedAt };
      });

      await enqueueAutomationRunsSafely({
        workspaceId: input.workspaceId,
        trigger: 'EVENT_TASK_STATUS_CHANGED' as never,
        eventKey: `task.status_changed:${reopened.id}:${reopened.updatedAt.toISOString()}`,
        payload: {
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          taskId: reopened.id,
          key: reopened.key,
          title: existing.title,
          previousStatus: existing.status,
          status: reopened.status,
          actorId: input.userId,
        },
      });

      return { id: reopened.id, status: reopened.status, completedAt: reopened.completedAt };
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
          assignedAt: assignee.assignedAt,
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

      if (input.targetUserId !== input.userId) {
        emitDomainEvent('task.assigned', {
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          taskId: task.id,
          assigneeId: input.targetUserId,
          actorId: input.userId,
        });
      }
      await enqueueAutomationRunsSafely({
        workspaceId: input.workspaceId,
        trigger: 'EVENT_TASK_ASSIGNED' as never,
        eventKey: `task.assigned:${task.id}:${input.targetUserId}:${result.assignedAt.toISOString()}`,
        payload: {
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          taskId: task.id,
          key: task.key,
          title: task.title,
          assigneeId: input.targetUserId,
          actorId: input.userId,
        },
      });

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

      await assertDependencyPairDateConsistency(prisma, access.project.id, task.id, blockingTask.id);

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
            context: input.context,
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
      emitDomainEvent('comment.created', {
        workspaceId: input.workspaceId,
        projectId: access.project.id,
        taskId: task.id,
        commentId: comment.id,
        authorId: input.userId,
        comment: {
          id: comment.id,
          taskId: task.id,
          authorId: comment.author.id,
          body: comment.body,
          parentId: comment.parentId,
          createdAt: comment.createdAt instanceof Date ? comment.createdAt.toISOString() : String(comment.createdAt),
        },
      });
      for (const mentionedUserId of mentionedUserIds) {
        emitDomainEvent('mention.created', {
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          taskId: task.id,
          commentId: comment.id,
          mentionedUserId,
          actorId: input.userId,
        });
      }
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

    async getWorkspace(input: Input & { projectId: string; taskId: string }) {
      const access = await authorize(input, ProjectPermission.TaskView, {
        kind: 'task',
        taskId: input.taskId,
      });
      const task = await prisma.task.findFirst({
        where: { id: input.taskId, projectId: access.project.id, deletedAt: null },
        include: taskInclude,
      });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      const subtasks = await prisma.task.findMany({
        where: { projectId: access.project.id, parentTaskId: task.id, deletedAt: null },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        include: taskInclude,
      });
      const subtaskSummaries = subtasks.map(toSummary);
      const progress = computeProgress(subtasks);

      const recent = await prisma.auditLog.findMany({
        where: {
          OR: [
            { targetType: 'Task', targetId: task.id },
            { targetType: 'Comment', metadata: { path: ['taskId'], equals: task.id } },
            { targetType: 'TaskAssignee', metadata: { path: ['taskId'], equals: task.id } },
            { targetType: 'TaskDependency', metadata: { path: ['taskId'], equals: task.id } },
            { targetType: 'TaskBlocker', metadata: { path: ['taskId'], equals: task.id } },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 5,
        select: { id: true, action: true, actorId: true, metadata: true, createdAt: true },
      });

      const taskSummary = toSummary(task);
      const assignedBy =
        taskSummary.assignees.length === 1 ? taskSummary.assignees[0]?.assignedBy ?? null : null;
      return {
        task: taskSummary,
        subtasks: subtaskSummaries,
        progress,
        people: {
          assignees: taskSummary.assignees,
          assignedBy,
          reviewer: taskSummary.reviewedBy
            ? { id: taskSummary.reviewedBy.id, name: taskSummary.reviewedBy.name }
            : null,
        },
        schedule: {
          startDate: taskSummary.startDate,
          dueDate: taskSummary.dueDate,
          overdue:
            Boolean(taskSummary.dueDate) &&
            taskSummary.status !== 'APPROVED' &&
            new Date(taskSummary.dueDate as Date).getTime() < Date.now(),
        },
        recentActivity: recent,
      };
    },

    async listActivity(
      input: Input & { projectId: string; taskId: string; cursor?: string; limit: number },
    ) {
      const access = await authorize(input, ProjectPermission.TaskView, {
        kind: 'task',
        taskId: input.taskId,
      });
      const task = await prisma.task.findFirst({
        where: { id: input.taskId, projectId: access.project.id, deletedAt: null },
        select: { id: true },
      });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      let cursorFilter: Prisma.AuditLogWhereInput | undefined;
      if (input.cursor) {
        const cursorRow = await prisma.auditLog.findUnique({
          where: { id: input.cursor },
          select: { id: true, createdAt: true },
        });
        if (cursorRow) {
          cursorFilter = {
            OR: [
              { createdAt: { lt: cursorRow.createdAt } },
              { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } },
            ],
          };
        }
      }

      const rows = await prisma.auditLog.findMany({
        where: {
          AND: [
            {
              OR: [
                { targetType: 'Task', targetId: task.id },
                { targetType: 'Comment', metadata: { path: ['taskId'], equals: task.id } },
                { targetType: 'TaskAssignee', metadata: { path: ['taskId'], equals: task.id } },
                { targetType: 'TaskDependency', metadata: { path: ['taskId'], equals: task.id } },
                { targetType: 'TaskBlocker', metadata: { path: ['taskId'], equals: task.id } },
              ],
            },
            ...(cursorFilter ? [cursorFilter] : []),
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: { id: true, action: true, actorId: true, metadata: true, createdAt: true },
      });
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit);
      return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
    },

    async submit(
      input: Input & { projectId: string; taskId: string } & SubmitTaskInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.SubmissionSubmit, {
        kind: 'task',
        taskId: input.taskId,
      });
      const existing = await prisma.task.findFirst({
        where: { id: input.taskId, projectId: access.project.id, deletedAt: null },
        include: taskInclude,
      });
      if (!existing) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      if (!['ASSIGNED', 'IN_PROGRESS', 'CHANGES_REQUESTED', 'SUBMITTED', 'UNDER_REVIEW'].includes(existing.status)) {
        throw new AppError(409, 'TASK_SUBMIT_NOT_ALLOWED', 'This task cannot be submitted in its current state');
      }
      const isAssignee = existing.assignees.some((a) => a.userId === input.userId);
      const canSubmitAsManager = access.permissions.includes(ProjectPermission.TaskUpdate);
      if (!isAssignee && !canSubmitAsManager) {
        throw new AppError(403, 'PERMISSION_DENIED', 'Only an assignee or authorized member can submit this task', {
          requiredPermission: ProjectPermission.SubmissionSubmit,
        });
      }
      const required = getRequiredDeliverables(existing.expectedDeliverables);
      if (required.length && !input.workSummary.trim()) {
        throw new AppError(400, 'DELIVERABLES_REQUIRED', 'A work summary is required for tasks with deliverables');
      }

      const row = await prisma.$transaction(async (tx) => {
        const updated = await tx.task.update({
          where: { id: existing.id },
          data: {
            status: 'SUBMITTED',
            submissionSummary: input.workSummary.trim(),
            submittedAt: new Date(),
            submittedBy: { connect: { id: input.userId } },
            reviewFeedback: null,
            reviewedAt: null,
            reviewedBy: { disconnect: true },
          },
          include: taskInclude,
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.updated',
          targetType: 'Task',
          targetId: updated.id,
          metadata: {
            key: updated.key,
            projectId: access.project.id,
            submitted: true,
            status: updated.status,
          },
          ...context,
        });
        return toSummary(updated);
      });

      await enqueueAutomationRunsSafely({
        workspaceId: input.workspaceId,
        trigger: 'EVENT_TASK_STATUS_CHANGED' as never,
        eventKey: `task.status_changed:${row.id}:${row.updatedAt}`,
        payload: {
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          taskId: row.id,
          key: row.key,
          title: row.title,
          previousStatus: existing.status,
          status: row.status,
          actorId: input.userId,
        },
      });

      return row;
    },

    async review(
      input: Input & { projectId: string; taskId: string } & ReviewTaskInput,
      context: RequestContext,
    ) {
      const actionPermission =
        input.decision === 'APPROVE'
          ? ProjectPermission.SubmissionApprove
          : input.decision === 'START_REVIEW'
            ? ProjectPermission.SubmissionReview
            : ProjectPermission.SubmissionRequestRevision;
      const access = await authorize(input, actionPermission, {
        kind: 'task',
        taskId: input.taskId,
      });
      const existing = await prisma.task.findFirst({
        where: { id: input.taskId, projectId: access.project.id, deletedAt: null },
        include: taskInclude,
      });
      if (!existing) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      const isSubmitter = existing.submittedById === input.userId || existing.assignees.some((a) => a.userId === input.userId);
      if (isSubmitter && input.decision !== 'START_REVIEW') {
        throw new AppError(403, 'SELF_REVIEW_NOT_ALLOWED', 'You cannot review your own submission');
      }

      let nextStatus: TaskStatus;
      if (input.decision === 'START_REVIEW') nextStatus = 'UNDER_REVIEW';
      else if (input.decision === 'APPROVE') nextStatus = 'APPROVED';
      else nextStatus = 'CHANGES_REQUESTED';

      const row = await prisma.$transaction(async (tx) => {
        const updated = await tx.task.update({
          where: { id: existing.id },
          data: {
            status: nextStatus,
            reviewFeedback:
              input.decision === 'REQUEST_CHANGES'
                ? (input.feedback?.trim() ?? null)
                : input.decision === 'APPROVE'
                  ? (input.feedback?.trim() ?? null)
                  : existing.reviewFeedback,
            reviewedAt: input.decision === 'START_REVIEW' ? existing.reviewedAt : new Date(),
            reviewedBy:
              input.decision === 'START_REVIEW'
                ? existing.reviewedById
                  ? { connect: { id: existing.reviewedById } }
                  : undefined
                : { connect: { id: input.userId } },
            completedAt: nextStatus === 'APPROVED' ? new Date() : nextStatus === 'CHANGES_REQUESTED' ? null : existing.completedAt,
          },
          include: taskInclude,
        });
        const auditAction =
          input.decision === 'APPROVE'
            ? 'task.approved'
            : input.decision === 'REQUEST_CHANGES'
              ? 'task.changes_requested'
              : 'task.reviewed';
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: auditAction,
          targetType: 'Task',
          targetId: updated.id,
          metadata: {
            key: updated.key,
            projectId: access.project.id,
            decision: input.decision,
            status: updated.status,
            feedback: input.feedback?.trim() ?? null,
          },
          ...context,
        });
        return toSummary(updated);
      });

      if (row.status !== existing.status) {
        await enqueueAutomationRunsSafely({
          workspaceId: input.workspaceId,
          trigger: 'EVENT_TASK_STATUS_CHANGED' as never,
          eventKey: `task.status_changed:${row.id}:${row.updatedAt}`,
          payload: {
            workspaceId: input.workspaceId,
            projectId: access.project.id,
            taskId: row.id,
            key: row.key,
            title: row.title,
            previousStatus: existing.status,
            status: row.status,
            actorId: input.userId,
          },
        });
      }

      return row;
    },

    async completeSubtask(
      input: Input & { projectId: string; taskId: string; subtaskId: string } & CompleteSubtaskInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.TaskComplete, {
        kind: 'task',
        taskId: input.subtaskId,
      });
      const parent = await prisma.task.findFirst({
        where: { id: input.taskId, projectId: access.project.id, deletedAt: null },
        select: { id: true, key: true, requiresApproval: true },
      });
      if (!parent) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      const subtask = await prisma.task.findFirst({
        where: { id: input.subtaskId, projectId: access.project.id, parentTaskId: input.taskId, deletedAt: null },
        include: taskInclude,
      });
      if (!subtask) throw new AppError(404, 'SUBTASK_NOT_FOUND', 'That subtask does not exist');

      const isAssignee = subtask.assignees.some((a) => a.userId === input.userId);
      const isAuthorizedCollaborator =
        access.projectRole === 'PROJECT_MANAGER' ||
        access.projectRole === 'MEMBER' ||
        access.projectRole === 'COLLABORATOR' ||
        access.isWorkspaceAdmin;
      if (!isAssignee && !isAuthorizedCollaborator) {
        throw new AppError(403, 'PERMISSION_DENIED', 'Only an assignee or authorized collaborator can complete this subtask', {
          requiredPermission: ProjectPermission.TaskComplete,
        });
      }
      if (access.projectRole === 'COLLABORATOR' && !isAssignee) {
        throw new AppError(403, 'PERMISSION_DENIED', 'Collaborators can only complete subtasks assigned to them', {
          requiredPermission: ProjectPermission.TaskComplete,
        });
      }

      const requiresApproval = subtask.requiresApproval || parent.requiresApproval;
      const now = new Date();

      const result = await prisma.$transaction(async (tx) => {
        let updated;
        if (requiresApproval) {
          const summary = input.workSummary?.trim() || 'Subtask completion submitted for review.';
          updated = await tx.task.update({
            where: { id: subtask.id },
            data: {
              status: 'SUBMITTED',
              submissionSummary: summary,
              submittedAt: now,
              submittedBy: { connect: { id: input.userId } },
              reviewFeedback: null,
              reviewedAt: null,
              reviewedBy: { disconnect: true },
              completedAt: null,
            },
            include: taskInclude,
          });
          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: 'task.updated',
            targetType: 'Task',
            targetId: updated.id,
            metadata: {
              key: updated.key,
              projectId: access.project.id,
              subtaskCompletion: true,
              approvalRequired: true,
              parentTaskId: parent.id,
              status: updated.status,
            },
            ...context,
          });
        } else {
          updated = await tx.task.update({
            where: { id: subtask.id },
            data: { status: 'APPROVED', completedAt: now },
            include: taskInclude,
          });
          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: 'task.completed',
            targetType: 'Task',
            targetId: updated.id,
            metadata: {
              key: updated.key,
              projectId: access.project.id,
              subtaskCompletion: true,
              parentTaskId: parent.id,
              previousStatus: subtask.status,
            },
            ...context,
          });
        }

        const siblings = await tx.task.findMany({
          where: { projectId: access.project.id, parentTaskId: parent.id, deletedAt: null },
          select: { status: true },
        });
        const progress = computeProgress(siblings);
        return { subtask: toSummary(updated), progress, requiresApproval, submissionCreated: requiresApproval };
      });

      if (result.subtask.status !== subtask.status) {
        await enqueueAutomationRunsSafely({
          workspaceId: input.workspaceId,
          trigger: 'EVENT_TASK_STATUS_CHANGED' as never,
          eventKey: `task.status_changed:${result.subtask.id}:${result.subtask.updatedAt}`,
          payload: {
            workspaceId: input.workspaceId,
            projectId: access.project.id,
            taskId: result.subtask.id,
            key: result.subtask.key,
            title: result.subtask.title,
            previousStatus: subtask.status,
            status: result.subtask.status,
            actorId: input.userId,
            parentTaskId: parent.id,
            subtaskCompletion: true,
          },
        });
      }

      return result;
    },
  };
}
