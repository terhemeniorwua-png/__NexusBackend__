import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import {
  ProjectPermission,
  authorizeProject,
  requireWorkspaceAccess,
  WorkspaceCapability,
  type ProjectAuthorization,
} from '../authorization';
import type { RequestContext } from '../auth/auth.types';
import { assertProjectWritable } from '../projects/project-archive';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { assertTaskStatusTransition } from './task-status';
import { notifyClarificationAnswered, notifyClarificationRequested } from './task-clarification.notifications';
import type {
  AskClarificationInput,
  AnswerClarificationInput,
  ListClarificationsQuery,
} from './task-clarification.schemas';

type Client = PrismaClient | Prisma.TransactionClient;
type Input = { userId: string; workspaceId: string };

const clarificationInclude = {
  askedBy: { select: { id: true, name: true } },
  answeredBy: { select: { id: true, name: true } },
} as const;

const taskResponseInclude = {
  creator: { select: { id: true, name: true } },
  reviewer: { select: { id: true, name: true } },
  assignees: {
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { assignedAt: 'asc' as const },
  },
} as const;

type ClarificationRow = Prisma.TaskClarificationGetPayload<{
  include: typeof clarificationInclude;
}>;

interface ClarificationTaskContext {
  workspaceId: string;
  projectId: string;
  taskId: string;
  taskKey: string;
  creatorId: string | null;
  reviewerId: string | null;
  askerId: string;
  round: number;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function invalidState(message: string, details?: Record<string, unknown>): AppError {
  return new AppError(409, 'INVALID_CLARIFICATION_STATE', message, { details });
}

/** A clarification answer is limited to the task owner, reviewer and managers. */
function canAnswerClarification(
  access: ProjectAuthorization,
  task: { creatorId: string | null; reviewerId: string | null },
  userId: string,
): boolean {
  if (task.creatorId === userId) return true;
  if (task.reviewerId === userId) return true;
  return access.isWorkspaceAdmin || access.projectRole === 'PROJECT_MANAGER';
}

async function loadTaskResponse(client: Client, taskId: string) {
  const task = await client.task.findFirst({
    where: { id: taskId, deletedAt: null },
    include: taskResponseInclude,
  });
  if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
  return task;
}

/**
 * Cancels the asker's only open clarification when they decline or are removed
 * as an assignee. The clarification timestamp, task status reset and audit row
 * are all written through the caller's transaction client.
 */
export async function cancelOpenClarificationForAssignee(
  client: Client,
  input: {
    workspaceId: string;
    projectId: string;
    taskId: string;
    taskKey: string;
    assigneeUserId: string;
    actorId: string;
    reason?: string;
    context: RequestContext;
  },
): Promise<{ cancelled: boolean; clarificationId: string | null }> {
  const open = await client.taskClarification.findFirst({
    where: {
      taskId: input.taskId,
      askedById: input.assigneeUserId,
      answeredAt: null,
      cancelledAt: null,
    },
    select: { id: true, round: true },
  });
  if (!open) return { cancelled: false, clarificationId: null };

  assertTaskStatusTransition('AWAITING_CLARIFICATION', 'ASSIGNED', 'clarification_cancel');
  const claimedTask = await client.task.updateMany({
    where: { id: input.taskId, status: 'AWAITING_CLARIFICATION', deletedAt: null },
    data: { status: 'ASSIGNED' },
  });
  if (claimedTask.count !== 1) {
    throw invalidState('The clarification is no longer waiting', { taskId: input.taskId });
  }

  const cancelled = await client.taskClarification.updateMany({
    where: { id: open.id, answeredAt: null, cancelledAt: null },
    data: { cancelledAt: new Date() },
  });
  if (cancelled.count !== 1) {
    throw invalidState('The clarification is no longer open', { clarificationId: open.id });
  }

  await recordAuditEvent(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: 'task.clarification_cancelled',
    targetType: 'TaskClarification',
    targetId: open.id,
    metadata: {
      taskId: input.taskId,
      taskKey: input.taskKey,
      projectId: input.projectId,
      round: open.round,
      ...(input.reason ? { reason: input.reason } : {}),
    },
    ...input.context,
  });

  return { cancelled: true, clarificationId: open.id };
}

export function createTaskClarificationService(
  prisma: PrismaClient = getPrismaClient(),
) {
  const resolveAccess = async (
    input: Input & { projectId: string; taskId: string },
  ): Promise<ProjectAuthorization> => {
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
      permission: ProjectPermission.TaskView,
      resource: { kind: 'task', taskId: input.taskId },
    });
  };

  const loadWaitingTask = async (
    input: Input & { projectId: string; taskId: string },
  ) => {
    const task = await prisma.task.findFirst({
      where: {
        id: input.taskId,
        projectId: input.projectId,
        deletedAt: null,
      },
      select: {
        id: true,
        projectId: true,
        key: true,
        status: true,
        creatorId: true,
        reviewerId: true,
      },
    });
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
    return task;
  };

  const taskNotificationContext = (
    task: { id: string; projectId: string; key: string; creatorId: string | null; reviewerId: string | null },
    input: Input,
    askerId: string,
    round: number,
  ): ClarificationTaskContext => ({
    workspaceId: input.workspaceId,
    projectId: task.projectId,
    taskId: task.id,
    taskKey: task.key,
    creatorId: task.creatorId,
    reviewerId: task.reviewerId,
    askerId,
    round,
  });

  return {
    async ask(
      input: Input & { projectId: string; taskId: string } & AskClarificationInput,
      context: RequestContext,
    ): Promise<{ clarification: ClarificationRow; task: Awaited<ReturnType<typeof loadTaskResponse>> }> {
      const access = await resolveAccess(input);
      assertProjectWritable(access.project);

      const task = await loadWaitingTask(input);
      if (task.status !== 'ASSIGNED') {
        throw invalidState('Clarification can only be requested from ASSIGNED', {
          status: task.status,
        });
      }

      const assignee = await prisma.taskAssignee.findUnique({
        where: { taskId_userId: { taskId: task.id, userId: input.userId } },
        select: { id: true, acceptanceStatus: true },
      });
      if (!assignee) {
        throw new AppError(403, 'NOT_TASK_ASSIGNEE', 'Only an assignee can request clarification');
      }
      if (assignee.acceptanceStatus !== 'PENDING') {
        throw new AppError(
          409,
          'INVALID_ACCEPTANCE_STATE',
          'Only a pending assignee can request clarification',
          { details: { acceptanceStatus: assignee.acceptanceStatus } },
        );
      }

      const question = input.question.trim();
      assertTaskStatusTransition('ASSIGNED', 'AWAITING_CLARIFICATION', 'clarification_request');

      return prisma.$transaction(async (tx) => {
        const claimed = await tx.task.updateMany({
          where: { id: task.id, status: 'ASSIGNED', deletedAt: null },
          data: { status: 'AWAITING_CLARIFICATION' },
        });
        if (claimed.count !== 1) {
          throw invalidState('The task is no longer assigned', { taskId: task.id });
        }

        const previous = await tx.taskClarification.findFirst({
          where: { taskId: task.id },
          select: { round: true },
          orderBy: { round: 'desc' },
        });
        const round = (previous?.round ?? 0) + 1;

        let clarification: ClarificationRow;
        try {
          clarification = await tx.taskClarification.create({
            data: {
              taskId: task.id,
              round,
              question,
              askedById: input.userId,
            },
            include: clarificationInclude,
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw invalidState('A clarification is already open for this task', {
              taskId: task.id,
            });
          }
          throw error;
        }

        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.clarification_requested',
          targetType: 'TaskClarification',
          targetId: clarification.id,
          metadata: {
            taskId: task.id,
            taskKey: task.key,
            projectId: task.projectId,
            round,
            question,
          },
          ...context,
        });

        await notifyClarificationRequested(tx, {
          ...taskNotificationContext(task, input, input.userId, round),
          clarificationId: clarification.id,
          question,
        });

        return {
          clarification,
          task: await loadTaskResponse(tx, task.id),
        };
      });
    },

    async list(
      input: Input & { projectId: string; taskId: string } & ListClarificationsQuery,
    ) {
      const access = await resolveAccess(input);
      const task = await prisma.task.findFirst({
        where: { id: input.taskId, projectId: access.project.id, deletedAt: null },
        select: { id: true },
      });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');

      let cursor: { id: string; askedAt: Date } | null = null;
      if (input.cursor) {
        cursor = await prisma.taskClarification.findFirst({
          where: { id: input.cursor, taskId: task.id },
          select: { id: true, askedAt: true },
        });
        if (!cursor) {
          throw new AppError(400, 'INVALID_CURSOR', 'That clarification cursor is invalid', {
            details: { cursor: input.cursor },
          });
        }
      }

      const rows = await prisma.taskClarification.findMany({
        where: {
          taskId: task.id,
          ...(cursor
            ? {
                OR: [
                  { askedAt: { lt: cursor.askedAt } },
                  { askedAt: cursor.askedAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ askedAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        include: clarificationInclude,
      });

      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit);
      return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
    },

    async answer(
      input: Input & { projectId: string; taskId: string; clarificationId: string } & AnswerClarificationInput,
      context: RequestContext,
    ): Promise<{ clarification: ClarificationRow; task: Awaited<ReturnType<typeof loadTaskResponse>> }> {
      const access = await resolveAccess(input);
      assertProjectWritable(access.project);

      const clarification = await prisma.taskClarification.findFirst({
        where: { id: input.clarificationId, taskId: input.taskId },
      });
      if (!clarification) {
        throw new AppError(404, 'CLARIFICATION_NOT_FOUND', 'That clarification does not exist');
      }
      if (clarification.answeredAt || clarification.cancelledAt) {
        throw invalidState('That clarification is already resolved', {
          clarificationId: clarification.id,
        });
      }

      const task = await loadWaitingTask(input);
      if (task.status !== 'AWAITING_CLARIFICATION') {
        throw invalidState('The task is not awaiting clarification', { status: task.status });
      }
      if (clarification.askedById === input.userId) {
        throw new AppError(
          403,
          'SELF_CLARIFICATION_FORBIDDEN',
          'The asker cannot answer their own clarification',
        );
      }
      if (!canAnswerClarification(access, task, input.userId)) {
        throw new AppError(403, 'PERMISSION_DENIED', 'You cannot answer this clarification', {
          requiredPermission: ProjectPermission.TaskUpdate,
        });
      }

      const answer = input.answer.trim();
      assertTaskStatusTransition(task.status, 'ASSIGNED', 'clarification_answer');
      const now = new Date();

      return prisma.$transaction(async (tx) => {
        const claimedClarification = await tx.taskClarification.updateMany({
          where: { id: clarification.id, answeredAt: null, cancelledAt: null },
          data: { answer, answeredById: input.userId, answeredAt: now },
        });
        if (claimedClarification.count !== 1) {
          throw invalidState('That clarification is already resolved', {
            clarificationId: clarification.id,
          });
        }

        const claimedTask = await tx.task.updateMany({
          where: { id: task.id, status: 'AWAITING_CLARIFICATION', deletedAt: null },
          data: { status: 'ASSIGNED' },
        });
        if (claimedTask.count !== 1) {
          throw invalidState('The task is no longer awaiting clarification', { taskId: task.id });
        }

        const askerAssignment = await tx.taskAssignee.findFirst({
          where: { taskId: task.id, userId: clarification.askedById },
          select: { acceptanceStatus: true },
        });

        const updated = await tx.taskClarification.findUniqueOrThrow({
          where: { id: clarification.id },
          include: clarificationInclude,
        });

        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.clarification_answered',
          targetType: 'TaskClarification',
          targetId: clarification.id,
          metadata: {
            taskId: task.id,
            taskKey: task.key,
            projectId: task.projectId,
            round: clarification.round,
            answer,
            askedById: clarification.askedById,
          },
          ...context,
        });

        if (askerAssignment && askerAssignment.acceptanceStatus !== 'DECLINED') {
          await notifyClarificationAnswered(tx, {
            ...taskNotificationContext(task, input, clarification.askedById, clarification.round),
            clarificationId: clarification.id,
            actorId: input.userId,
            answer,
          });
        }

        return {
          clarification: updated,
          task: await loadTaskResponse(tx, task.id),
        };
      });
    },
  };
}
