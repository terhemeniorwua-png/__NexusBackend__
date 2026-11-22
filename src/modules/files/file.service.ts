import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { recordFanoutEvent } from '../../services/notification-fanout';
import type { PrivateObjectStorage } from '../../services/storage/private-object-storage';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  ProjectPermission,
  authorizeProject,
  getProjectAuthorization,
} from '../authorization';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import { extractTextFromUpload } from './text-extraction';
import { assertProjectWritable } from '../projects/project-archive';
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from './file.schemas';

/** BE-3 emits audit events only; notifications remain owned by BE-5. */
export const FileVersionAuditAction = {
  Created: 'file.version.created',
  MadeCurrent: 'file.version.made_current',
  Deleted: 'file.version.deleted',
  FeedbackCreated: 'file.feedback.created',
  FeedbackUpdated: 'file.feedback.updated',
  FeedbackDeleted: 'file.feedback.deleted',
} as const;

export interface FileSummary {
  id: string;
  workspaceId: string;
  projectId: string | null;
  taskId: string | null;
  uploadedById: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

type Input = { userId: string; workspaceId: string };

export function createFileService(
  prisma: PrismaClient = getPrismaClient(),
  storage: PrivateObjectStorage | null = null,
) {
  function requireStorage(): PrivateObjectStorage {
    if (!storage) {
      throw new AppError(
        503,
        'OBJECT_STORAGE_UNAVAILABLE',
        'Private object storage is not configured',
      );
    }
    return storage;
  }

  async function deleteStoredObject(key: string): Promise<void> {
    try {
      await requireStorage().delete(key);
    } catch (error) {
      logger.warn('file_object_delete_failed', { key, error });
    }
  }

  function toSummary(row: {
    id: string;
    workspaceId: string;
    projectId: string | null;
    taskId: string | null;
    uploadedById: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: Date;
  }): FileSummary {
    return { ...row, createdAt: row.createdAt.toISOString() };
  }

  type VersionSummaryRow = {
    id: string;
    attachmentId: string;
    versionNumber: number;
    isCurrent: boolean;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    uploadedById: string;
    changeNote: string | null;
    createdAt: Date;
  };

  function toVersionSummary(row: VersionSummaryRow) {
    return { ...row, createdAt: row.createdAt.toISOString() };
  }

  type FeedbackSummaryRow = {
    id: string;
    attachmentVersionId: string;
    authorId: string;
    body: string;
    createdAt: Date;
    updatedAt: Date;
    editedAt: Date | null;
  };

  function toFeedbackSummary(row: FeedbackSummaryRow) {
    return {
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    };
  }

  /** Plain file downloads always resolve the single current live version. */
  async function requireCurrentVersion(attachmentId: string) {
    const version = await prisma.attachmentVersion.findFirst({
      where: { attachmentId, isCurrent: true, deletedAt: null },
      orderBy: { versionNumber: 'desc' },
    });
    if (!version) {
      throw new AppError(
        404,
        'FILE_VERSION_NOT_FOUND',
        'The current version of this file does not exist',
      );
    }
    return version;
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

  /**
   * Loads a live attachment after proving workspace access and the requested
   * project permission. `write` additionally applies the workspace VIEWER and
   * archived-project guards shared by all BE-3 mutation endpoints.
   */
  async function loadAttachment(
    input: Input & { fileId: string },
    mode: 'view' | 'write',
  ) {
    const workspace = await requireWorkspaceAccess(prisma, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });

    const file = await prisma.fileAttachment.findFirst({
      where: { id: input.fileId, workspaceId: input.workspaceId, deletedAt: null },
    });
    if (!file) {
      throw new AppError(404, 'FILE_NOT_FOUND', 'That file does not exist');
    }

    const actor = {
      userId: input.userId,
      workspaceId: input.workspaceId,
      workspaceRole: workspace.effectiveRole,
    };

    if (file.projectId) {
      const authorization = await authorizeProject(prisma, {
        actor,
        projectId: file.projectId,
        permission: mode === 'write' ? ProjectPermission.FileUpload : ProjectPermission.View,
      });
      if (mode === 'write') {
        assertProjectWritable(authorization.project);
      }
      return { workspace, actor, file, authorization };
    }

    if (mode === 'write' && workspace.effectiveRole === 'VIEWER') {
      throw new AppError(
        403,
        'INSUFFICIENT_ROLE',
        'Your role does not allow modifying workspace files',
      );
    }
    return { workspace, actor, file, authorization: null };
  }

  return {
    async upload(
      input: Input & {
        fileName: string;
        mimeType: string;
        sizeBytes: number;
        body: Buffer;
        projectId?: string | null;
        taskId?: string | null;
      },
    ): Promise<FileSummary> {
      // Verify workspace access
      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      // If uploading to a project, verify project access
      if (input.projectId) {
        const projectAccess = await authorizeProject(prisma, {
          actor: {
            userId: input.userId,
            workspaceId: input.workspaceId,
            workspaceRole: workspace.effectiveRole,
          },
          projectId: input.projectId,
          permission: ProjectPermission.FileUpload,
        });
        assertProjectWritable(projectAccess.project);
      }

      const store = requireStorage();
      const storageKey = `workspaces/${input.workspaceId}/files/${randomUUID()}/${input.fileName}`;

      // Never trust a client-declared size: persist what was actually stored.
      const sizeBytes = input.body.byteLength;
      await store.put({ key: storageKey, body: input.body, contentType: input.mimeType });

      const extractedText = extractTextFromUpload(input.fileName, input.mimeType, input.body);

      let committed = false;
      try {
        const file = await prisma.$transaction(async (tx) => {
          const created = await tx.fileAttachment.create({
            data: {
              workspaceId: input.workspaceId,
              projectId: input.projectId ?? null,
              taskId: input.taskId ?? null,
              uploadedById: input.userId,
              fileName: input.fileName,
              mimeType: input.mimeType,
              sizeBytes,
              storageKey,
              extractedText,
              textExtractedAt: extractedText ? new Date() : null,
            },
          });

          // The legacy attachment key stays the v1 version key.
          await tx.attachmentVersion.create({
            data: {
              attachmentId: created.id,
              versionNumber: 1,
              isCurrent: true,
              fileName: created.fileName,
              mimeType: created.mimeType,
              sizeBytes,
              storageKey,
              extractedText,
              uploadedById: created.uploadedById,
              createdAt: created.createdAt,
              updatedAt: new Date(),
            },
          });

          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: 'file.uploaded',
            targetType: 'FileAttachment',
            targetId: created.id,
            metadata: {
              fileName: input.fileName,
              mimeType: input.mimeType,
              sizeBytes,
              projectId: input.projectId ?? null,
              taskId: input.taskId ?? null,
            },
          });

          return created;
        });
        committed = true;
        return toSummary(file);
      } finally {
        if (!committed) await deleteStoredObject(storageKey);
      }
    },

    async uploadVersion(
      input: Input & {
        fileId: string;
        fileName: string;
        mimeType: string;
        body: Buffer;
        changeNote?: string | null;
      },
    ): Promise<{ version: ReturnType<typeof toVersionSummary> }> {
      const { actor, file } = await loadAttachment(input, 'write');
      const store = requireStorage();
      const sizeBytes = input.body.byteLength;
      const storageKey = `workspaces/${input.workspaceId}/files/${file.id}/versions/${randomUUID()}/${input.fileName}`;
      const changeNote = input.changeNote?.trim() || null;

      await store.put({ key: storageKey, body: input.body, contentType: input.mimeType });

      let committed = false;
      try {
        const version = await prisma.$transaction(async (tx) => {
          // Serializes concurrent version allocations for the same attachment.
          const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id" FROM "FileAttachment" WHERE "id" = ${file.id} FOR UPDATE
          `;
          if (locked.length === 0) {
            throw new AppError(404, 'FILE_NOT_FOUND', 'That file does not exist');
          }

          const max = await tx.attachmentVersion.aggregate({
            where: { attachmentId: file.id },
            _max: { versionNumber: true },
          });
          const versionNumber = (max._max.versionNumber ?? 0) + 1;
          const now = new Date();
          const extractedText = extractTextFromUpload(input.fileName, input.mimeType, input.body);

          const created = await tx.attachmentVersion.create({
            data: {
              attachmentId: file.id,
              versionNumber,
              isCurrent: false,
              fileName: input.fileName,
              mimeType: input.mimeType,
              sizeBytes,
              storageKey,
              changeNote,
              extractedText,
              uploadedById: input.userId,
              createdAt: now,
              updatedAt: now,
            },
          });

          await tx.attachmentVersion.updateMany({
            where: {
              attachmentId: file.id,
              isCurrent: true,
              deletedAt: null,
              id: { not: created.id },
            },
            data: { isCurrent: false, updatedAt: now },
          });
          await tx.attachmentVersion.update({
            where: { id: created.id },
            data: { isCurrent: true, updatedAt: now },
          });

          await tx.fileAttachment.update({
            where: { id: file.id },
            data: { fileName: input.fileName, mimeType: input.mimeType, sizeBytes, updatedAt: now },
          });

          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: actor.userId,
            action: FileVersionAuditAction.Created,
            targetType: 'AttachmentVersion',
            targetId: created.id,
            metadata: {
              fileId: file.id,
              versionNumber,
              fileName: created.fileName,
              mimeType: created.mimeType,
              sizeBytes,
              storageKey,
            },
          });

          if (file.projectId) {
            await recordFanoutEvent(tx, {
              action: FileVersionAuditAction.Created,
              workspaceId: input.workspaceId,
              projectId: file.projectId,
              actorId: actor.userId,
              targetType: 'AttachmentVersion',
              targetId: created.id,
              dedupeKey: `file-version:${created.id}:created`,
              context: { fileId: file.id, versionNumber, fileName: created.fileName },
            });
          }

          return created;
        });
        committed = true;
        return { version: toVersionSummary(version) };
      } finally {
        if (!committed) await deleteStoredObject(storageKey);
      }
    },

    async listVersions(
      input: Input & { fileId: string; cursor?: string; limit: number },
    ): Promise<{ items: Array<ReturnType<typeof toVersionSummary>>; nextCursor: string | null }> {
      await loadAttachment(input, 'view');
      const rows = await prisma.attachmentVersion.findMany({
        where: { attachmentId: input.fileId, deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > input.limit;
      const items = (hasMore ? rows.slice(0, input.limit) : rows).map(toVersionSummary);
      return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
    },

    async getVersion(
      input: Input & { fileId: string; versionId: string },
    ): Promise<{ version: ReturnType<typeof toVersionSummary> }> {
      await loadAttachment(input, 'view');
      const version = await prisma.attachmentVersion.findFirst({
        where: { id: input.versionId, attachmentId: input.fileId, deletedAt: null },
      });
      if (!version) {
        throw new AppError(404, 'FILE_VERSION_NOT_FOUND', 'That file version does not exist');
      }
      return { version: toVersionSummary(version) };
    },

    async downloadVersion(
      input: Input & { fileId: string; versionId: string },
    ): Promise<{ body: Buffer; contentType: string; fileName: string }> {
      await loadAttachment(input, 'view');
      const version = await prisma.attachmentVersion.findFirst({
        where: { id: input.versionId, attachmentId: input.fileId, deletedAt: null },
      });
      if (!version) {
        throw new AppError(404, 'FILE_VERSION_NOT_FOUND', 'That file version does not exist');
      }
      const result = await requireStorage().get(version.storageKey, {
        allowedContentTypes: ALLOWED_MIME_TYPES,
        maxReadBytes: Math.min(version.sizeBytes, MAX_FILE_SIZE_BYTES),
        tooLargeCode: 'FILE_VERSION_TOO_LARGE',
        tooLargeMessage: 'Stored file exceeds its recorded size',
        invalidContentTypeCode: 'FILE_VERSION_CONTENT_TYPE_INVALID',
        invalidContentTypeMessage: 'Stored file has an unsupported content type',
      });
      return { body: result.body, contentType: version.mimeType, fileName: version.fileName };
    },

    async makeCurrent(
      input: Input & { fileId: string; versionId: string },
    ): Promise<{ version: ReturnType<typeof toVersionSummary> }> {
      await loadAttachment(input, 'write');
      const version = await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "FileAttachment" WHERE "id" = ${input.fileId} FOR UPDATE
        `;
        if (locked.length === 0) {
          throw new AppError(404, 'FILE_NOT_FOUND', 'That file does not exist');
        }
        const target = await tx.attachmentVersion.findFirst({
          where: { id: input.versionId, attachmentId: input.fileId, deletedAt: null },
        });
        if (!target) {
          throw new AppError(404, 'FILE_VERSION_NOT_FOUND', 'That file version does not exist');
        }
        const now = new Date();
        if (!target.isCurrent) {
          await tx.attachmentVersion.updateMany({
            where: {
              attachmentId: input.fileId,
              isCurrent: true,
              deletedAt: null,
              id: { not: target.id },
            },
            data: { isCurrent: false, updatedAt: now },
          });
          await tx.attachmentVersion.update({
            where: { id: target.id },
            data: { isCurrent: true, updatedAt: now },
          });
          await tx.fileAttachment.update({
            where: { id: input.fileId },
            data: {
              fileName: target.fileName,
              mimeType: target.mimeType,
              sizeBytes: target.sizeBytes,
              updatedAt: now,
            },
          });
          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: FileVersionAuditAction.MadeCurrent,
            targetType: 'AttachmentVersion',
            targetId: target.id,
            metadata: {
              fileId: input.fileId,
              versionNumber: target.versionNumber,
              storageKey: target.storageKey,
            },
          });
          return { ...target, isCurrent: true, updatedAt: now };
        }
        return target;
      });
      return { version: toVersionSummary(version) };
    },

    async deleteVersion(
      input: Input & { fileId: string; versionId: string },
    ): Promise<{ ok: true }> {
      await loadAttachment(input, 'write');
      const deletedKey = await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "FileAttachment" WHERE "id" = ${input.fileId} FOR UPDATE
        `;
        if (locked.length === 0) {
          throw new AppError(404, 'FILE_NOT_FOUND', 'That file does not exist');
        }
        const target = await tx.attachmentVersion.findFirst({
          where: { id: input.versionId, attachmentId: input.fileId, deletedAt: null },
        });
        if (!target) {
          throw new AppError(404, 'FILE_VERSION_NOT_FOUND', 'That file version does not exist');
        }
        const liveCount = await tx.attachmentVersion.count({
          where: { attachmentId: input.fileId, deletedAt: null },
        });
        if (liveCount === 1) {
          throw new AppError(409, 'LAST_VERSION', 'The last live version cannot be deleted');
        }

        const now = new Date();
        await tx.attachmentVersion.update({
          where: { id: target.id },
          data: { deletedAt: now, isCurrent: false, updatedAt: now },
        });

        if (target.isCurrent) {
          const promoted = await tx.attachmentVersion.findFirst({
            where: { attachmentId: input.fileId, deletedAt: null },
            orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
          });
          if (!promoted) {
            throw new AppError(409, 'LAST_VERSION', 'The last live version cannot be deleted');
          }
          await tx.attachmentVersion.update({
            where: { id: promoted.id },
            data: { isCurrent: true, updatedAt: now },
          });
          await tx.fileAttachment.update({
            where: { id: input.fileId },
            data: {
              fileName: promoted.fileName,
              mimeType: promoted.mimeType,
              sizeBytes: promoted.sizeBytes,
              updatedAt: now,
            },
          });
        }

        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: FileVersionAuditAction.Deleted,
          targetType: 'AttachmentVersion',
          targetId: target.id,
          metadata: {
            fileId: input.fileId,
            versionNumber: target.versionNumber,
            storageKey: target.storageKey,
          },
        });
        return target.storageKey;
      });
      await deleteStoredObject(deletedKey);
      return { ok: true };
    },

    async listFeedback(
      input: Input & { fileId: string; versionId: string; cursor?: string; limit: number },
    ): Promise<{ items: Array<ReturnType<typeof toFeedbackSummary>>; nextCursor: string | null }> {
      const { file } = await loadAttachment(input, 'view');
      const version = await prisma.attachmentVersion.findFirst({
        where: { id: input.versionId, attachmentId: file.id, deletedAt: null },
        select: { id: true },
      });
      if (!version) {
        throw new AppError(404, 'FILE_VERSION_NOT_FOUND', 'That file version does not exist');
      }
      const rows = await prisma.attachmentVersionFeedback.findMany({
        where: { attachmentVersionId: version.id, deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > input.limit;
      const items = (hasMore ? rows.slice(0, input.limit) : rows).map(toFeedbackSummary);
      return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
    },

    async createFeedback(
      input: Input & { fileId: string; versionId: string; body: string },
    ): Promise<{ feedback: ReturnType<typeof toFeedbackSummary> }> {
      const { file } = await loadAttachment(input, 'write');
      assertFeedbackBody(input.body);
      const feedback = await prisma.$transaction(async (tx) => {
        const version = await tx.attachmentVersion.findFirst({
          where: { id: input.versionId, attachmentId: file.id, deletedAt: null },
        });
        if (!version) {
          throw new AppError(404, 'FILE_VERSION_NOT_FOUND', 'That file version does not exist');
        }
        const created = await tx.attachmentVersionFeedback.create({
          data: {
            attachmentVersionId: version.id,
            authorId: input.userId,
            body: input.body,
          },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: FileVersionAuditAction.FeedbackCreated,
          targetType: 'AttachmentVersionFeedback',
          targetId: created.id,
          metadata: { fileId: file.id, attachmentVersionId: version.id },
        });
        return created;
      });
      return { feedback: toFeedbackSummary(feedback) };
    },

    async editFeedback(
      input: Input & { fileId: string; versionId: string; feedbackId: string; body: string },
    ): Promise<{ feedback: ReturnType<typeof toFeedbackSummary> }> {
      const { file } = await loadAttachment(input, 'write');
      assertFeedbackBody(input.body);
      const feedback = await prisma.$transaction(async (tx) => {
        const version = await tx.attachmentVersion.findFirst({
          where: { id: input.versionId, attachmentId: file.id, deletedAt: null },
          select: { id: true },
        });
        if (!version) {
          throw new AppError(404, 'FILE_VERSION_NOT_FOUND', 'That file version does not exist');
        }
        const existing = await tx.attachmentVersionFeedback.findFirst({
          where: {
            id: input.feedbackId,
            attachmentVersionId: version.id,
            deletedAt: null,
          },
        });
        if (!existing) {
          throw new AppError(404, 'FILE_FEEDBACK_NOT_FOUND', 'That feedback does not exist');
        }
        if (existing.authorId !== input.userId) {
          throw new AppError(403, 'FEEDBACK_FORBIDDEN', 'Only the author can edit this feedback');
        }
        const now = new Date();
        const updated = await tx.attachmentVersionFeedback.update({
          where: { id: existing.id },
          data: { body: input.body, editedAt: now, updatedAt: now },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: FileVersionAuditAction.FeedbackUpdated,
          targetType: 'AttachmentVersionFeedback',
          targetId: updated.id,
          metadata: { fileId: file.id, attachmentVersionId: version.id },
        });
        return updated;
      });
      return { feedback: toFeedbackSummary(feedback) };
    },

    async deleteFeedback(
      input: Input & { fileId: string; versionId: string; feedbackId: string },
    ): Promise<{ ok: true }> {
      const { workspace, file, authorization } = await loadAttachment(input, 'write');
      await prisma.$transaction(async (tx) => {
        const version = await tx.attachmentVersion.findFirst({
          where: { id: input.versionId, attachmentId: file.id, deletedAt: null },
          select: { id: true },
        });
        if (!version) {
          throw new AppError(404, 'FILE_VERSION_NOT_FOUND', 'That file version does not exist');
        }
        const existing = await tx.attachmentVersionFeedback.findFirst({
          where: {
            id: input.feedbackId,
            attachmentVersionId: version.id,
            deletedAt: null,
          },
        });
        if (!existing) {
          throw new AppError(404, 'FILE_FEEDBACK_NOT_FOUND', 'That feedback does not exist');
        }
        const isAuthor = existing.authorId === input.userId;
        const isWorkspaceAdmin =
          workspace.effectiveRole === 'OWNER' || workspace.effectiveRole === 'PROJECT_MANAGER';
        const isProjectAdmin =
          authorization?.isWorkspaceAdmin === true ||
          authorization?.permissions.includes(ProjectPermission.FileDeleteAny) === true;
        if (!isAuthor && !isWorkspaceAdmin && !isProjectAdmin) {
          throw new AppError(403, 'FEEDBACK_FORBIDDEN', 'Only the author or an admin can delete this feedback');
        }
        const now = new Date();
        await tx.attachmentVersionFeedback.update({
          where: { id: existing.id },
          data: { deletedAt: now, updatedAt: now },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: FileVersionAuditAction.FeedbackDeleted,
          targetType: 'AttachmentVersionFeedback',
          targetId: existing.id,
          metadata: { fileId: file.id, attachmentVersionId: version.id },
        });
      });
      return { ok: true };
    },

    async download(
      input: Input & { fileId: string },
    ): Promise<{ body: Buffer; contentType: string; fileName: string }> {
      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const file = await prisma.fileAttachment.findFirst({
        where: {
          id: input.fileId,
          workspaceId: input.workspaceId,
          deletedAt: null,
        },
      });

      if (!file) {
        throw new AppError(404, 'FILE_NOT_FOUND', 'That file does not exist');
      }

      // Enforce project-level access if the file belongs to a project
      if (file.projectId) {
        await authorizeProject(prisma, {
          actor: {
            userId: input.userId,
            workspaceId: input.workspaceId,
            workspaceRole: workspace.effectiveRole,
          },
          projectId: file.projectId,
          permission: ProjectPermission.View,
        });
      }

      // The attachment row keeps the legacy v1 storage key for compatibility;
      // downloads always use the current live version object and metadata.
      const version = await requireCurrentVersion(file.id);

      const result = await requireStorage().get(version.storageKey, {
        allowedContentTypes: ALLOWED_MIME_TYPES,
        maxReadBytes: Math.min(version.sizeBytes, MAX_FILE_SIZE_BYTES),
        tooLargeCode: 'FILE_VERSION_TOO_LARGE',
        tooLargeMessage: 'Stored file exceeds its recorded size',
        invalidContentTypeCode: 'FILE_VERSION_CONTENT_TYPE_INVALID',
        invalidContentTypeMessage: 'Stored file has an unsupported content type',
      });
      return {
        body: result.body,
        contentType: version.mimeType,
        fileName: version.fileName,
      };
    },

    async list(
      input: Input & {
        projectId?: string;
        taskId?: string;
        cursor?: string;
        limit: number;
      },
    ): Promise<{ items: FileSummary[]; nextCursor: string | null; totalBytes: number }> {
      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      if (input.projectId) {
        await authorizeProject(prisma, {
          actor: {
            userId: input.userId,
            workspaceId: input.workspaceId,
            workspaceRole: workspace.effectiveRole,
          },
          projectId: input.projectId,
          permission: ProjectPermission.View,
        });
      }

      const [files, totalBytesResult] = await Promise.all([
        prisma.fileAttachment.findMany({
          where: {
            workspaceId: input.workspaceId,
            deletedAt: null,
            ...(input.projectId ? { projectId: input.projectId } : {}),
            ...(input.taskId ? { taskId: input.taskId } : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        }),
        prisma.fileAttachment.aggregate({
          where: { workspaceId: input.workspaceId, deletedAt: null },
          _sum: { sizeBytes: true },
        }),
      ]);

      const hasMore = files.length > input.limit;
      const items = (hasMore ? files.slice(0, input.limit) : files).map(toSummary);
      const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;
      const totalBytes = totalBytesResult._sum.sizeBytes ?? 0;

      return { items, nextCursor, totalBytes };
    },

    async delete(input: Input & { fileId: string }): Promise<void> {
      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const file = await prisma.fileAttachment.findFirst({
        where: {
          id: input.fileId,
          workspaceId: input.workspaceId,
          deletedAt: null,
        },
      });

      if (!file) {
        throw new AppError(404, 'FILE_NOT_FOUND', 'That file does not exist');
      }

      const actor = {
        userId: input.userId,
        workspaceId: input.workspaceId,
        workspaceRole: workspace.effectiveRole,
      };

      if (file.projectId) {
        // Project files: a project manager (or workspace administrator) may
        // delete any file, otherwise only the uploader may delete their own.
        const authorization = await getProjectAuthorization(prisma, actor, file.projectId);
        assertProjectWritable(authorization.project);
        const permission = authorization.permissions.includes(ProjectPermission.FileDeleteAny)
          ? ProjectPermission.FileDeleteAny
          : ProjectPermission.FileDeleteOwn;
        await authorizeProject(prisma, {
          actor,
          projectId: file.projectId,
          permission,
          resource: { kind: 'file', fileId: file.id },
        });
      } else {
        // Workspace-level files keep the legacy rule: uploader or workspace
        // administrator.
        const isUploader = file.uploadedById === input.userId;
        const isAdmin =
          workspace.effectiveRole === 'OWNER' || workspace.effectiveRole === 'PROJECT_MANAGER';
        if (!isUploader && !isAdmin) {
          throw new AppError(
            403,
            'FILE_DELETE_FORBIDDEN',
            'You can only delete your own files',
          );
        }
      }

      const now = new Date();
      let versionKeys: string[] = [];
      await prisma.$transaction(async (tx) => {
        const liveVersions = await tx.attachmentVersion.findMany({
          where: { attachmentId: file.id, deletedAt: null },
          select: { id: true, storageKey: true },
        });
        versionKeys = liveVersions.map((version) => version.storageKey);
        await tx.attachmentVersion.updateMany({
          where: { attachmentId: file.id, deletedAt: null },
          data: { deletedAt: now, isCurrent: false, updatedAt: now },
        });
        await tx.fileAttachment.update({
          where: { id: file.id },
          data: { deletedAt: now },
        });

        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'file.deleted',
          targetType: 'FileAttachment',
          targetId: file.id,
          metadata: { fileName: file.fileName },
        });
      });

      // Objects belong to version rows; best-effort cleanup after commit.
      for (const key of versionKeys) {
        await deleteStoredObject(key);
      }
    },

    async getUsage(input: Input): Promise<{ totalBytes: number; fileCount: number }> {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const [agg, count] = await Promise.all([
        prisma.fileAttachment.aggregate({
          where: { workspaceId: input.workspaceId, deletedAt: null },
          _sum: { sizeBytes: true },
        }),
        prisma.fileAttachment.count({
          where: { workspaceId: input.workspaceId, deletedAt: null },
        }),
      ]);

      return { totalBytes: agg._sum.sizeBytes ?? 0, fileCount: count };
    },
  };
}

export type FileService = ReturnType<typeof createFileService>;
