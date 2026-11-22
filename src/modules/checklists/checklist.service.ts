import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { recordFanoutEvent } from '../../services/notification-fanout';
import { AppError } from '../../utils/errors';
import {
  ProjectPermission,
  assertNotSelfReview,
  authorizeProject,
  getProjectAuthorization,
  type ProjectAuthorization,
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
  ItemCompleted: 'checklist_item.completed',
  ItemUncompleted: 'checklist_item.uncompleted',
  ItemSignedOff: 'checklist_item.signed_off',
  ItemSignOffRemoved: 'checklist_item.sign_off_removed',
  FeedbackCreated: 'checklist_item.feedback_created',
  FeedbackUpdated: 'checklist_item.feedback_updated',
  FeedbackDeleted: 'checklist_item.feedback_deleted',
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

export interface ChecklistItemFeedbackSummary {
  id: string;
  checklistItemId: string;
  authorId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
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

type FeedbackRow = {
  id: string;
  checklistItemId: string;
  authorId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
};

function toFeedbackSummary(row: FeedbackRow): ChecklistItemFeedbackSummary {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
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

function assertFeedbackBody(body: string): void {
  if (body.length < 1 || body.length > 4000 || body.trim().length === 0) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Feedback body must be between 1 and 4000 non-blank characters',
    );
  }
}

function isManagerOrAdmin(authorization: ProjectAuthorization): boolean {
  return authorization.isWorkspaceAdmin || authorization.projectRole === 'PROJECT_MANAGER';
}

function assertWriteManagerOrActor(
  actorId: string,
  subjectId: string | null,
  authorization: ProjectAuthorization,
  action: string,
): void {
  if (isManagerOrAdmin(authorization) || subjectId === actorId) return;
  throw new AppError(
    403,
    'PERMISSION_DENIED',
    `You are not allowed to ${action} this checklist item`,
  );
}

function assertCanUncomplete(
  completedById: string | null,
  actorId: string,
  authorization: ProjectAuthorization,
): void {
  assertWriteManagerOrActor(actorId, completedById, authorization, 'uncomplete');
}

function assertCanRemoveSignOff(
  signedOffById: string | null,
  actorId: string,
  authorization: ProjectAuthorization,
): void {
  assertWriteManagerOrActor(actorId, signedOffById, authorization, 'remove the sign-off of');
}

type SignOffCandidate = { completed: boolean; completedById: string | null };

function assertCanSignOff(item: SignOffCandidate, actorId: string): void {
  if (!item.completed || !item.completedById) {
    throw new AppError(409, 'ITEM_NOT_COMPLETED', 'Only a completed item can be signed off');
  }
  assertNotSelfReview({ actorId, subjectUserId: item.completedById, action: 'approve' });
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
    permission: ProjectPermissionValue | null,
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
    const authorization: ProjectAuthorization = permission
      ? await authorizeProject(prisma, { actor, projectId: input.projectId, permission })
      : await getProjectAuthorization(prisma, actor, input.projectId);
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

  async function findLiveItem(
    tx: Prisma.TransactionClient,
    checklistId: string,
    itemId: string,
  ) {
    return tx.checklistItem.findFirst({
      where: { id: itemId, checklistId, deletedAt: null },
    });
  }

  async function loadItem(
    input: Input & { projectId: string; checklistId: string; itemId: string },
    permission: ProjectPermissionValue | null,
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

    async complete(input: Input & { projectId: string; checklistId: string; itemId: string }) {
      await loadItem(input, ProjectPermission.Update, 'write');
      return prisma.$transaction(async (tx) => {
        await lockChecklist(tx, input.checklistId);
        const current = await findLiveItem(tx, input.checklistId, input.itemId);
        if (!current) {
          throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'That checklist item does not exist');
        }
        if (current.completed) {
          const checklist = await tx.checklist.findUniqueOrThrow({
            where: { id: input.checklistId },
            select: { revision: true },
          });
          return { item: toItemSummary(current), revision: checklist.revision };
        }
        const result = await tx.checklistItem.updateMany({
          where: {
            id: current.id,
            checklistId: input.checklistId,
            deletedAt: null,
            completed: false,
          },
          data: { completed: true, completedById: input.userId, completedAt: new Date() },
        });
        if (result.count === 0) {
          const latest = await findLiveItem(tx, input.checklistId, input.itemId);
          if (!latest) {
            throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'That checklist item does not exist');
          }
          if (latest.completed) {
            const checklist = await tx.checklist.findUniqueOrThrow({
              where: { id: input.checklistId },
              select: { revision: true },
            });
            return { item: toItemSummary(latest), revision: checklist.revision };
          }
          throw new AppError(409, 'CHECKLIST_ITEM_CONFLICT', 'The item state changed concurrently');
        }
        const updated = (await findLiveItem(tx, input.checklistId, input.itemId))!;
        const revision = await bumpRevision(tx, input.checklistId);
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: ChecklistAuditAction.ItemCompleted,
          targetType: 'ChecklistItem',
          targetId: updated.id,
          metadata: {
            checklistId: input.checklistId,
            itemId: updated.id,
            revision,
            completedById: input.userId,
          },
        });
        return { item: toItemSummary(updated), revision };
      });
    },

    async uncomplete(input: Input & { projectId: string; checklistId: string; itemId: string }) {
      const { item, authorization } = await loadItem(input, null, 'write');
      assertCanUncomplete(item.completedById, input.userId, authorization);
      return prisma.$transaction(async (tx) => {
        await lockChecklist(tx, input.checklistId);
        const current = await findLiveItem(tx, input.checklistId, input.itemId);
        if (!current) {
          throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'That checklist item does not exist');
        }
        assertCanUncomplete(current.completedById, input.userId, authorization);
        if (current.signedOffAt) {
          throw new AppError(409, 'ITEM_SIGNED_OFF', 'A signed-off item cannot be uncompleted');
        }
        if (!current.completed) {
          const checklist = await tx.checklist.findUniqueOrThrow({
            where: { id: input.checklistId },
            select: { revision: true },
          });
          return { item: toItemSummary(current), revision: checklist.revision };
        }
        const result = await tx.checklistItem.updateMany({
          where: {
            id: current.id,
            checklistId: input.checklistId,
            deletedAt: null,
            completed: true,
            signedOffAt: null,
          },
          data: { completed: false, completedById: null, completedAt: null },
        });
        if (result.count === 0) {
          const latest = await findLiveItem(tx, input.checklistId, input.itemId);
          if (!latest) {
            throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'That checklist item does not exist');
          }
          if (latest.signedOffAt) {
            throw new AppError(409, 'ITEM_SIGNED_OFF', 'A signed-off item cannot be uncompleted');
          }
          if (!latest.completed) {
            const checklist = await tx.checklist.findUniqueOrThrow({
              where: { id: input.checklistId },
              select: { revision: true },
            });
            return { item: toItemSummary(latest), revision: checklist.revision };
          }
          throw new AppError(409, 'CHECKLIST_ITEM_CONFLICT', 'The item state changed concurrently');
        }
        const updated = (await findLiveItem(tx, input.checklistId, input.itemId))!;
        const revision = await bumpRevision(tx, input.checklistId);
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: ChecklistAuditAction.ItemUncompleted,
          targetType: 'ChecklistItem',
          targetId: updated.id,
          metadata: {
            checklistId: input.checklistId,
            itemId: updated.id,
            revision,
            previousCompletedById: current.completedById,
          },
        });
        return { item: toItemSummary(updated), revision };
      });
    },

    async signOff(input: Input & { projectId: string; checklistId: string; itemId: string }) {
      const { item } = await loadItem(
        input,
        ProjectPermission.SubmissionApprove,
        'write',
      );
      assertCanSignOff(item, input.userId);
      return prisma.$transaction(async (tx) => {
        await lockChecklist(tx, input.checklistId);
        const current = await findLiveItem(tx, input.checklistId, input.itemId);
        if (!current) {
          throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'That checklist item does not exist');
        }
        assertCanSignOff(current, input.userId);
        if (current.signedOffAt) {
          const checklist = await tx.checklist.findUniqueOrThrow({
            where: { id: input.checklistId },
            select: { revision: true },
          });
          return { item: toItemSummary(current), revision: checklist.revision };
        }
        const result = await tx.checklistItem.updateMany({
          where: {
            id: current.id,
            checklistId: input.checklistId,
            deletedAt: null,
            completed: true,
            signedOffAt: null,
          },
          data: { signedOffById: input.userId, signedOffAt: new Date() },
        });
        if (result.count === 0) {
          const latest = await findLiveItem(tx, input.checklistId, input.itemId);
          if (!latest) {
            throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'That checklist item does not exist');
          }
          assertCanSignOff(latest, input.userId);
          if (latest.signedOffAt) {
            const checklist = await tx.checklist.findUniqueOrThrow({
              where: { id: input.checklistId },
              select: { revision: true },
            });
            return { item: toItemSummary(latest), revision: checklist.revision };
          }
          throw new AppError(409, 'CHECKLIST_ITEM_CONFLICT', 'The item state changed concurrently');
        }
        const updated = (await findLiveItem(tx, input.checklistId, input.itemId))!;
        const revision = await bumpRevision(tx, input.checklistId);
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: ChecklistAuditAction.ItemSignedOff,
          targetType: 'ChecklistItem',
          targetId: updated.id,
          metadata: {
            checklistId: input.checklistId,
            itemId: updated.id,
            revision,
            signedOffById: input.userId,
          },
        });
        await recordFanoutEvent(tx, {
          action: ChecklistAuditAction.ItemSignedOff,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          actorId: input.userId,
          targetType: 'ChecklistItem',
          targetId: updated.id,
          dedupeKey: `checklist:${updated.id}:signed_off`,
          context: { checklistId: input.checklistId, itemId: updated.id, revision },
        });
        return { item: toItemSummary(updated), revision };
      });
    },

    async removeSignOff(input: Input & { projectId: string; checklistId: string; itemId: string }) {
      const { item, authorization } = await loadItem(input, null, 'write');
      assertCanRemoveSignOff(item.signedOffById, input.userId, authorization);
      return prisma.$transaction(async (tx) => {
        await lockChecklist(tx, input.checklistId);
        const current = await findLiveItem(tx, input.checklistId, input.itemId);
        if (!current) {
          throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'That checklist item does not exist');
        }
        assertCanRemoveSignOff(current.signedOffById, input.userId, authorization);
        if (!current.signedOffAt) {
          const checklist = await tx.checklist.findUniqueOrThrow({
            where: { id: input.checklistId },
            select: { revision: true },
          });
          return { item: toItemSummary(current), revision: checklist.revision };
        }
        const result = await tx.checklistItem.updateMany({
          where: {
            id: current.id,
            checklistId: input.checklistId,
            deletedAt: null,
            signedOffAt: { not: null },
          },
          data: { signedOffById: null, signedOffAt: null },
        });
        if (result.count === 0) {
          const latest = await findLiveItem(tx, input.checklistId, input.itemId);
          if (!latest) {
            throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'That checklist item does not exist');
          }
          if (!latest.signedOffAt) {
            const checklist = await tx.checklist.findUniqueOrThrow({
              where: { id: input.checklistId },
              select: { revision: true },
            });
            return { item: toItemSummary(latest), revision: checklist.revision };
          }
          throw new AppError(409, 'CHECKLIST_ITEM_CONFLICT', 'The item state changed concurrently');
        }
        const updated = (await findLiveItem(tx, input.checklistId, input.itemId))!;
        const revision = await bumpRevision(tx, input.checklistId);
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: ChecklistAuditAction.ItemSignOffRemoved,
          targetType: 'ChecklistItem',
          targetId: updated.id,
          metadata: {
            checklistId: input.checklistId,
            itemId: updated.id,
            revision,
            previousSignedOffById: current.signedOffById,
          },
        });
        return { item: toItemSummary(updated), revision };
      });
    },

    async listFeedback(
      input: Input & {
        projectId: string;
        checklistId: string;
        itemId: string;
        cursor?: string;
        limit: number;
      },
    ) {
      await loadItem(input, ProjectPermission.View, 'view');
      const rows = await prisma.checklistItemFeedback.findMany({
        where: { checklistItemId: input.itemId, deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > input.limit;
      const items = (hasMore ? rows.slice(0, input.limit) : rows).map(toFeedbackSummary);
      return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
    },

    async createFeedback(
      input: Input & {
        projectId: string;
        checklistId: string;
        itemId: string;
        body: string;
      },
    ) {
      await loadItem(input, ProjectPermission.Update, 'write');
      assertFeedbackBody(input.body);
      const feedback = await prisma.$transaction(async (tx) => {
        const item = await findLiveItem(tx, input.checklistId, input.itemId);
        if (!item) {
          throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'That checklist item does not exist');
        }
        const created = await tx.checklistItemFeedback.create({
          data: {
            checklistItemId: item.id,
            authorId: input.userId,
            body: input.body,
          },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: ChecklistAuditAction.FeedbackCreated,
          targetType: 'ChecklistItemFeedback',
          targetId: created.id,
          metadata: {
            checklistId: input.checklistId,
            itemId: item.id,
            feedbackId: created.id,
          },
        });
        return created;
      });
      return { feedback: toFeedbackSummary(feedback) };
    },

    async editFeedback(
      input: Input & {
        projectId: string;
        checklistId: string;
        itemId: string;
        feedbackId: string;
        body: string;
      },
    ) {
      await loadItem(input, ProjectPermission.Update, 'write');
      assertFeedbackBody(input.body);
      const feedback = await prisma.$transaction(async (tx) => {
        const item = await findLiveItem(tx, input.checklistId, input.itemId);
        if (!item) {
          throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'That checklist item does not exist');
        }
        const existing = await tx.checklistItemFeedback.findFirst({
          where: { id: input.feedbackId, checklistItemId: item.id, deletedAt: null },
        });
        if (!existing) {
          throw new AppError(
            404,
            'CHECKLIST_ITEM_FEEDBACK_NOT_FOUND',
            'That feedback does not exist',
          );
        }
        if (existing.authorId !== input.userId) {
          throw new AppError(403, 'FEEDBACK_FORBIDDEN', 'Only the author can edit this feedback');
        }
        const now = new Date();
        const updated = await tx.checklistItemFeedback.update({
          where: { id: existing.id },
          data: { body: input.body, editedAt: now, updatedAt: now },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: ChecklistAuditAction.FeedbackUpdated,
          targetType: 'ChecklistItemFeedback',
          targetId: updated.id,
          metadata: {
            checklistId: input.checklistId,
            itemId: item.id,
            feedbackId: updated.id,
          },
        });
        return updated;
      });
      return { feedback: toFeedbackSummary(feedback) };
    },

    async deleteFeedback(
      input: Input & {
        projectId: string;
        checklistId: string;
        itemId: string;
        feedbackId: string;
      },
    ) {
      const { workspace, authorization } = await loadItem(
        input,
        ProjectPermission.Update,
        'write',
      );
      await prisma.$transaction(async (tx) => {
        const item = await findLiveItem(tx, input.checklistId, input.itemId);
        if (!item) {
          throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'That checklist item does not exist');
        }
        const existing = await tx.checklistItemFeedback.findFirst({
          where: { id: input.feedbackId, checklistItemId: item.id, deletedAt: null },
        });
        if (!existing) {
          throw new AppError(
            404,
            'CHECKLIST_ITEM_FEEDBACK_NOT_FOUND',
            'That feedback does not exist',
          );
        }
        const isAuthor = existing.authorId === input.userId;
        const isWorkspaceAdmin =
          workspace.effectiveRole === 'OWNER' || workspace.effectiveRole === 'PROJECT_MANAGER';
        if (!isAuthor && !isWorkspaceAdmin && !isManagerOrAdmin(authorization)) {
          throw new AppError(
            403,
            'FEEDBACK_FORBIDDEN',
            'Only the author or an admin can delete this feedback',
          );
        }
        const now = new Date();
        await tx.checklistItemFeedback.update({
          where: { id: existing.id },
          data: { deletedAt: now, updatedAt: now },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: ChecklistAuditAction.FeedbackDeleted,
          targetType: 'ChecklistItemFeedback',
          targetId: existing.id,
          metadata: {
            checklistId: input.checklistId,
            itemId: item.id,
            feedbackId: existing.id,
          },
        });
      });
      return { ok: true };
    },
  };
}

export type ChecklistService = ReturnType<typeof createChecklistService>;
