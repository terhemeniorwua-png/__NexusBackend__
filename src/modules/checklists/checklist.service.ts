import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import {
  ProjectPermission,
  authorizeProject,
  type ProjectPermissionValue,
} from '../authorization';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import { assertProjectWritable } from '../projects/project-archive';

/** BE-4 emits audit events only; notifications remain owned by BE-5. */
export const ChecklistAuditAction = {
  Created: 'checklist.created',
  Updated: 'checklist.updated',
  Deleted: 'checklist.deleted',
} as const;

export interface ChecklistSummary {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  description: string | null;
  revision: number;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

type Input = { userId: string; workspaceId: string };
type ChecklistRow = {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  description: string | null;
  revision: number;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
};

function toChecklistSummary(row: ChecklistRow): ChecklistSummary {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createChecklistService(prisma: PrismaClient = getPrismaClient()) {
  async function loadProject(
    input: Input & { projectId: string },
    permission: ProjectPermissionValue,
    mode: 'view' | 'write',
  ) {
    const workspace = await requireWorkspaceAccess(prisma, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });
    const actor = {
      userId: input.userId,
      workspaceId: input.workspaceId,
      workspaceRole: workspace.effectiveRole,
    };
    const authorization = await authorizeProject(prisma, {
      actor,
      projectId: input.projectId,
      permission,
    });
    if (mode === 'write') assertProjectWritable(authorization.project);
    return { workspace, actor, authorization };
  }

  async function loadChecklist(
    input: Input & { projectId: string; checklistId: string },
    permission: ProjectPermissionValue,
    mode: 'view' | 'write',
  ) {
    const workspace = await requireWorkspaceAccess(prisma, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });
    const checklist = await prisma.checklist.findFirst({
      where: {
        id: input.checklistId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        deletedAt: null,
      },
    });
    if (!checklist) {
      throw new AppError(404, 'CHECKLIST_NOT_FOUND', 'That checklist does not exist');
    }
    const actor = {
      userId: input.userId,
      workspaceId: input.workspaceId,
      workspaceRole: workspace.effectiveRole,
    };
    const authorization = await authorizeProject(prisma, {
      actor,
      projectId: input.projectId,
      permission,
    });
    if (mode === 'write') assertProjectWritable(authorization.project);
    return { workspace, actor, checklist, authorization };
  }

  return {
    async list(input: Input & { projectId: string; cursor?: string; limit: number }) {
      await loadProject(input, ProjectPermission.View, 'view');
      const rows = await prisma.checklist.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          deletedAt: null,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit).map(toChecklistSummary);
      return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
    },

    async create(
      input: Input & { projectId: string; title: string; description?: string | null },
    ) {
      await loadProject(input, ProjectPermission.Update, 'write');
      return prisma.$transaction(async (tx) => {
        const checklist = await tx.checklist.create({
          data: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            title: input.title,
            description: input.description ?? null,
            createdById: input.userId,
          },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: ChecklistAuditAction.Created,
          targetType: 'Checklist',
          targetId: checklist.id,
          metadata: {
            checklistId: checklist.id,
            projectId: input.projectId,
            revision: checklist.revision,
            title: checklist.title,
          },
        });
        return { checklist: toChecklistSummary(checklist) };
      });
    },

    async get(input: Input & { projectId: string; checklistId: string }) {
      const { checklist } = await loadChecklist(
        input,
        ProjectPermission.View,
        'view',
      );
      return { checklist: toChecklistSummary(checklist) };
    },

    async update(
      input: Input & {
        projectId: string;
        checklistId: string;
        title?: string;
        description?: string | null;
      },
    ) {
      const { checklist } = await loadChecklist(
        input,
        ProjectPermission.Update,
        'write',
      );
      return prisma.$transaction(async (tx) => {
        const updated = await tx.checklist.update({
          where: { id: checklist.id },
          data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
          },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: ChecklistAuditAction.Updated,
          targetType: 'Checklist',
          targetId: checklist.id,
          metadata: {
            checklistId: checklist.id,
            projectId: input.projectId,
            revision: updated.revision,
            before: { title: checklist.title, description: checklist.description },
            after: { title: updated.title, description: updated.description },
          },
        });
        return { checklist: toChecklistSummary(updated) };
      });
    },

    async delete(input: Input & { projectId: string; checklistId: string }) {
      const { checklist } = await loadChecklist(
        input,
        ProjectPermission.Update,
        'write',
      );
      return prisma.$transaction(async (tx) => {
        const now = new Date();
        const deleted = await tx.checklist.update({
          where: { id: checklist.id },
          data: { deletedAt: now },
        });
        const items = await tx.checklistItem.updateMany({
          where: { checklistId: checklist.id, deletedAt: null },
          data: { deletedAt: now },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: ChecklistAuditAction.Deleted,
          targetType: 'Checklist',
          targetId: checklist.id,
          metadata: {
            checklistId: checklist.id,
            projectId: input.projectId,
            revision: deleted.revision,
            itemsSoftDeleted: items.count,
          },
        });
        return { ok: true };
      });
    },
  };
}

export type ChecklistService = ReturnType<typeof createChecklistService>;
