import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import { recordAuditEvent } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import type { RequestContext } from '../auth/auth.types';
import {
  ProjectPermission,
  WorkspaceCapability,
  authorizeProject,
  requireWorkspaceAccess,
} from '../authorization';
import type { ProjectAuthorizationResource, ProjectPermissionValue } from '../authorization';

type Input = { userId: string; workspaceId: string; projectId: string; taskId: string };

const blockerInclude = {
  reportedBy: { select: { id: true, name: true } },
  notifyUser: { select: { id: true, name: true } },
  resolvedBy: { select: { id: true, name: true } },
} as const;

function toBlockerSummary(b: {
  id: string;
  taskId: string;
  status: 'OPEN' | 'RESOLVED';
  description: string;
  reportedById: string;
  notifyUserId: string | null;
  resolvedAt: Date | null;
  resolvedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  reportedBy: { id: string; name: string };
  notifyUser: { id: string; name: string } | null;
  resolvedBy: { id: string; name: string } | null;
}) {
  return {
    id: b.id,
    taskId: b.taskId,
    status: b.status,
    description: b.description,
    reportedById: b.reportedById,
    reportedBy: b.reportedBy,
    notifyUserId: b.notifyUserId,
    notifyUser: b.notifyUser,
    resolvedAt: b.resolvedAt,
    resolvedById: b.resolvedById,
    resolvedBy: b.resolvedBy,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

export function createTaskBlockerService(prisma: PrismaClient = getPrismaClient()) {
  const authorize = async (
    input: Input,
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

  async function ensureTask(input: Input) {
    const access = await authorize(input, ProjectPermission.TaskView, {
      kind: 'task',
      taskId: input.taskId,
    });
    const task = await prisma.task.findFirst({
      where: { id: input.taskId, projectId: access.project.id, deletedAt: null },
      select: { id: true, key: true, title: true, creatorId: true, projectId: true },
    });
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
    return { access, task };
  }

  return {
    async list(input: Input) {
      await ensureTask(input);
      const items = await prisma.taskBlocker.findMany({
        where: { taskId: input.taskId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: blockerInclude,
      });
      const summaries = items.map(toBlockerSummary);
      return { items: summaries, hasOpenBlocker: summaries.some((b) => b.status === 'OPEN') };
    },

    async report(
      input: Input & { description: string; notifyUserId?: string | null },
      context: RequestContext,
    ) {
      const { task } = await ensureTask(input);
      const assignee = await prisma.taskAssignee.findFirst({
        where: { taskId: input.taskId, userId: input.userId },
        select: { id: true },
      });
      if (!assignee) {
        throw new AppError(403, 'PERMISSION_DENIED', 'Only an assigned member can report a blocker for this task');
      }

      let notifyUserId: string | null = null;
      if (input.notifyUserId) {
        if (input.notifyUserId === input.userId) {
          // allow but no need to duplicate notification to reporter
        }
        const member = await prisma.workspaceMembership.findFirst({
          where: { workspaceId: input.workspaceId, userId: input.notifyUserId, status: 'ACTIVE' },
          select: { userId: true },
        });
        if (!member) {
          throw new AppError(404, 'USER_NOT_FOUND', 'The selected user to notify was not found in this workspace');
        }
        notifyUserId = member.userId;
      }

      const created = await prisma.$transaction(async (tx) => {
        const blocker = await tx.taskBlocker.create({
          data: {
            taskId: input.taskId,
            description: input.description.trim(),
            reportedById: input.userId,
            status: 'OPEN',
            ...(notifyUserId ? { notifyUserId } : {}),
          },
          include: blockerInclude,
        });

        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.blocker.reported',
          targetType: 'TaskBlocker',
          targetId: blocker.id,
          metadata: { taskId: input.taskId, projectId: input.projectId, notifyUserId },
          ...context,
        });

        const recipients = new Set<string>();
        recipients.add(task.creatorId); // task owner
        if (notifyUserId) recipients.add(notifyUserId);
        recipients.delete(input.userId); // avoid notifying reporter of their own report

        const title = `Blocker reported: ${task.title}`;
        const body = input.description.trim().slice(0, 300);
        const link = `/app/projects/${input.projectId}/tasks/${input.taskId}/work?section=overview`;
        for (const userId of recipients) {
          await createNotification(tx, {
            userId,
            type: 'TASK_BLOCKER_REPORTED',
            title,
            body,
            link,
            data: { workspaceId: input.workspaceId, projectId: input.projectId, taskId: input.taskId, blockerId: blocker.id },
          });
        }

        return blocker;
      });

      return toBlockerSummary(created);
    },

    async resolve(input: Input & { blockerId: string }, context: RequestContext) {
      const { access, task } = await ensureTask(input);
      const blocker = await prisma.taskBlocker.findFirst({
        where: { id: input.blockerId, taskId: input.taskId },
        include: blockerInclude,
      });
      if (!blocker) throw new AppError(404, 'TASK_BLOCKER_NOT_FOUND', 'That blocker does not exist');

      if (blocker.status === 'RESOLVED') {
        return toBlockerSummary(blocker);
      }

      const isReporter = blocker.reportedById === input.userId;
      const isTaskOwner = task.creatorId === input.userId;
      const isPmOrAdmin =
        access.isWorkspaceAdmin ||
        access.permissions.includes(ProjectPermission.TaskAssign) ||
        access.permissions.includes(ProjectPermission.ManageMembers);
      if (!isReporter && !isTaskOwner && !isPmOrAdmin) {
        throw new AppError(403, 'PERMISSION_DENIED', 'You do not have permission to resolve this blocker');
      }

      const resolved = await prisma.$transaction(async (tx) => {
        const updated = await tx.taskBlocker.update({
          where: { id: blocker.id },
          data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedById: input.userId },
          include: blockerInclude,
        });

        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.blocker.resolved',
          targetType: 'TaskBlocker',
          targetId: updated.id,
          metadata: { taskId: input.taskId, projectId: input.projectId, reportedById: updated.reportedById },
          ...context,
        });

        if (updated.reportedById !== input.userId) {
          await createNotification(tx, {
            userId: updated.reportedById,
            type: 'TASK_BLOCKER_RESOLVED',
            title: `Blocker resolved: ${task.title}`,
            body: updated.description.slice(0, 300),
            link: `/app/projects/${input.projectId}/tasks/${input.taskId}/work?section=overview`,
            data: { workspaceId: input.workspaceId, projectId: input.projectId, taskId: input.taskId, blockerId: updated.id },
          });
        }

        return updated;
      });

      return toBlockerSummary(resolved);
    },
  };
}
