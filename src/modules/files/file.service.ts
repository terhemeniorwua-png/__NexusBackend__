import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import type { PrivateObjectStorage } from '../../services/storage/private-object-storage';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { requireProjectAccess, ProjectCapability } from '../authorization/project.policy';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';

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
      throw new AppError(503, 'OBJECT_STORAGE_UNAVAILABLE', 'Private object storage is not configured');
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
        await requireProjectAccess(prisma, {
          userId: input.userId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          workspaceRole: workspace.effectiveRole,
          capability: ProjectCapability.ManageFiles,
        });
      }

      const store = requireStorage();
      const storageKey = `workspaces/${input.workspaceId}/files/${randomUUID()}/${input.fileName}`;

      await store.put({ key: storageKey, body: input.body, contentType: input.mimeType });

      const file = await prisma.$transaction(async (tx) => {
        const created = await tx.fileAttachment.create({
          data: {
            workspaceId: input.workspaceId,
            projectId: input.projectId ?? null,
            taskId: input.taskId ?? null,
            uploadedById: input.userId,
            fileName: input.fileName,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            storageKey,
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
            sizeBytes: input.sizeBytes,
            projectId: input.projectId ?? null,
            taskId: input.taskId ?? null,
          },
        });

        return created;
      });

      return toSummary(file);
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
        await requireProjectAccess(prisma, {
          userId: input.userId,
          workspaceId: input.workspaceId,
          projectId: file.projectId,
          workspaceRole: workspace.effectiveRole,
          capability: ProjectCapability.ViewFiles,
        });
      }

      const result = await requireStorage().get(file.storageKey);
      return { body: result.body, contentType: result.contentType, fileName: file.fileName };
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
        await requireProjectAccess(prisma, {
          userId: input.userId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          workspaceRole: workspace.effectiveRole,
          capability: ProjectCapability.ViewFiles,
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
      const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;
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

      // Only the uploader, project manager, or workspace owner/admin can delete
      const isUploader = file.uploadedById === input.userId;
      const isAdmin =
        workspace.effectiveRole === 'OWNER' || workspace.effectiveRole === 'PROJECT_MANAGER';
      if (!isUploader && !isAdmin) {
        throw new AppError(403, 'FILE_DELETE_FORBIDDEN', 'You can only delete your own files');
      }

      await prisma.$transaction(async (tx) => {
        await tx.fileAttachment.update({
          where: { id: file.id },
          data: { deletedAt: new Date() },
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

      // Best-effort delete from storage — failure doesn't fail the request
      await deleteStoredObject(file.storageKey);
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
