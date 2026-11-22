import type { TaskAssignmentNotifier } from '../../services/task-assignment-notifier';
import type { MentionEmailNotifier } from '../../services/mention-email-notifier';
import type { SlackEventNotifier } from '../integrations/slack.events';
import type { AppConfig } from '../../config/env';
import { Prisma, type PrismaClient, type TaskStatus } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent, TaskAuditAction } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { emitDomainEvent } from '../../realtime/domain-events';
import { enqueueAutomationRunsSafely } from '../automation/automation.events';
import { AppError } from '../../utils/errors';
import { assertProjectWritable } from '../projects/project-archive';
import {
  ProjectPermission,
  assertNotSelfReview,
  authorizeProject,
  requireWorkspaceAccess,
  resolveProjectAuthorization,
  WorkspaceCapability,
  type ProjectAuthorizationResource,
  type ProjectPermissionValue,
} from '../authorization';
import type { RequestContext } from '../auth/auth.types';
import { assertTaskStatusTransition } from './task-status';
import { cancelOpenClarificationForAssignee } from './task-clarification.service';
import { isTaskOverdue, taskNotOverdueWhere, taskOverdueWhere } from './task-overdue';
import {
  buildEmailBrand,
  buildTaskSubmittedEmail,
  sendEmail,
} from '../../services/email';
import { isAddressSuppressed } from '../../services/email/suppression.service';
import { isEmailNotificationEnabled } from '../../services/notification-preferences';
import { logger as defaultLogger } from '../../utils/logger';
import type {
  AddAssigneeInput,
  AddDependencyInput,
  AddProgressUpdateInput,
  CompleteSubtaskInput,
  CreateCommentInput,
  CreateTaskInput,
  ListTasksQuery,
  ReviewTaskInput,
  SubmitTaskInput,
  UpdateCommentInput,
  UpdateTaskInput,
} from './task.schemas';

type Input = { userId: string; workspaceId: string };

const MAX_TASK_DEPTH = 3;

const taskInclude = {
  creator: { select: { id: true, name: true } },
  submittedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
  reviewer: { select: { id: true, name: true } },
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
  config?: AppConfig;
  assignmentNotifier?: TaskAssignmentNotifier;
  mentionNotifier?: MentionEmailNotifier;
  /** Best-effort Slack delivery for task assignment events. */
  slackNotifier?: SlackEventNotifier;
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

  const getTaskDepth = async (
    tx: Pick<PrismaClient, 'task'> | Prisma.TransactionClient,
    taskId: string,
  ): Promise<number> => {
    let depth = 1;
    let currentId = taskId;
    while (true) {
      const row: { parentTaskId: string | null } | null = await tx.task.findUnique({
        where: { id: currentId },
        select: { parentTaskId: true },
      });
      if (!row?.parentTaskId) return depth;
      depth += 1;
      currentId = row.parentTaskId;
      if (depth > MAX_TASK_DEPTH + 5) return depth;
    }
  };

  const getTaskSubtreeHeight = async (
    tx: Pick<PrismaClient, 'task'> | Prisma.TransactionClient,
    taskId: string,
  ): Promise<number> => {
    const children = await tx.task.findMany({
      where: { parentTaskId: taskId, deletedAt: null },
      select: { id: true },
    });
    if (children.length === 0) return 1;
    let maxChildHeight = 0;
    for (const child of children) {
      const childHeight = await getTaskSubtreeHeight(tx, child.id);
      if (childHeight > maxChildHeight) maxChildHeight = childHeight;
    }
    return 1 + maxChildHeight;
  };

  const assertNotTaskCycle = async (
    tx: Pick<PrismaClient, 'task'> | Prisma.TransactionClient,
    taskId: string,
    parentTaskId: string,
  ): Promise<void> => {
    if (taskId === parentTaskId) {
      throw new AppError(400, 'TASK_SELF_PARENT', 'A task cannot be its own parent');
    }
    let currentId: string | null = parentTaskId;
    while (currentId) {
      if (currentId === taskId) {
        throw new AppError(
          400,
          'TASK_PARENT_CYCLE',
          'A task cannot be moved under itself or one of its descendants',
        );
      }
      const row: { parentTaskId: string | null } | null = await tx.task.findUnique({
        where: { id: currentId },
        select: { parentTaskId: true },
      });
      currentId = row?.parentTaskId ?? null;
    }
  };

  const assertTaskDepthWithinLimit = async (
    tx: Pick<PrismaClient, 'task'> | Prisma.TransactionClient,
    input: { parentTaskId?: string | null; subtreeHeight?: number },
  ): Promise<void> => {
    const parentDepth = input.parentTaskId ? await getTaskDepth(tx, input.parentTaskId) : 0;
    const newDepth = parentDepth + 1;
    const subtreeHeight = input.subtreeHeight ?? 1;
    if (newDepth > MAX_TASK_DEPTH || newDepth + subtreeHeight - 1 > MAX_TASK_DEPTH) {
      throw new AppError(
        400,
        'TASK_MAX_DEPTH_EXCEEDED',
        `Tasks cannot exceed a depth of ${MAX_TASK_DEPTH} levels`,
      );
    }
  };

  const assertTaskDependenciesSatisfied = async (
    tx: Pick<PrismaClient, 'taskDependency'> | Prisma.TransactionClient,
    taskId: string,
    targetStatus: TaskStatus,
  ): Promise<void> => {
    if (!['IN_PROGRESS', 'SUBMITTED', 'APPROVED'].includes(targetStatus)) return;
    const dependencies = await tx.taskDependency.findMany({
      where: { taskId },
      select: {
        dependsOnTaskId: true,
        dependsOnTask: {
          select: { id: true, status: true, deletedAt: true, archivedAt: true },
        },
      },
    });
    const blockingTaskIds = dependencies
      .filter((dep) => {
        const blocker = dep.dependsOnTask;
        if (!blocker) return false;
        if (blocker.deletedAt || blocker.archivedAt) return false;
        return blocker.status !== 'APPROVED';
      })
      .map((dep) => dep.dependsOnTaskId);
    if (blockingTaskIds.length > 0) {
      throw new AppError(
        409,
        'TASK_BLOCKED_BY_DEPENDENCIES',
        'This task is blocked by incomplete dependencies',
        { details: { blockingTaskIds } },
      );
    }
  };

  const assertAssignableProjectMember = async (input: {
    workspaceId: string;
    projectId: string;
    targetUserId: string;
  }): Promise<void> => {
    const membership = await prisma.workspaceMembership.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: input.workspaceId,
          userId: input.targetUserId,
        },
      },
      select: { status: true },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new AppError(
        403,
        'ASSIGNEE_NOT_PROJECT_MEMBER',
        'The selected user is not an eligible project member',
      );
    }

    try {
      await resolveProjectAuthorization(prisma, {
        userId: input.targetUserId,
        workspaceId: input.workspaceId,
        workspaceRole: 'MEMBER',
      }, input.projectId);
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'PROJECT_NOT_FOUND' ||
          error.code === 'PROJECT_ACCESS_DENIED' ||
          error.code === 'PERMISSION_DENIED' ||
          error.code === 'ORGANIZATION_ROLE_WORKSPACE_MISMATCH')
      ) {
        throw new AppError(
          403,
          'ASSIGNEE_NOT_PROJECT_MEMBER',
          'The selected user is not an eligible project member',
        );
      }
      throw error;
    }
  };

  const assertEligibleReviewer = async (input: {
    workspaceId: string;
    projectId: string;
    reviewerId: string;
    assigneeIds: readonly string[];
  }): Promise<void> => {
    const membership = await prisma.workspaceMembership.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: input.workspaceId,
          userId: input.reviewerId,
        },
      },
      select: { status: true },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      throw new AppError(403, 'REVIEWER_NOT_ELIGIBLE', 'The selected reviewer is not eligible');
    }

    let access;
    try {
      access = await resolveProjectAuthorization(prisma, {
        userId: input.reviewerId,
        workspaceId: input.workspaceId,
        workspaceRole: 'MEMBER',
      }, input.projectId);
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'PROJECT_NOT_FOUND' ||
          error.code === 'PROJECT_ACCESS_DENIED' ||
          error.code === 'PERMISSION_DENIED' ||
          error.code === 'ORGANIZATION_ROLE_WORKSPACE_MISMATCH')
      ) {
        throw new AppError(403, 'REVIEWER_NOT_ELIGIBLE', 'The selected reviewer is not eligible');
      }
      throw error;
    }

    const canReview =
      access.permissions.includes(ProjectPermission.SubmissionReview) ||
      access.permissions.includes(ProjectPermission.SubmissionApprove);
    if (!canReview) {
      throw new AppError(403, 'REVIEWER_NOT_ELIGIBLE', 'The selected reviewer is not eligible');
    }

    if (input.assigneeIds.includes(input.reviewerId)) {
      throw new AppError(
        409,
        'REVIEWER_CANNOT_BE_ASSIGNEE',
        'A reviewer cannot be an assignee of the same task',
      );
    }
  };

  const buildTaskUrl = (input: { projectId: string; taskId: string }): string | null => {
    if (!deps.config) return null;
    const path = deps.config.taskAssignmentLinkPath
      .replaceAll(':projectId', encodeURIComponent(input.projectId))
      .replaceAll(':taskId', encodeURIComponent(input.taskId));
    return `${deps.config.emailAppUrl.replace(/\/+$/, '')}${path}`;
  };

  const sendTaskSubmittedEmails = async (input: {
    workspaceId: string;
    workspaceName: string;
    projectId: string;
    projectName: string;
    taskId: string;
    taskTitle: string;
    submittedByName: string;
    submittedAt: Date;
    recipientIds: string[];
  }): Promise<void> => {
    if (!deps.config || input.recipientIds.length === 0) return;
    const brand = buildEmailBrand(deps.config);
    const taskUrl = buildTaskUrl({ projectId: input.projectId, taskId: input.taskId });
    if (!taskUrl) return;

    const recipients = await prisma.user.findMany({
      where: {
        id: { in: input.recipientIds },
        deletedAt: null,
        status: 'ACTIVE',
      },
      select: { id: true, name: true, email: true },
    });

    for (const recipient of recipients) {
      try {
        if (await isAddressSuppressed(prisma, recipient.email)) continue;
        const emailEnabled = await isEmailNotificationEnabled(prisma, {
          workspaceId: input.workspaceId,
          userId: recipient.id,
          type: 'TASK_SUBMITTED',
        });
        if (!emailEnabled) continue;

        const message = buildTaskSubmittedEmail({
          to: recipient.email,
          name: recipient.name,
          brand,
          taskTitle: input.taskTitle,
          projectName: input.projectName,
          submittedByName: input.submittedByName,
          taskUrl,
          idempotencyKey: `task-submitted:${input.taskId}:${recipient.id}:${input.submittedAt.toISOString()}`,
        });
        message.metadata = {
          ...message.metadata,
          taskId: input.taskId,
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          workspaceName: input.workspaceName,
        };
        const result = await sendEmail(message);
        if (!result.accepted) {
          defaultLogger.warn('task_submitted_email_failed', {
            taskId: input.taskId,
            recipientId: recipient.id,
            error: result.error ?? 'The email was not accepted',
          });
        }
      } catch (error) {
        defaultLogger.error('task_submitted_email_failed', {
          taskId: input.taskId,
          recipientId: recipient.id,
          error: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  };

  const notifyTaskSubmitted = async (input: {
    workspaceId: string;
    projectId: string;
    projectName: string;
    workspaceName: string;
    taskId: string;
    taskTitle: string;
    submittedById: string;
    submittedByName: string;
    submittedAt: Date;
    reviewerId: string | null;
  }): Promise<void> => {
    try {
      let recipientIds: string[] = [];
      if (input.reviewerId) {
        recipientIds = [input.reviewerId];
      } else {
        const approvers = await prisma.projectMembership.findMany({
          where: {
            projectId: input.projectId,
            role: 'PROJECT_MANAGER',
            user: {
              deletedAt: null,
              status: 'ACTIVE',
              workspaceMemberships: {
                some: { workspaceId: input.workspaceId, status: 'ACTIVE' },
              },
            },
          },
          select: { userId: true },
          take: 25,
        });
        recipientIds = Array.from(new Set(approvers.map((m) => m.userId)));
        if (recipientIds.length < 25) {
          const project = await prisma.project.findFirst({
            where: { id: input.projectId },
            select: { ownerId: true },
          });
          if (project?.ownerId && !recipientIds.includes(project.ownerId)) {
            const owner = await prisma.user.findFirst({
              where: {
                id: project.ownerId,
                deletedAt: null,
                status: 'ACTIVE',
                workspaceMemberships: { some: { workspaceId: input.workspaceId, status: 'ACTIVE' } },
              },
              select: { id: true },
            });
            if (owner) recipientIds.push(owner.id);
          }
        }
        recipientIds = Array.from(new Set(recipientIds)).slice(0, 25);
      }

      recipientIds = recipientIds.filter((id) => id !== input.submittedById);
      if (recipientIds.length === 0) return;

      await prisma.$transaction(async (tx) => {
        for (const recipientId of recipientIds) {
          await createNotification(tx, {
            userId: recipientId,
            type: 'TASK_SUBMITTED',
            title: 'Task submitted for review',
            data: {
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              taskId: input.taskId,
            },
          });
        }
      });

      await sendTaskSubmittedEmails({
        workspaceId: input.workspaceId,
        workspaceName: input.workspaceName,
        projectId: input.projectId,
        projectName: input.projectName,
        taskId: input.taskId,
        taskTitle: input.taskTitle,
        submittedByName: input.submittedByName,
        submittedAt: input.submittedAt,
        recipientIds,
      });
    } catch (error) {
      defaultLogger.error('task_submitted_notification_failed', {
        taskId: input.taskId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  };

  const resolveAssigneeTaskAction = async (input: {
    userId: string;
    workspaceId: string;
    projectId: string;
    taskId: string;
  }) => {
    const workspace = await requireWorkspaceAccess(prisma, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });
    const access = await authorizeProject(prisma, {
      actor: {
        userId: input.userId,
        workspaceId: input.workspaceId,
        workspaceRole: workspace.effectiveRole,
      },
      projectId: input.projectId,
      permission: ProjectPermission.TaskView,
      resource: { kind: 'task', taskId: input.taskId },
    });
    const task = await prisma.task.findFirst({
      where: { id: input.taskId, projectId: access.project.id, deletedAt: null },
      include: taskInclude,
    });
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
    const assignee = task.assignees.find((a) => a.userId === input.userId);
    if (!assignee) {
      throw new AppError(403, 'NOT_TASK_ASSIGNEE', 'Only an assignee can perform this action');
    }
    return { access, workspace, task, assignee };
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

      const now = new Date();
      const andFilters: Prisma.TaskWhereInput[] = [];
      if (input.assigneeId) {
        andFilters.push({ assignees: { some: { userId: input.assigneeId } } });
      }
      if (input.dueFrom || input.dueTo) {
        andFilters.push({
          dueDate: {
            ...(input.dueFrom ? { gte: new Date(input.dueFrom) } : {}),
            ...(input.dueTo ? { lte: new Date(input.dueTo) } : {}),
          },
        });
      }
      if (input.overdue === true) andFilters.push(taskOverdueWhere(now));
      if (input.overdue === false) andFilters.push(taskNotOverdueWhere(now));

      const rows = await prisma.task.findMany({
        where: {
          projectId: input.projectId,
          deletedAt: null,
          ...(access.projectRole === 'COLLABORATOR'
            ? { assignees: { some: { userId: input.userId } } }
            : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
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
          ...(andFilters.length ? { AND: andFilters } : {}),
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

    async listMine(input: Input & ListTasksQuery) {
      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const projects = await prisma.project.findMany({
        where: { workspaceId: input.workspaceId },
        select: { id: true },
      });
      const checks = await Promise.all(
        projects.map(async (project) => {
          try {
            await authorizeProject(prisma, {
              actor: {
                userId: input.userId,
                workspaceId: input.workspaceId,
                workspaceRole: workspace.effectiveRole,
              },
              projectId: project.id,
              permission: ProjectPermission.TaskView,
            });
            return project.id;
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            return null;
          }
        }),
      );
      const projectIds = checks.filter((id): id is string => id !== null);

      const now = new Date();
      const andFilters: Prisma.TaskWhereInput[] = [];
      if (input.dueFrom || input.dueTo) {
        andFilters.push({
          dueDate: {
            ...(input.dueFrom ? { gte: new Date(input.dueFrom) } : {}),
            ...(input.dueTo ? { lte: new Date(input.dueTo) } : {}),
          },
        });
      }
      if (input.overdue === true) andFilters.push(taskOverdueWhere(now));
      if (input.overdue === false) andFilters.push(taskNotOverdueWhere(now));

      const rows = await prisma.task.findMany({
        where: {
          projectId: { in: projectIds },
          deletedAt: null,
          assignees: { some: { userId: input.userId } },
          ...(input.status ? { status: input.status } : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...(!input.includeArchived ? { archivedAt: null } : {}),
          ...(andFilters.length ? { AND: andFilters } : {}),
        },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        take: input.limit + 1,
        include: { ...taskInclude, project: { select: { name: true, key: true } } },
      });

      const hasMore = rows.length > input.limit;
      const page = rows.slice(0, input.limit);
      const items = page.map((row) => ({
        ...toSummary(row),
        projectName: row.project.name,
        projectKeyLabel: row.project.key,
      }));
      return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
    },

    async create(
      input: Input & { projectId: string } & CreateTaskInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.TaskCreate);
      assertProjectWritable(access.project);
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

      const assigneeIds = Array.from(new Set(input.assigneeIds ?? []));
      for (const targetUserId of assigneeIds) {
        await assertAssignableProjectMember({
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          targetUserId,
        });
      }

      if (input.reviewerId !== undefined && input.reviewerId !== null) {
        if (!access.permissions.includes(ProjectPermission.TaskAssign)) {
          throw new AppError(
            403,
            'PERMISSION_DENIED',
            'Your project role does not allow assigning a reviewer',
            { requiredPermission: ProjectPermission.TaskAssign },
          );
        }
        await assertEligibleReviewer({
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          reviewerId: input.reviewerId,
          assigneeIds,
        });
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
          await assertTaskDepthWithinLimit(tx, {
            parentTaskId: input.parentTaskId,
            subtreeHeight: 1,
          });
        }

        if (input.milestoneId) {
          const milestone = await tx.projectMilestone.findFirst({
            where: { id: input.milestoneId, projectId: access.project.id },
            select: { id: true },
          });
          if (!milestone)
            throw new AppError(
              404,
              'PROJECT_MILESTONE_NOT_FOUND',
              'That project milestone does not exist',
            );
        }

        if (input.weight !== undefined && !input.parentTaskId) {
          throw new AppError(
            400,
            'INVALID_REQUEST',
            'Weight can only be set on subtasks',
          );
        }

        if (
          input.weight !== undefined &&
          !access.permissions.includes(ProjectPermission.TaskAssign)
        ) {
          throw new AppError(
            403,
            'PERMISSION_DENIED',
            'Your project role does not allow setting subtask weights',
            { requiredPermission: ProjectPermission.TaskAssign },
          );
        }

        let sprintIdToSet: string | null | undefined = undefined;
        let sprintPositionToSet: number | null | undefined = undefined;
        if (input.sprintId !== undefined) {
          if ((access.project as { workflowMode?: string }).workflowMode !== 'SPRINTS') {
            throw new AppError(409, 'SPRINTS_DISABLED_FOR_PROJECT', 'Sprints are disabled for this project.', {
              details: {
                projectId: access.project.id,
                workflowMode: (access.project as { workflowMode?: string }).workflowMode,
              },
            });
          }
          if (input.sprintId === null) {
            sprintIdToSet = null;
            sprintPositionToSet = null;
          } else {
            const sprint = await tx.sprint.findFirst({
              where: { id: input.sprintId, projectId: access.project.id },
              select: { id: true, status: true },
            });
            if (!sprint) {
              throw new AppError(404, 'SPRINT_NOT_FOUND', 'That sprint does not exist', {
                details: { sprintId: input.sprintId, projectId: access.project.id },
              });
            }
            if (sprint.status === 'COMPLETED' || sprint.status === 'ARCHIVED') {
              throw new AppError(422, 'SPRINT_NOT_ASSIGNABLE', 'Tasks cannot be assigned to a COMPLETED or ARCHIVED sprint.', {
                details: { sprintId: sprint.id, status: sprint.status },
              });
            }
            const maxPos = await tx.task.findFirst({
              where: { sprintId: sprint.id, deletedAt: null },
              orderBy: [{ sprintPosition: 'desc' }, { id: 'desc' }],
              select: { sprintPosition: true },
            });
            sprintIdToSet = sprint.id;
            sprintPositionToSet = (maxPos?.sprintPosition ?? 0) + 1;
          }
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
            ...(sprintIdToSet !== undefined ? { sprintId: sprintIdToSet } : {}),
            ...(sprintPositionToSet !== undefined ? { sprintPosition: sprintPositionToSet } : {}),
            parentTaskId: input.parentTaskId ?? null,
            ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
            ...(input.weight !== undefined ? { weight: input.weight } : {}),
            creatorId: input.userId,
            requiresApproval: input.requiresApproval ?? false,
            expectedDeliverables:
              input.expectedDeliverables === undefined
                ? undefined
                : input.expectedDeliverables === null
                  ? Prisma.JsonNull
                  : (input.expectedDeliverables as Prisma.InputJsonValue),
            ...(assigneeIds.length
              ? {
                  assignees: {
                    create: assigneeIds.map((userId) => ({
                      userId,
                      assignedBy: input.userId,
                      acceptanceStatus: 'PENDING',
                    })),
                  },
                }
              : {}),
            ...(input.reviewerId !== undefined ? { reviewerId: input.reviewerId } : {}),
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
        if (assigneeIds.length) {
          for (const assigneeId of assigneeIds) {
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
      for (const assigneeId of assigneeIds) {
        if (assigneeId !== input.userId) {
          emitDomainEvent('task.assigned', {
            workspaceId: input.workspaceId,
            projectId: access.project.id,
            taskId: created.id,
            assigneeId,
            actorId: input.userId,
          });
          await deps.slackNotifier?.taskAssigned({
            workspaceId: input.workspaceId,
            projectId: access.project.id,
            taskId: created.id,
            taskKey: created.key,
            taskTitle: created.title,
            status: created.status,
            assigneeId,
            assignedAt: created.createdAt.toISOString(),
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
      assertProjectWritable(access.project);
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
          reviewerId: true,
          startedAt: true,
          sprintId: true,
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

      if (
        input.weight !== undefined &&
        !access.permissions.includes(ProjectPermission.TaskAssign)
      ) {
        throw new AppError(
          403,
          'PERMISSION_DENIED',
          'Your project role does not allow changing subtask weights',
          { requiredPermission: ProjectPermission.TaskAssign },
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
      if (input.parentTaskId !== undefined && input.parentTaskId !== existing.parentTaskId) {
        if (input.parentTaskId) {
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
          await assertNotTaskCycle(prisma, existing.id, input.parentTaskId);
          const subtreeHeight = await getTaskSubtreeHeight(prisma, existing.id);
          await assertTaskDepthWithinLimit(prisma, {
            parentTaskId: input.parentTaskId,
            subtreeHeight,
          });
        } else {
          const subtreeHeight = await getTaskSubtreeHeight(prisma, existing.id);
          await assertTaskDepthWithinLimit(prisma, {
            parentTaskId: null,
            subtreeHeight,
          });
        }
      }

      if (input.milestoneId !== undefined && input.milestoneId) {
        const milestone = await prisma.projectMilestone.findFirst({
          where: { id: input.milestoneId, projectId: access.project.id },
          select: { id: true },
        });
        if (!milestone)
          throw new AppError(
            404,
            'PROJECT_MILESTONE_NOT_FOUND',
            'That project milestone does not exist',
          );
      }

      if (input.reviewerId !== undefined) {
        if (!access.permissions.includes(ProjectPermission.TaskAssign)) {
          throw new AppError(
            403,
            'PERMISSION_DENIED',
            'Your project role does not allow assigning a reviewer',
            { requiredPermission: ProjectPermission.TaskAssign },
          );
        }
        if (input.reviewerId === null) {
          // allowed: clear reviewer
        } else {
          await assertEligibleReviewer({
            workspaceId: input.workspaceId,
            projectId: access.project.id,
            reviewerId: input.reviewerId,
            assigneeIds: existing.assignees.map((a) => a.userId),
          });
        }
      }

      if (input.startDate !== undefined || input.dueDate !== undefined) {
        await assertDependencyDateConsistency(prisma, access.project.id, existing.id, {
          ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
          ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        });
      }

      if (input.status !== undefined && input.status !== existing.status) {
        assertTaskStatusTransition(existing.status, input.status, 'update');
        await assertTaskDependenciesSatisfied(prisma, existing.id, input.status);
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
        if (statusChanging && input.status === 'IN_PROGRESS' && !existing.startedAt) {
          submissionFields.startedAt = new Date();
        }

        let sprintData: { sprintId: string | null; sprintPosition?: number | null } | undefined;
        let backlogPositionAppend: number | undefined;
        if (input.sprintId !== undefined) {
          if ((access.project as { workflowMode?: string }).workflowMode !== 'SPRINTS') {
            throw new AppError(409, 'SPRINTS_DISABLED_FOR_PROJECT', 'Sprints are disabled for this project.', {
              details: {
                projectId: access.project.id,
                workflowMode: (access.project as { workflowMode?: string }).workflowMode,
              },
            });
          }
          if (input.sprintId === null) {
            if (existing.sprintId !== null) {
              const maxBacklogPosRow = await tx.task.findFirst({
                where: { projectId: access.project.id, deletedAt: null },
                orderBy: [{ position: 'desc' }, { id: 'desc' }],
                select: { position: true },
              });
              sprintData = { sprintId: null, sprintPosition: null };
              // Append to backlog when leaving sprint (decision 8 / R8 semantics)
              backlogPositionAppend = (maxBacklogPosRow?.position ?? 0) + 1;
            } else {
              sprintData = { sprintId: null, sprintPosition: null };
            }
          } else {
            const sprint = await tx.sprint.findFirst({
              where: { id: input.sprintId, projectId: access.project.id },
              select: { id: true, status: true },
            });
            if (!sprint) {
              throw new AppError(404, 'SPRINT_NOT_FOUND', 'That sprint does not exist', {
                details: { sprintId: input.sprintId, projectId: access.project.id },
              });
            }
            if (sprint.status === 'COMPLETED' || sprint.status === 'ARCHIVED') {
              throw new AppError(422, 'SPRINT_NOT_ASSIGNABLE', 'Tasks cannot be assigned to a COMPLETED or ARCHIVED sprint.', {
                details: { sprintId: sprint.id, status: sprint.status },
              });
            }
            if (existing.sprintId !== sprint.id) {
              const maxPos = await tx.task.findFirst({
                where: { sprintId: sprint.id, deletedAt: null },
                orderBy: [{ sprintPosition: 'desc' }, { id: 'desc' }],
                select: { sprintPosition: true },
              });
              sprintData = { sprintId: sprint.id, sprintPosition: (maxPos?.sprintPosition ?? 0) + 1 };
            } else {
              sprintData = { sprintId: sprint.id };
            }
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
            ...(sprintData
              ? {
                  sprintId: sprintData.sprintId,
                  ...(sprintData.sprintPosition !== undefined
                    ? { sprintPosition: sprintData.sprintPosition }
                    : {}),
                }
              : {}),
            ...(backlogPositionAppend !== undefined ? { position: backlogPositionAppend } : {}),
            ...(input.parentTaskId !== undefined
              ? { parentTaskId: input.parentTaskId }
              : {}),
            ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
            ...(input.weight !== undefined ? { weight: input.weight } : {}),
            ...(input.requiresApproval !== undefined
              ? { requiresApproval: input.requiresApproval }
              : {}),
            ...(input.reviewerId !== undefined ? { reviewerId: input.reviewerId } : {}),
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
      assertProjectWritable(access.project);
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
      assertProjectWritable(access.project);
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
      assertProjectWritable(access.project);
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
      assertProjectWritable(access.project);
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

      assertTaskStatusTransition(existing.status, 'APPROVED', 'complete');
      await assertTaskDependenciesSatisfied(prisma, existing.id, 'APPROVED');

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
      assertProjectWritable(access.project);
      const existing = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true, title: true, status: true, startedAt: true },
      });
      if (!existing) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      if (existing.status !== 'APPROVED')
        return { id: existing.id, status: existing.status as TaskStatus, completedAt: null };

      assertTaskStatusTransition(existing.status, 'IN_PROGRESS', 'reopen');
      await assertTaskDependenciesSatisfied(prisma, existing.id, 'IN_PROGRESS');

      const reopened = await prisma.$transaction(async (tx) => {
        const row = await tx.task.update({
          where: { id: existing.id },
          data: {
            status: 'IN_PROGRESS',
            completedAt: null,
            ...(existing.startedAt ? {} : { startedAt: new Date() }),
          },
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
      assertProjectWritable(access.project);
      const task = await prisma.task.findFirst({
        where: {
          id: input.taskId,
          projectId: access.project.id,
          deletedAt: null,
        },
        select: { id: true, key: true, title: true, status: true, reviewerId: true },
      });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      if (task.reviewerId && task.reviewerId === input.targetUserId) {
        throw new AppError(
          409,
          'REVIEWER_CANNOT_BE_ASSIGNEE',
          'A reviewer cannot be an assignee of the same task',
        );
      }

      await assertAssignableProjectMember({
        workspaceId: input.workspaceId,
        projectId: access.project.id,
        targetUserId: input.targetUserId,
      });

      const result = await prisma.$transaction(async (tx) => {
        const assignee = await tx.taskAssignee.upsert({
          where: {
            taskId_userId: { taskId: task.id, userId: input.targetUserId },
          },
          create: {
            taskId: task.id,
            userId: input.targetUserId,
            assignedBy: input.userId,
            acceptanceStatus: 'PENDING',
            acceptedAt: null,
            declinedAt: null,
            declineReason: null,
          },
          update: {
            assignedBy: input.userId,
            assignedAt: new Date(),
            acceptanceStatus: 'PENDING',
            acceptedAt: null,
            declinedAt: null,
            declineReason: null,
          },
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
          assignedBy: assignee.assignedBy,
          assignedAt: assignee.assignedAt,
          acceptanceStatus: assignee.acceptanceStatus,
          acceptedAt: assignee.acceptedAt,
          declinedAt: assignee.declinedAt,
          declineReason: assignee.declineReason,
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
        await deps.slackNotifier?.taskAssigned({
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          taskId: task.id,
          taskKey: task.key,
          taskTitle: task.title,
          status: task.status,
          assigneeId: input.targetUserId,
          assignedAt: result.assignedAt.toISOString(),
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
      assertProjectWritable(access.project);
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

        await cancelOpenClarificationForAssignee(tx, {
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          taskId: task.id,
          taskKey: task.key,
          assigneeUserId: input.targetUserId,
          actorId: input.userId,
          context,
        });

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
      assertProjectWritable(access.project);
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
          'DEPENDENCY_ALREADY_EXISTS',
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
      assertProjectWritable(access.project);
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
      assertProjectWritable(access.project);
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
      assertProjectWritable(access.project);
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
      assertProjectWritable(access.project);
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
          reviewer: taskSummary.reviewer
            ? { id: taskSummary.reviewer.id, name: taskSummary.reviewer.name }
            : null,
        },
        schedule: {
          startDate: taskSummary.startDate,
          dueDate: taskSummary.dueDate,
          overdue: isTaskOverdue(task),
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

    async addProgressUpdate(
      input: Input & { projectId: string; taskId: string } & AddProgressUpdateInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.TaskView, {
        kind: 'task',
        taskId: input.taskId,
      });
      assertProjectWritable(access.project);

      const existing = await prisma.task.findFirst({
        where: { id: input.taskId, projectId: access.project.id, deletedAt: null },
        include: { assignees: { select: { userId: true } } },
      });
      if (!existing) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      if (existing.archivedAt !== null || existing.deletedAt !== null) {
        throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      }

      if (!['IN_PROGRESS', 'CHANGES_REQUESTED'].includes(existing.status)) {
        throw new AppError(
          409,
          'PROGRESS_UPDATE_NOT_ALLOWED',
          'Progress updates can only be posted while the task is in progress or changes requested',
        );
      }

      const isAssignee = existing.assignees.some((a) => a.userId === input.userId);
      if (!isAssignee) {
        throw new AppError(403, 'NOT_TASK_ASSIGNEE', 'Only a task assignee can post a progress update', {
          requiredPermission: ProjectPermission.TaskView,
        });
      }

      const existingUpdate = input.clientRequestId
        ? await prisma.taskProgressUpdate.findFirst({
            where: {
              taskId: input.taskId,
              authorId: input.userId,
              clientRequestId: input.clientRequestId,
            },
          })
        : null;

      if (existingUpdate) {
        return { update: existingUpdate, created: false };
      }

      const update = await prisma.taskProgressUpdate.create({
        data: {
          taskId: input.taskId,
          authorId: input.userId,
          note: input.note.trim(),
          percent: input.percent ?? null,
          clientRequestId: input.clientRequestId ?? null,
        },
      });

      await recordAuditEvent(prisma, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: TaskAuditAction.TaskProgressUpdated,
        targetType: 'TaskProgressUpdate',
        targetId: update.id,
        metadata: { taskId: input.taskId, projectId: access.project.id, percent: update.percent },
        ...context,
      });

      return { update, created: true };
    },

    async listProgressUpdates(
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

      let cursorFilter: Prisma.TaskProgressUpdateWhereInput | undefined;
      if (input.cursor) {
        const cursorRow = await prisma.taskProgressUpdate.findUnique({
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

      const rows = await prisma.taskProgressUpdate.findMany({
        where: {
          AND: [{ taskId: input.taskId }, ...(cursorFilter ? [cursorFilter] : [])],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          taskId: true,
          authorId: true,
          note: true,
          percent: true,
          clientRequestId: true,
          createdAt: true,
        },
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
      assertProjectWritable(access.project);
      const existing = await prisma.task.findFirst({
        where: { id: input.taskId, projectId: access.project.id, deletedAt: null },
        include: taskInclude,
      });
      if (!existing) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      if (!['ASSIGNED', 'IN_PROGRESS', 'CHANGES_REQUESTED', 'SUBMITTED', 'UNDER_REVIEW'].includes(existing.status)) {
        throw new AppError(409, 'TASK_SUBMIT_NOT_ALLOWED', 'This task cannot be submitted in its current state');
      }
      assertTaskStatusTransition(existing.status, 'SUBMITTED', 'submit');
      await assertTaskDependenciesSatisfied(prisma, existing.id, 'SUBMITTED');
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

      const [submitter, projectWithWorkspace] = await Promise.all([
        prisma.user.findUnique({ where: { id: input.userId }, select: { name: true } }),
        prisma.project.findUnique({
          where: { id: access.project.id },
          select: { name: true, workspace: { select: { name: true } } },
        }),
      ]);
      await notifyTaskSubmitted({
        workspaceId: input.workspaceId,
        projectId: access.project.id,
        projectName: projectWithWorkspace?.name ?? access.project.name ?? 'Project',
        workspaceName: projectWithWorkspace?.workspace.name ?? '',
        taskId: row.id,
        taskTitle: row.title,
        submittedById: input.userId,
        submittedByName: submitter?.name ?? 'A member',
        submittedAt: row.submittedAt ?? new Date(),
        reviewerId: row.reviewerId ?? existing.reviewerId ?? null,
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
      assertProjectWritable(access.project);
      const existing = await prisma.task.findFirst({
        where: { id: input.taskId, projectId: access.project.id, deletedAt: null },
        include: taskInclude,
      });
      if (!existing) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      if (existing.reviewerId && existing.reviewerId !== input.userId) {
        const isProjectOwner = access.project.ownerId === input.userId;
        const isProjectManager = access.projectRole === 'PROJECT_MANAGER';
        if (!isProjectOwner && !isProjectManager) {
          throw new AppError(
            403,
            'REVIEWER_ONLY',
            'Only the assigned reviewer or a project manager may review this task',
            { details: { reviewerId: existing.reviewerId } },
          );
        }
      }

      const isSubmitter = existing.submittedById === input.userId || existing.assignees.some((a) => a.userId === input.userId);
      if (isSubmitter && input.decision !== 'START_REVIEW') {
        throw new AppError(403, 'SELF_REVIEW_NOT_ALLOWED', 'You cannot review your own submission');
      }

      let nextStatus: TaskStatus;
      if (input.decision === 'START_REVIEW') nextStatus = 'UNDER_REVIEW';
      else if (input.decision === 'APPROVE') nextStatus = 'APPROVED';
      else nextStatus = 'CHANGES_REQUESTED';

      assertTaskStatusTransition(existing.status, nextStatus, 'review');
      await assertTaskDependenciesSatisfied(prisma, existing.id, nextStatus);

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

    async acceptTask(
      input: Input & { projectId: string; taskId: string },
      context: RequestContext,
    ) {
      const { access, task, assignee } = await resolveAssigneeTaskAction({
        userId: input.userId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        taskId: input.taskId,
      });
      assertProjectWritable(access.project);

      if (task.status === 'AWAITING_CLARIFICATION') {
        throw new AppError(
          409,
          'INVALID_ACCEPTANCE_STATE',
          'Accept an assignment only after its clarification is resolved',
          { details: { status: task.status } },
        );
      }

      if (assignee.acceptanceStatus !== 'PENDING') {
        throw new AppError(
          409,
          'INVALID_ACCEPTANCE_STATE',
          'This assignment cannot be accepted in its current state',
          { details: { acceptanceStatus: assignee.acceptanceStatus } },
        );
      }

      const updatedAssignee = await prisma.$transaction(async (tx) => {
        const row = await tx.taskAssignee.update({
          where: { id: assignee.id },
          data: {
            acceptanceStatus: 'ACCEPTED',
            acceptedAt: new Date(),
            declinedAt: null,
            declineReason: null,
          },
          include: { user: { select: { id: true, name: true, email: true } } },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.assignee_accepted',
          targetType: 'TaskAssignee',
          targetId: row.userId,
          metadata: {
            taskId: task.id,
            taskKey: task.key,
            projectId: access.project.id,
            acceptanceStatus: row.acceptanceStatus,
          },
          ...context,
        });
        return row;
      });

      const refreshed = await prisma.task.findFirst({
        where: { id: task.id, projectId: access.project.id, deletedAt: null },
        include: taskInclude,
      });
      if (!refreshed) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      return {
        task: toSummary(refreshed),
        assignee: {
          taskId: task.id,
          userId: updatedAssignee.userId,
          user: updatedAssignee.user,
          assignedBy: updatedAssignee.assignedBy,
          assignedAt: updatedAssignee.assignedAt,
          acceptanceStatus: updatedAssignee.acceptanceStatus,
          acceptedAt: updatedAssignee.acceptedAt,
          declinedAt: updatedAssignee.declinedAt,
          declineReason: updatedAssignee.declineReason,
        },
      };
    },

    async declineTask(
      input: Input & { projectId: string; taskId: string; reason: string },
      context: RequestContext,
    ) {
      const { access, task, assignee } = await resolveAssigneeTaskAction({
        userId: input.userId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        taskId: input.taskId,
      });
      assertProjectWritable(access.project);

      if (assignee.acceptanceStatus !== 'PENDING') {
        throw new AppError(
          409,
          'INVALID_ACCEPTANCE_STATE',
          'This assignment cannot be declined in its current state',
          { details: { acceptanceStatus: assignee.acceptanceStatus } },
        );
      }

      const reason = input.reason.trim();
      if (reason.length < 3) {
        throw new AppError(400, 'INVALID_DECLINE_REASON', 'A decline reason of at least 3 characters is required');
      }

      const declinedAssignee = await prisma.$transaction(async (tx) => {
        const row = await tx.taskAssignee.update({
          where: { id: assignee.id },
          data: {
            acceptanceStatus: 'DECLINED',
            declinedAt: new Date(),
            acceptedAt: null,
            declineReason: reason,
          },
          include: { user: { select: { id: true, name: true, email: true } } },
        });
        await cancelOpenClarificationForAssignee(tx, {
          workspaceId: input.workspaceId,
          projectId: access.project.id,
          taskId: task.id,
          taskKey: task.key,
          assigneeUserId: input.userId,
          actorId: input.userId,
          reason,
          context,
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.assignee_declined',
          targetType: 'TaskAssignee',
          targetId: row.userId,
          metadata: {
            taskId: task.id,
            taskKey: task.key,
            projectId: access.project.id,
            acceptanceStatus: row.acceptanceStatus,
            reason,
          },
          ...context,
        });
        if (task.creatorId && task.creatorId !== input.userId) {
          await createNotification(tx, {
            userId: task.creatorId,
            type: 'TASK_DECLINED',
            title: 'Task assignment declined',
            data: {
              workspaceId: input.workspaceId,
              projectId: access.project.id,
              taskId: task.id,
              reason,
            },
          });
        }
        return row;
      });

      const refreshed = await prisma.task.findFirst({
        where: { id: task.id, projectId: access.project.id, deletedAt: null },
        include: taskInclude,
      });
      if (!refreshed) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      return {
        task: toSummary(refreshed),
        assignee: {
          taskId: task.id,
          userId: declinedAssignee.userId,
          user: declinedAssignee.user,
          assignedBy: declinedAssignee.assignedBy,
          assignedAt: declinedAssignee.assignedAt,
          acceptanceStatus: declinedAssignee.acceptanceStatus,
          acceptedAt: declinedAssignee.acceptedAt,
          declinedAt: declinedAssignee.declinedAt,
          declineReason: declinedAssignee.declineReason,
        },
      };
    },

    async startTask(
      input: Input & { projectId: string; taskId: string },
      context: RequestContext,
    ) {
      const { access, task, assignee } = await resolveAssigneeTaskAction({
        userId: input.userId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        taskId: input.taskId,
      });
      assertProjectWritable(access.project);

      if (task.status !== 'ASSIGNED') {
        throw new AppError(
          409,
          'INVALID_STATUS_TRANSITION',
          `Cannot transition task from ${task.status} to IN_PROGRESS`,
          { details: { from: task.status, to: 'IN_PROGRESS' } },
        );
      }
      assertTaskStatusTransition(task.status, 'IN_PROGRESS', 'start');
      await assertTaskDependenciesSatisfied(prisma, task.id, 'IN_PROGRESS');

      const now = new Date();
      const result = await prisma.$transaction(async (tx) => {
        const updatedTask = await tx.task.update({
          where: { id: task.id },
          data: {
            status: 'IN_PROGRESS',
            ...(task.startedAt ? {} : { startedAt: now }),
          },
          include: taskInclude,
        });

        const implicitlyAccepted = assignee.acceptanceStatus !== 'ACCEPTED';
        const updatedAssignee = await tx.taskAssignee.update({
          where: { id: assignee.id },
          data: {
            acceptanceStatus: 'ACCEPTED',
            acceptedAt: assignee.acceptedAt ?? now,
            declinedAt: null,
            declineReason: null,
          },
          include: { user: { select: { id: true, name: true, email: true } } },
        });

        if (implicitlyAccepted) {
          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: 'task.assignee_accepted',
            targetType: 'TaskAssignee',
            targetId: updatedAssignee.userId,
            metadata: {
              taskId: task.id,
              taskKey: task.key,
              projectId: access.project.id,
              acceptanceStatus: updatedAssignee.acceptanceStatus,
              implicit: true,
            },
            ...context,
          });
        }

        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.started',
          targetType: 'Task',
          targetId: updatedTask.id,
          metadata: {
            taskId: task.id,
            taskKey: task.key,
            projectId: access.project.id,
            previousStatus: task.status,
            status: updatedTask.status,
            startedAt: updatedTask.startedAt,
          },
          ...context,
        });

        return { task: toSummary(updatedTask), assignee: updatedAssignee };
      });

      if (task.status !== result.task.status) {
        await enqueueAutomationRunsSafely({
          workspaceId: input.workspaceId,
          trigger: 'EVENT_TASK_STATUS_CHANGED' as never,
          eventKey: `task.status_changed:${result.task.id}:${result.task.updatedAt}`,
          payload: {
            workspaceId: input.workspaceId,
            projectId: access.project.id,
            taskId: result.task.id,
            key: result.task.key,
            title: result.task.title,
            previousStatus: task.status,
            status: result.task.status,
            actorId: input.userId,
          },
        });
      }

      return {
        task: result.task,
        assignee: {
          taskId: task.id,
          userId: result.assignee.userId,
          user: result.assignee.user,
          assignedBy: result.assignee.assignedBy,
          assignedAt: result.assignee.assignedAt,
          acceptanceStatus: result.assignee.acceptanceStatus,
          acceptedAt: result.assignee.acceptedAt,
          declinedAt: result.assignee.declinedAt,
          declineReason: result.assignee.declineReason,
        },
      };
    },

    async completeSubtask(
      input: Input & { projectId: string; taskId: string; subtaskId: string } & CompleteSubtaskInput,
      context: RequestContext,
    ) {
      const access = await authorize(input, ProjectPermission.TaskComplete, {
        kind: 'task',
        taskId: input.subtaskId,
      });
      assertProjectWritable(access.project);
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
      if (subtask.status === 'AWAITING_CLARIFICATION') {
        throw new AppError(
          409,
          'INVALID_CLARIFICATION_STATE',
          'A subtask awaiting clarification cannot be completed',
          { details: { status: subtask.status } },
        );
      }

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
          select: { status: true, weight: true },
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
