import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import { recordAuditEvent } from '../../services/audit';
import type { RequestContext } from '../auth/auth.types';
import {
  ProjectPermission,
  WorkspaceCapability,
  authorizeProject,
  requireWorkspaceAccess,
} from '../authorization';

type Input = { userId: string; workspaceId: string; projectId: string; taskId: string };

const entryInclude = {
  user: { select: { id: true, name: true } },
} as const;

type EntryRow = {
  id: string;
  taskId: string;
  userId: string;
  startedAt: Date;
  durationMinutes: number;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  user: { id: string; name: string };
};

function toSummary(row: EntryRow) {
  return {
    id: row.id,
    taskId: row.taskId,
    userId: row.userId,
    user: row.user,
    startedAt: row.startedAt,
    durationMinutes: row.durationMinutes,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createTaskTimeEntryService(prisma: PrismaClient = getPrismaClient()) {
  const authorizeView = async (input: Input) => {
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
    return { workspace, access };
  };

  async function ensureTaskAndEnabled(input: Input) {
    const { workspace, access } = await authorizeView(input);
    const ws = await prisma.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { id: true, timeTrackingEnabled: true },
    });
    if (!ws || !ws.timeTrackingEnabled) {
      throw new AppError(
        409,
        'TIME_TRACKING_DISABLED',
        'Time tracking is not enabled for this workspace',
      );
    }
    const task = await prisma.task.findFirst({
      where: { id: input.taskId, projectId: access.project.id, deletedAt: null },
      select: { id: true, title: true },
    });
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
    return { workspace, access, task };
  }

  return {
    async list(input: Input) {
      const { task } = await ensureTaskAndEnabled(input);
      const items = await prisma.taskTimeEntry.findMany({
        where: { taskId: task.id },
        orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
        include: entryInclude,
      });
      const summaries = items.map((row) => toSummary(row as EntryRow));
      const totalMinutes = summaries.reduce((sum, e) => sum + e.durationMinutes, 0);
      return { items: summaries, totalMinutes };
    },

    async log(
      input: Input & { startedAt: Date; durationMinutes: number; note?: string | null },
      context: RequestContext,
    ) {
      const { task } = await ensureTaskAndEnabled(input);
      // Allow assignees or users with task update/management permission to log their own time.
      const assignee = await prisma.taskAssignee.findFirst({
        where: { taskId: task.id, userId: input.userId },
        select: { id: true },
      });
      if (!assignee) {
        // try to authorize task update as manager
        const workspace = await requireWorkspaceAccess(prisma, {
          userId: input.userId,
          workspaceId: input.workspaceId,
          capability: WorkspaceCapability.ViewWorkspace,
        });
        try {
          await authorizeProject(prisma, {
            actor: {
              userId: input.userId,
              workspaceId: input.workspaceId,
              workspaceRole: workspace.effectiveRole,
            },
            projectId: input.projectId,
            permission: ProjectPermission.TaskUpdate,
            resource: { kind: 'task', taskId: input.taskId },
          });
        } catch {
          throw new AppError(
            403,
            'PERMISSION_DENIED',
            'You do not have permission to log time for this task',
          );
        }
      }

      const created = await prisma.$transaction(async (tx) => {
        const entry = await tx.taskTimeEntry.create({
          data: {
            taskId: task.id,
            userId: input.userId,
            startedAt: input.startedAt,
            durationMinutes: input.durationMinutes,
            note: input.note?.trim() || null,
          },
          include: entryInclude,
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.time_entry.logged',
          targetType: 'TaskTimeEntry',
          targetId: entry.id,
          metadata: { taskId: task.id, projectId: input.projectId, durationMinutes: input.durationMinutes },
          ...context,
        });
        return entry;
      });
      return toSummary(created as EntryRow);
    },

    async update(
      input: Input & {
        entryId: string;
        startedAt?: Date;
        durationMinutes?: number;
        note?: string | null;
      },
      context: RequestContext,
    ) {
      const { task } = await ensureTaskAndEnabled(input);
      const existing = await prisma.taskTimeEntry.findFirst({
        where: { id: input.entryId, taskId: task.id },
        include: entryInclude,
      });
      if (!existing) throw new AppError(404, 'TIME_ENTRY_NOT_FOUND', 'That time entry does not exist');
      if (existing.userId !== input.userId) {
        throw new AppError(403, 'PERMISSION_DENIED', 'You can only edit your own time entries');
      }

      const updated = await prisma.$transaction(async (tx) => {
        const entry = await tx.taskTimeEntry.update({
          where: { id: existing.id },
          data: {
            ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
            ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
            ...(input.note !== undefined ? { note: input.note?.trim() || null } : {}),
          },
          include: entryInclude,
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.time_entry.updated',
          targetType: 'TaskTimeEntry',
          targetId: entry.id,
          metadata: { taskId: task.id, projectId: input.projectId },
          ...context,
        });
        return entry;
      });
      return toSummary(updated as EntryRow);
    },

    async remove(input: Input & { entryId: string }, context: RequestContext) {
      const { task } = await ensureTaskAndEnabled(input);
      const existing = await prisma.taskTimeEntry.findFirst({
        where: { id: input.entryId, taskId: task.id },
        select: { id: true, userId: true },
      });
      if (!existing) throw new AppError(404, 'TIME_ENTRY_NOT_FOUND', 'That time entry does not exist');
      if (existing.userId !== input.userId) {
        throw new AppError(403, 'PERMISSION_DENIED', 'You can only delete your own time entries');
      }

      await prisma.$transaction(async (tx) => {
        await tx.taskTimeEntry.delete({ where: { id: existing.id } });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.time_entry.deleted',
          targetType: 'TaskTimeEntry',
          targetId: existing.id,
          metadata: { taskId: task.id, projectId: input.projectId },
          ...context,
        });
      });
      return { id: existing.id, deleted: true as const };
    },
  };
}
