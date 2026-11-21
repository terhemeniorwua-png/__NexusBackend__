import type { Prisma, PrismaClient } from '@prisma/client';
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
  ItemCreated: 'checklist_item.created',
  ItemUpdated: 'checklist_item.updated',
  ItemDeleted: 'checklist_item.deleted',
  ItemReordered: 'checklist_item.reordered',
} as const;

export const MAX_LIVE_ITEMS = 200;

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

export interface ChecklistItemSummary {
  id: string;
  checklistId: string;
  position: number;
  text: string;
  completed: boolean;
  completedById: string | null;
  completedAt: string | null;
  signedOffById: string | null;
  signedOffAt: string | null;
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

type ChecklistItemRow = {
  id: string;
  checklistId: string;
  position: number;
  text: string;
  completed: boolean;
  completedById: string | null;
  completedAt: Date | null;
  signedOffById: string | null;
  signedOffAt: Date | null;
};

function toChecklistSummary(row: ChecklistRow): ChecklistSummary {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toItemSummary(row: ChecklistItemRow): ChecklistItemSummary {
  return {
    ...row,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    signedOffAt: row.signedOffAt ? row.signedOffAt.toISOString() : null,
  };
}

function assertItemText(text: string): void {
  if (text.length < 1 || text.length > 500 || text.trim().length === 0) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Item text must be between 1 and 500 non-blank characters',
    );
  }
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

  /** Serializes all dense-position and revision writes for one checklist. */
  async function lockChecklist(tx: Prisma.TransactionClient, checklistId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "Checklist" WHERE "id" = ${checklistId} FOR UPDATE`;
  }

  async function bumpRevision(tx: Prisma.TransactionClient, checklistId: string): Promise<number> {
    const updated = await tx.checklist.update({
      where: { id: checklistId },
      data: { revision: { increment: 1 } },
      select: { revision: true },
    });
    return updated.revision;
  }

  async function loadItem(
    input: Input & { projectId: string; checklistId: string; itemId: string },
    permission: ProjectPermissionValue,
    mode: 'view' | 'write',
  ) {
    const loaded = await loadChecklist(input, permission, mode);
    const item = await prisma.checklistItem.findFirst({
      where: { id: input.itemId, checklistId: input.checklistId, deletedAt: null },
    });
    if (!item) {
      throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'That checklist item does not exist');
    }
    return { ...loaded, item };
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

    async listItems(input: Input & { projectId: string; checklistId: string }) {
      await loadChecklist(input, ProjectPermission.View, 'view');
      const rows = await prisma.checklistItem.findMany({
        where: { checklistId: input.checklistId, deletedAt: null },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
      return { items: rows.map(toItemSummary) };
    },

    async createItem(
      input: Input & {
        projectId: string;
        checklistId: string;
        text: string;
      },
    ) {
      assertItemText(input.text);
      await loadChecklist(input, ProjectPermission.Update, 'write');
      return prisma.$transaction(async (tx) => {
        await lockChecklist(tx, input.checklistId);
        const liveCount = await tx.checklistItem.count({
          where: { checklistId: input.checklistId, deletedAt: null },
        });
        if (liveCount >= MAX_LIVE_ITEMS) {
          throw new AppError(
            409,
            'CHECKLIST_ITEM_LIMIT',
            `A checklist can contain at most ${MAX_LIVE_ITEMS} live items`,
          );
        }
        const item = await tx.checklistItem.create({
          data: {
            checklistId: input.checklistId,
            position: liveCount,
            text: input.text,
          },
        });
        const revision = await bumpRevision(tx, input.checklistId);
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: ChecklistAuditAction.ItemCreated,
          targetType: 'ChecklistItem',
          targetId: item.id,
          metadata: {
            checklistId: input.checklistId,
            itemId: item.id,
            position: item.position,
            revision,
            text: item.text,
          },
        });
        return { item: toItemSummary(item), revision };
      });
    },

    async updateItem(
      input: Input & {
        projectId: string;
        checklistId: string;
        itemId: string;
        text: string;
      },
    ) {
      assertItemText(input.text);
      await loadItem(input, ProjectPermission.Update, 'write');
      return prisma.$transaction(async (tx) => {
        await lockChecklist(tx, input.checklistId);
        const current = await tx.checklistItem.findFirst({
          where: { id: input.itemId, checklistId: input.checklistId, deletedAt: null },
        });
        if (!current) {
          throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'That checklist item does not exist');
        }
        if (current.text === input.text) {
          const checklist = await tx.checklist.findUniqueOrThrow({
            where: { id: input.checklistId },
            select: { revision: true },
          });
          return { item: toItemSummary(current), revision: checklist.revision };
        }
        const item = await tx.checklistItem.update({
          where: { id: current.id },
          data: { text: input.text },
        });
        const revision = await bumpRevision(tx, input.checklistId);
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: ChecklistAuditAction.ItemUpdated,
          targetType: 'ChecklistItem',
          targetId: item.id,
          metadata: {
            checklistId: input.checklistId,
            itemId: item.id,
            revision,
            before: { text: current.text },
            after: { text: item.text },
          },
        });
        return { item: toItemSummary(item), revision };
      });
    },

    async deleteItem(input: Input & { projectId: string; checklistId: string; itemId: string }) {
      await loadItem(input, ProjectPermission.Update, 'write');
      return prisma.$transaction(async (tx) => {
        await lockChecklist(tx, input.checklistId);
        const item = await tx.checklistItem.findFirst({
          where: { id: input.itemId, checklistId: input.checklistId, deletedAt: null },
        });
        if (!item) {
          throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'That checklist item does not exist');
        }
        await tx.checklistItem.update({
          where: { id: item.id },
          data: { deletedAt: new Date() },
        });
        const remaining = await tx.checklistItem.findMany({
          where: { checklistId: input.checklistId, deletedAt: null },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        });
        for (const [index, row] of remaining.entries()) {
          if (row.position !== index) {
            await tx.checklistItem.update({
              where: { id: row.id },
              data: { position: index },
            });
          }
        }
        const revision = await bumpRevision(tx, input.checklistId);
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: ChecklistAuditAction.ItemDeleted,
          targetType: 'ChecklistItem',
          targetId: item.id,
          metadata: {
            checklistId: input.checklistId,
            itemId: item.id,
            revision,
            previousPosition: item.position,
          },
        });
        return { ok: true, revision };
      });
    },

    async reorderItems(
      input: Input & {
        projectId: string;
        checklistId: string;
        itemIds: string[];
      },
    ) {
      await loadChecklist(input, ProjectPermission.Update, 'write');
      return prisma.$transaction(async (tx) => {
        await lockChecklist(tx, input.checklistId);
        const live = await tx.checklistItem.findMany({
          where: { checklistId: input.checklistId, deletedAt: null },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        });
        const liveIds = new Set(live.map((row) => row.id));
        const requestedIds = new Set(input.itemIds);
        if (
          requestedIds.size !== input.itemIds.length ||
          input.itemIds.length !== liveIds.size ||
          input.itemIds.some((id) => !liveIds.has(id))
        ) {
          throw new AppError(
            409,
            'CHECKLIST_ITEMS_MISMATCH',
            'itemIds must be the complete ordered list of live checklist item ids',
          );
        }
        const byId = new Map(live.map((row) => [row.id, row]));
        let changed = false;
        for (const [index, id] of input.itemIds.entries()) {
          const row = byId.get(id)!;
          if (row.position !== index) {
            await tx.checklistItem.update({
              where: { id },
              data: { position: index },
            });
            changed = true;
          }
        }
        const items = await tx.checklistItem.findMany({
          where: { checklistId: input.checklistId, deletedAt: null },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        });
        if (!changed) {
          const checklist = await tx.checklist.findUniqueOrThrow({
            where: { id: input.checklistId },
            select: { revision: true },
          });
          return { items: items.map(toItemSummary), revision: checklist.revision };
        }
        const revision = await bumpRevision(tx, input.checklistId);
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: ChecklistAuditAction.ItemReordered,
          targetType: 'Checklist',
          targetId: input.checklistId,
          metadata: {
            checklistId: input.checklistId,
            itemIds: input.itemIds,
            revision,
          },
        });
        return { items: items.map(toItemSummary), revision };
      });
    },
  };
}

export type ChecklistService = ReturnType<typeof createChecklistService>;
