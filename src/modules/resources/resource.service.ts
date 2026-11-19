import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';

type RecentItemType = 'TASK' | 'DOCUMENT' | 'FILE' | 'BOOKMARK';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import type { PrivateObjectStorage } from '../../services/storage/private-object-storage';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  ProjectPermission,
  WorkspaceCapability,
  authorizeProject,
  getProjectAuthorization,
  requireWorkspaceAccess,
} from '../authorization';
import { extractTextFromUpload } from '../files/text-extraction';
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  RESOURCE_BATCH_MAX_FILES,
  RESOURCE_BATCH_MAX_TOTAL_BYTES,
  RESOURCE_FOLDER_MAX_DEPTH,
  RESOURCE_PATH_SEGMENT_MAX_LENGTH,
} from './resource.schemas';

type Input = { userId: string; workspaceId: string };
type Scope = { workspaceId: string; projectId: string | null };

const IMAGE_MIME_EXTENSIONS: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-powerpoint': ['.ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'text/plain': ['.txt', '.text', '.log'],
  'text/markdown': ['.md', '.markdown'],
  'text/csv': ['.csv'],
  'application/json': ['.json'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'image/svg+xml': ['.svg'],
  'application/zip': ['.zip'],
  'video/mp4': ['.mp4'],
  'video/webm': ['.webm'],
  'audio/mpeg': ['.mp3'],
  'audio/ogg': ['.ogg', '.oga'],
};

function extOf(name: string): string {
  return path.extname(name).toLowerCase();
}

function assertAllowedFile(fileName: string, mimeType: string, sizeBytes: number): void {
  if (!ALLOWED_MIME_TYPES.includes(mimeType as (typeof ALLOWED_MIME_TYPES)[number])) {
    throw new AppError(415, 'FILE_TYPE_NOT_ALLOWED', `File type '${mimeType}' is not permitted`);
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new AppError(413, 'FILE_TOO_LARGE', `File exceeds the ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB limit`);
  }
  const allowedExts = IMAGE_MIME_EXTENSIONS[mimeType];
  if (!allowedExts) {
    throw new AppError(415, 'FILE_TYPE_NOT_ALLOWED', `File type '${mimeType}' is not permitted`);
  }
  const ext = extOf(fileName);
  if (!ext || !allowedExts.includes(ext)) {
    throw new AppError(415, 'FILE_TYPE_NOT_ALLOWED', 'File extension does not match the allowed file type');
  }
}

function sanitizeName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new AppError(400, 'VALIDATION_ERROR', 'Name is required');
  if (trimmed.length > 255) throw new AppError(400, 'VALIDATION_ERROR', 'Name is too long');
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    throw new AppError(400, 'INVALID_NAME', 'Name contains invalid characters');
  }
  return trimmed;
}

function normalizeScope(projectId?: string | null): string | null {
  return projectId ?? null;
}

export function createResourceService(
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
      logger.warn('resource_file_object_delete_failed', { key, error });
    }
  }

  async function authorizeScopeView(input: Input & { projectId?: string | null }) {
    const workspace = await requireWorkspaceAccess(prisma, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });
    if (input.projectId) {
      await authorizeProject(prisma, {
        actor: { userId: input.userId, workspaceId: input.workspaceId, workspaceRole: workspace.effectiveRole },
        projectId: input.projectId,
        permission: ProjectPermission.View,
      });
    }
    return workspace;
  }

  async function authorizeScopeEdit(input: Input & { projectId?: string | null }) {
    const workspace = await requireWorkspaceAccess(prisma, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });
    if (input.projectId) {
      await authorizeProject(prisma, {
        actor: { userId: input.userId, workspaceId: input.workspaceId, workspaceRole: workspace.effectiveRole },
        projectId: input.projectId,
        permission: ProjectPermission.FileUpload,
      });
      return workspace;
    }
    // Workspace-wide: allow contributors (not pure viewers). OWNER/PROJECT_MANAGER/MEMBER are editors in practice.
    if (workspace.effectiveRole === 'VIEWER') {
      throw new AppError(403, 'INSUFFICIENT_ROLE', 'Your role does not allow modifying workspace resources');
    }
    return workspace;
  }

  async function assertFolderInScope(folderId: string, scope: Scope) {
    const folder = await prisma.resourceFolder.findFirst({
      where: { id: folderId, workspaceId: scope.workspaceId, projectId: scope.projectId },
      select: { id: true, parentId: true, workspaceId: true, projectId: true, name: true },
    });
    if (!folder) throw new AppError(404, 'RESOURCE_FOLDER_NOT_FOUND', 'That folder does not exist');
    return folder;
  }

  async function isDescendantFolder(folderId: string, maybeAncestorId: string): Promise<boolean> {
    if (folderId === maybeAncestorId) return true;
    let current: string | null = folderId;
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current)) return false;
      visited.add(current);
      const row: { parentId: string | null } | null = await prisma.resourceFolder.findUnique({
        where: { id: current },
        select: { parentId: true },
      });
      if (!row) return false;
      if (row.parentId === maybeAncestorId) return true;
      current = row.parentId;
    }
    return false;
  }

  async function countFolderSubtree(folderId: string): Promise<{ folders: number; files: number }> {
    // Count recursively via iterative BFS within same scope implied by folder relations (cascade delete on folder).
    let folders = 1;
    let files = 0;
    const queue: string[] = [folderId];
    while (queue.length) {
      const current = queue.shift()!;
      const [childFolders, fileCount] = await Promise.all([
        prisma.resourceFolder.findMany({ where: { parentId: current }, select: { id: true } }),
        prisma.resourceFile.count({ where: { folderId: current, deletedAt: null } }),
      ]);
      files += fileCount;
      for (const child of childFolders) {
        folders += 1;
        queue.push(child.id);
      }
    }
    return { folders, files };
  }

  function translateFolderUniqueError(error: unknown): never {
    if (error && typeof error === 'object' && 'code' in error && (error as any).code === 'P2002') {
      throw new AppError(409, 'RESOURCE_FOLDER_NAME_CONFLICT', 'A folder with this name already exists in this location');
    }
    throw error;
  }

  function mapFolder(row: any) {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId ?? null,
      parentId: row.parentId ?? null,
      name: row.name,
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function mapFile(row: any) {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId ?? null,
      folderId: row.folderId ?? null,
      name: row.name,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      uploadedById: row.uploadedById,
      createdAt: row.createdAt,
    };
  }

  function mapBookmark(row: any) {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId ?? null,
      title: row.title,
      url: row.url,
      createdById: row.createdById,
      createdAt: row.createdAt,
    };
  }

  async function canDeleteResource(input: Input & { projectId?: string | null; ownerId: string }) {
    const workspace = await requireWorkspaceAccess(prisma, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });
    if (input.projectId) {
      const auth = await getProjectAuthorization(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        workspaceRole: workspace.effectiveRole,
      }, input.projectId);
      const isUploader = input.ownerId === input.userId;
      const canAny = auth.permissions.includes(ProjectPermission.FileDeleteAny);
      const canOwn = auth.permissions.includes(ProjectPermission.FileDeleteOwn);
      if (canAny || (isUploader && canOwn)) return;
      throw new AppError(403, 'RESOURCE_DELETE_FORBIDDEN', 'You do not have permission to delete this resource');
    }
    const isOwner = input.ownerId === input.userId;
    const isAdmin = workspace.effectiveRole === 'OWNER' || workspace.effectiveRole === 'PROJECT_MANAGER';
    if (!isOwner && !isAdmin) {
      throw new AppError(403, 'RESOURCE_DELETE_FORBIDDEN', 'You do not have permission to delete this resource');
    }
  }

  return {
    // Folders
    async listFolders(input: Input & { projectId?: string | null; parentId?: string | null }) {
      await authorizeScopeView(input);
      const scopeProjectId = normalizeScope(input.projectId);
      const parentId = input.parentId ?? null;
      if (parentId) await assertFolderInScope(parentId, { workspaceId: input.workspaceId, projectId: scopeProjectId });
      const rows = await prisma.resourceFolder.findMany({
        where: { workspaceId: input.workspaceId, projectId: scopeProjectId, parentId },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      return { items: rows.map(mapFolder) };
    },

    async createFolder(input: Input & { projectId?: string | null; parentId?: string | null; name: string }) {
      await authorizeScopeEdit(input);
      const scopeProjectId = normalizeScope(input.projectId);
      const name = sanitizeName(input.name);
      const parentId = input.parentId ?? null;
      if (parentId) await assertFolderInScope(parentId, { workspaceId: input.workspaceId, projectId: scopeProjectId });
      try {
        const created = await prisma.$transaction(async (tx) => {
          const folder = await tx.resourceFolder.create({
            data: { workspaceId: input.workspaceId, projectId: scopeProjectId, parentId, name, createdById: input.userId },
          });
          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: 'resource.folder.created',
            targetType: 'ResourceFolder',
            targetId: folder.id,
            metadata: { projectId: scopeProjectId, parentId, name },
          });
          return folder;
        });
        return mapFolder(created);
      } catch (error) {
        translateFolderUniqueError(error);
      }
    },

    async renameFolder(input: Input & { projectId?: string | null; folderId: string; name: string }) {
      await authorizeScopeEdit(input);
      const scopeProjectId = normalizeScope(input.projectId);
      const folder = await assertFolderInScope(input.folderId, { workspaceId: input.workspaceId, projectId: scopeProjectId });
      const name = sanitizeName(input.name);
      try {
        const updated = await prisma.$transaction(async (tx) => {
          const row = await tx.resourceFolder.update({ where: { id: folder.id }, data: { name } });
          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: 'resource.folder.renamed',
            targetType: 'ResourceFolder',
            targetId: folder.id,
            metadata: { projectId: scopeProjectId, from: folder.name, to: name },
          });
          return row;
        });
        return mapFolder(updated);
      } catch (error) {
        translateFolderUniqueError(error);
      }
    },

    async moveFolder(input: Input & { projectId?: string | null; folderId: string; parentId: string | null }) {
      await authorizeScopeEdit(input);
      const scopeProjectId = normalizeScope(input.projectId);
      const folder = await assertFolderInScope(input.folderId, { workspaceId: input.workspaceId, projectId: scopeProjectId });
      const targetParentId = input.parentId ?? null;
      if (targetParentId === folder.id) {
        throw new AppError(400, 'INVALID_FOLDER_MOVE', 'A folder cannot be moved into itself');
      }
      if (targetParentId) {
        await assertFolderInScope(targetParentId, { workspaceId: input.workspaceId, projectId: scopeProjectId });
        if (await isDescendantFolder(targetParentId, folder.id)) {
          throw new AppError(400, 'INVALID_FOLDER_MOVE', 'A folder cannot be moved into its own descendant');
        }
      }
      try {
        const updated = await prisma.$transaction(async (tx) => {
          const row = await tx.resourceFolder.update({ where: { id: folder.id }, data: { parentId: targetParentId } });
          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: 'resource.folder.moved',
            targetType: 'ResourceFolder',
            targetId: folder.id,
            metadata: { projectId: scopeProjectId, fromParentId: folder.parentId, toParentId: targetParentId },
          });
          return row;
        });
        return mapFolder(updated);
      } catch (error) {
        translateFolderUniqueError(error);
      }
    },

    async getFolderDeleteImpact(input: Input & { projectId?: string | null; folderId: string }) {
      await authorizeScopeView(input);
      const scopeProjectId = normalizeScope(input.projectId);
      const folder = await assertFolderInScope(input.folderId, { workspaceId: input.workspaceId, projectId: scopeProjectId });
      const counts = await countFolderSubtree(folder.id);
      return { folderId: folder.id, name: folder.name, ...counts };
    },

    async deleteFolder(input: Input & { projectId?: string | null; folderId: string }) {
      const scopeProjectId = normalizeScope(input.projectId);
      const folder = await prisma.resourceFolder.findFirst({
        where: { id: input.folderId, workspaceId: input.workspaceId, projectId: scopeProjectId },
        select: { id: true, name: true, createdById: true },
      });
      if (!folder) throw new AppError(404, 'RESOURCE_FOLDER_NOT_FOUND', 'That folder does not exist');
      await canDeleteResource({ ...input, projectId: scopeProjectId, ownerId: folder.createdById });
      const impact = await countFolderSubtree(folder.id);
      // collect file storage keys for best-effort cleanup after DB delete (cascade will remove rows)
      const collectKeys = async (rootId: string): Promise<string[]> => {
        const keys: string[] = [];
        const q = [rootId];
        while (q.length) {
          const cur = q.shift()!;
          const [childFolders, files] = await Promise.all([
            prisma.resourceFolder.findMany({ where: { parentId: cur }, select: { id: true } }),
            prisma.resourceFile.findMany({ where: { folderId: cur }, select: { storageKey: true } }),
          ]);
          for (const f of files) keys.push(f.storageKey);
          for (const c of childFolders) q.push(c.id);
        }
        return keys;
      };
      const storageKeys = await collectKeys(folder.id);
      await prisma.$transaction(async (tx) => {
        await tx.resourceFolder.delete({ where: { id: folder.id } });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'resource.folder.deleted',
          targetType: 'ResourceFolder',
          targetId: folder.id,
          metadata: { projectId: scopeProjectId, name: folder.name, impact },
        });
      });
      await Promise.all(storageKeys.map((k) => deleteStoredObject(k)));
      return { deleted: true, folderId: folder.id, ...impact };
    },

    // Files
    async listFiles(input: Input & { projectId?: string | null; folderId?: string | null; cursor?: string; limit: number }) {
      await authorizeScopeView(input);
      const scopeProjectId = normalizeScope(input.projectId);
      const folderId = input.folderId === undefined ? undefined : (input.folderId ?? null);
      if (typeof folderId === 'string') {
        await assertFolderInScope(folderId, { workspaceId: input.workspaceId, projectId: scopeProjectId });
      }
      const where: Prisma.ResourceFileWhereInput = {
        workspaceId: input.workspaceId,
        projectId: scopeProjectId,
        deletedAt: null,
        ...(folderId !== undefined ? { folderId } : {}),
      };
      const rows = await prisma.resourceFile.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > input.limit;
      const items = (hasMore ? rows.slice(0, input.limit) : rows).map(mapFile);
      return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
    },

    async uploadFile(input: Input & {
      projectId?: string | null;
      folderId?: string | null;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      body: Buffer;
    }) {
      await authorizeScopeEdit(input);
      const scopeProjectId = normalizeScope(input.projectId);
      const folderId = input.folderId ?? null;
      if (folderId) await assertFolderInScope(folderId, { workspaceId: input.workspaceId, projectId: scopeProjectId });
      assertAllowedFile(input.fileName, input.mimeType, input.sizeBytes);
      const name = sanitizeName(input.fileName);
      const store = requireStorage();
      const storageKey = `workspaces/${input.workspaceId}/resources/${randomUUID()}/${name}`;
      await store.put({ key: storageKey, body: input.body, contentType: input.mimeType });
      try {
        const created = await prisma.$transaction(async (tx) => {
          const file = await tx.resourceFile.create({
            data: {
              workspaceId: input.workspaceId,
              projectId: scopeProjectId,
              folderId,
              name,
              mimeType: input.mimeType,
              sizeBytes: input.sizeBytes,
              storageKey,
              uploadedById: input.userId,
            },
          });
          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: 'resource.file.uploaded',
            targetType: 'ResourceFile',
            targetId: file.id,
            metadata: { projectId: scopeProjectId, folderId, name, mimeType: input.mimeType, sizeBytes: input.sizeBytes },
          });
          return file;
        });
        return mapFile(created);
      } catch (error) {
        await deleteStoredObject(storageKey);
        throw error;
      }
    },

    async renameFile(input: Input & { projectId?: string | null; fileId: string; name: string }) {
      await authorizeScopeEdit(input);
      const scopeProjectId = normalizeScope(input.projectId);
      const file = await prisma.resourceFile.findFirst({
        where: { id: input.fileId, workspaceId: input.workspaceId, projectId: scopeProjectId, deletedAt: null },
      });
      if (!file) throw new AppError(404, 'RESOURCE_FILE_NOT_FOUND', 'That file does not exist');
      const name = sanitizeName(input.name);
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.resourceFile.update({ where: { id: file.id }, data: { name } });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'resource.file.renamed',
          targetType: 'ResourceFile',
          targetId: file.id,
          metadata: { projectId: scopeProjectId, from: file.name, to: name },
        });
        return row;
      });
      return mapFile(updated);
    },

    async moveFile(input: Input & { projectId?: string | null; fileId: string; folderId: string | null }) {
      await authorizeScopeEdit(input);
      const scopeProjectId = normalizeScope(input.projectId);
      const file = await prisma.resourceFile.findFirst({
        where: { id: input.fileId, workspaceId: input.workspaceId, projectId: scopeProjectId, deletedAt: null },
      });
      if (!file) throw new AppError(404, 'RESOURCE_FILE_NOT_FOUND', 'That file does not exist');
      const folderId = input.folderId ?? null;
      if (folderId) await assertFolderInScope(folderId, { workspaceId: input.workspaceId, projectId: scopeProjectId });
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.resourceFile.update({ where: { id: file.id }, data: { folderId } });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'resource.file.moved',
          targetType: 'ResourceFile',
          targetId: file.id,
          metadata: { projectId: scopeProjectId, fromFolderId: file.folderId, toFolderId: folderId },
        });
        return row;
      });
      return mapFile(updated);
    },

    async downloadFile(input: Input & { projectId?: string | null; fileId: string }) {
      await authorizeScopeView(input);
      const scopeProjectId = normalizeScope(input.projectId);
      const file = await prisma.resourceFile.findFirst({
        where: { id: input.fileId, workspaceId: input.workspaceId, projectId: scopeProjectId, deletedAt: null },
      });
      if (!file) throw new AppError(404, 'RESOURCE_FILE_NOT_FOUND', 'That file does not exist');
      const result = await requireStorage().get(file.storageKey, {
        allowAnyContentType: true,
        maxReadBytes: Math.max(file.sizeBytes, 1),
        tooLargeCode: 'RESOURCE_FILE_TOO_LARGE',
        tooLargeMessage: 'Stored file exceeds the supported download size',
      });
      return { body: result.body, contentType: file.mimeType || result.contentType, fileName: file.name };
    },

    async deleteFile(input: Input & { projectId?: string | null; fileId: string }) {
      const scopeProjectId = normalizeScope(input.projectId);
      const file = await prisma.resourceFile.findFirst({
        where: { id: input.fileId, workspaceId: input.workspaceId, projectId: scopeProjectId, deletedAt: null },
      });
      if (!file) throw new AppError(404, 'RESOURCE_FILE_NOT_FOUND', 'That file does not exist');
      await canDeleteResource({ ...input, projectId: scopeProjectId, ownerId: file.uploadedById });
      await prisma.$transaction(async (tx) => {
        await tx.resourceFile.update({ where: { id: file.id }, data: { deletedAt: new Date() } });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'resource.file.deleted',
          targetType: 'ResourceFile',
          targetId: file.id,
          metadata: { projectId: scopeProjectId, name: file.name },
        });
      });
      await deleteStoredObject(file.storageKey);
      return { ok: true };
    },

    // Folder batch upload
    async uploadFolderBatch(input: Input & {
      projectId?: string | null;
      parentFolderId?: string | null;
      files: Array<{ relativePath: string; fileName: string; mimeType: string; sizeBytes: number; body: Buffer }>;
    }) {
      await authorizeScopeEdit(input);
      const scopeProjectId = normalizeScope(input.projectId);
      if (input.files.length === 0) throw new AppError(400, 'VALIDATION_ERROR', 'No files provided');
      if (input.files.length > RESOURCE_BATCH_MAX_FILES) {
        throw new AppError(400, 'RESOURCE_BATCH_TOO_LARGE', `A maximum of ${RESOURCE_BATCH_MAX_FILES} files is allowed per batch`);
      }
      const totalSize = input.files.reduce((sum, f) => sum + f.sizeBytes, 0);
      if (totalSize > RESOURCE_BATCH_MAX_TOTAL_BYTES) {
        throw new AppError(413, 'RESOURCE_BATCH_TOO_LARGE', 'Total batch size exceeds the allowed limit');
      }

      const baseParentId = input.parentFolderId ?? null;
      if (baseParentId) await assertFolderInScope(baseParentId, { workspaceId: input.workspaceId, projectId: scopeProjectId });

      function sanitizeRelativePath(raw: string): string[] {
        if (raw.includes('\\')) throw new AppError(400, 'INVALID_PATH', 'Backslashes are not allowed in paths');
        if (raw.includes('\0')) throw new AppError(400, 'INVALID_PATH', 'Paths contain invalid characters');
        if (/[\x00-\x1f\x7f]/.test(raw)) throw new AppError(400, 'INVALID_PATH', 'Paths contain control characters');
        if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new AppError(400, 'INVALID_PATH', 'Absolute paths are not allowed');
        const segments = raw.split('/').filter((s) => s.length > 0);
        if (segments.length === 0) throw new AppError(400, 'INVALID_PATH', 'Path is empty');
        if (segments.length > RESOURCE_FOLDER_MAX_DEPTH + 1) {
          throw new AppError(400, 'INVALID_PATH', `Path depth exceeds ${RESOURCE_FOLDER_MAX_DEPTH}`);
        }
        for (const seg of segments) {
          if (seg === '.' || seg === '..') throw new AppError(400, 'INVALID_PATH', 'Path traversal segments are not allowed');
          if (seg.length > RESOURCE_PATH_SEGMENT_MAX_LENGTH) throw new AppError(400, 'INVALID_PATH', 'Path segment is too long');
        }
        return segments;
      }

      // Validate and normalize all entries up front
      const normalized = input.files.map((f) => {
        const segments = sanitizeRelativePath(f.relativePath);
        const folderSegments = segments.slice(0, -1);
        const leafName = segments[segments.length - 1]!;
        if (folderSegments.length > RESOURCE_FOLDER_MAX_DEPTH) {
          throw new AppError(400, 'INVALID_PATH', `Folder depth exceeds ${RESOURCE_FOLDER_MAX_DEPTH}`);
        }
        assertAllowedFile(leafName, f.mimeType, f.sizeBytes);
        return { folderSegments, leafName, ...f };
      });

      // Ensure folder chains
      const folderCache = new Map<string, string>(); // key: parentId||name -> id
      async function ensureFolder(parentId: string | null, name: string): Promise<string> {
        const cacheKey = `${parentId ?? 'root'}::${name}`;
        const cached = folderCache.get(cacheKey);
        if (cached) return cached;
        const existing = await prisma.resourceFolder.findFirst({
          where: { workspaceId: input.workspaceId, projectId: scopeProjectId, parentId, name },
          select: { id: true },
        });
        if (existing) {
          folderCache.set(cacheKey, existing.id);
          return existing.id;
        }
        try {
          const created = await prisma.resourceFolder.create({
            data: { workspaceId: input.workspaceId, projectId: scopeProjectId, parentId, name, createdById: input.userId },
          });
          folderCache.set(cacheKey, created.id);
          return created.id;
        } catch (error: any) {
          if (error?.code === 'P2002') {
            const again = await prisma.resourceFolder.findFirst({
              where: { workspaceId: input.workspaceId, projectId: scopeProjectId, parentId, name },
              select: { id: true },
            });
            if (again) {
              folderCache.set(cacheKey, again.id);
              return again.id;
            }
          }
          throw error;
        }
      }

      const store = requireStorage();
      const createdFiles: any[] = [];
      const createdFolderIds = new Set<string>();

      for (const entry of normalized) {
        let currentParent = baseParentId;
        for (const seg of entry.folderSegments) {
          const existed = await prisma.resourceFolder.findFirst({
            where: { workspaceId: input.workspaceId, projectId: scopeProjectId, parentId: currentParent, name: seg },
            select: { id: true },
          });
          const folderId = await ensureFolder(currentParent, seg);
          if (!existed) createdFolderIds.add(folderId);
          currentParent = folderId;
        }
        const storageKey = `workspaces/${input.workspaceId}/resources/${randomUUID()}/${sanitizeName(entry.leafName!)}`;
        await store.put({ key: storageKey, body: entry.body, contentType: entry.mimeType });
        try {
          const file = await prisma.$transaction(async (tx) => {
            const row = await tx.resourceFile.create({
              data: {
                workspaceId: input.workspaceId,
                projectId: scopeProjectId,
                folderId: currentParent,
                name: sanitizeName(entry.leafName!),
                mimeType: entry.mimeType,
                sizeBytes: entry.sizeBytes,
                storageKey,
                uploadedById: input.userId,
              },
            });
            await recordAuditEvent(tx, {
              workspaceId: input.workspaceId,
              actorId: input.userId,
              action: 'resource.file.uploaded',
              targetType: 'ResourceFile',
              targetId: row.id,
              metadata: { projectId: scopeProjectId, folderId: currentParent, name: row.name, batch: true, relativePath: entry.relativePath },
            });
            return row;
          });
          createdFiles.push(mapFile(file));
        } catch (error) {
          await deleteStoredObject(storageKey);
          throw error;
        }
      }

      return { files: createdFiles, createdFoldersCount: createdFolderIds.size };
    },

    // Bookmarks
    async listBookmarks(input: Input & { projectId?: string | null; limit: number }) {
      await authorizeScopeView(input);
      const scopeProjectId = normalizeScope(input.projectId);
      const rows = await prisma.resourceBookmark.findMany({
        where: { workspaceId: input.workspaceId, projectId: scopeProjectId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit,
      });
      return { items: rows.map(mapBookmark) };
    },

    async createBookmark(input: Input & { projectId?: string | null; title: string; url: string }) {
      await authorizeScopeEdit(input);
      const scopeProjectId = normalizeScope(input.projectId);
      const title = input.title.trim();
      const url = input.url.trim();
      const created = await prisma.resourceBookmark.create({
        data: { workspaceId: input.workspaceId, projectId: scopeProjectId, title, url, createdById: input.userId },
      });
      return mapBookmark(created);
    },

    async updateBookmark(input: Input & { projectId?: string | null; bookmarkId: string; title?: string; url?: string }) {
      await authorizeScopeEdit(input);
      const scopeProjectId = normalizeScope(input.projectId);
      const bookmark = await prisma.resourceBookmark.findFirst({
        where: { id: input.bookmarkId, workspaceId: input.workspaceId, projectId: scopeProjectId },
      });
      if (!bookmark) throw new AppError(404, 'RESOURCE_BOOKMARK_NOT_FOUND', 'That bookmark does not exist');
      const updated = await prisma.resourceBookmark.update({
        where: { id: bookmark.id },
        data: {
          ...(input.title !== undefined ? { title: input.title.trim() } : {}),
          ...(input.url !== undefined ? { url: input.url.trim() } : {}),
        },
      });
      return mapBookmark(updated);
    },

    async deleteBookmark(input: Input & { projectId?: string | null; bookmarkId: string }) {
      const scopeProjectId = normalizeScope(input.projectId);
      const bookmark = await prisma.resourceBookmark.findFirst({
        where: { id: input.bookmarkId, workspaceId: input.workspaceId, projectId: scopeProjectId },
      });
      if (!bookmark) throw new AppError(404, 'RESOURCE_BOOKMARK_NOT_FOUND', 'That bookmark does not exist');
      await canDeleteResource({ ...input, projectId: scopeProjectId, ownerId: bookmark.createdById });
      await prisma.resourceBookmark.delete({ where: { id: bookmark.id } });
      return { ok: true };
    },

    // Recent items (project-scoped)
    async recordRecent(input: Input & { projectId: string; itemType: RecentItemType; itemId: string }) {
      await authorizeScopeView({ userId: input.userId, workspaceId: input.workspaceId, projectId: input.projectId });
      const now = new Date();
      await prisma.resourceRecentItem.upsert({
        where: {
          userId_projectId_itemType_itemId: {
            userId: input.userId,
            projectId: input.projectId,
            itemType: input.itemType,
            itemId: input.itemId,
          },
        },
        update: { openedAt: now },
        create: {
          userId: input.userId,
          projectId: input.projectId,
          itemType: input.itemType,
          itemId: input.itemId,
          openedAt: now,
        },
      });
      // Keep latest 50 per user per project
      const stale = await prisma.resourceRecentItem.findMany({
        where: { userId: input.userId, projectId: input.projectId },
        orderBy: { openedAt: 'desc' },
        skip: 50,
        select: { id: true },
      });
      if (stale.length > 0) {
        await prisma.resourceRecentItem.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
      }
      return { ok: true };
    },

    async listRecent(input: Input & { projectId: string; limit: number }) {
      await authorizeScopeView({ userId: input.userId, workspaceId: input.workspaceId, projectId: input.projectId });
      const items = await prisma.resourceRecentItem.findMany({
        where: { userId: input.userId, projectId: input.projectId },
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        take: Math.min(input.limit, 10),
      });
      return {
        items: items.map((i) => ({
          id: i.id,
          projectId: i.projectId,
          itemType: i.itemType,
          itemId: i.itemId,
          openedAt: i.openedAt,
        })),
      };
    },

    // Dashboard overview (project-scoped)
    async getProjectDashboardOverview(input: Input & { projectId: string }) {
      await authorizeScopeView({ userId: input.userId, workspaceId: input.workspaceId, projectId: input.projectId });

      const [recent, bookmarks, folders, files, taskDocs, tasks] = await Promise.all([
        prisma.resourceRecentItem.findMany({
          where: { userId: input.userId, projectId: input.projectId },
          orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
          take: 10,
        }),
        prisma.resourceBookmark.findMany({
          where: { workspaceId: input.workspaceId, projectId: input.projectId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 10,
        }),
        prisma.resourceFolder.findMany({
          where: { workspaceId: input.workspaceId, projectId: input.projectId, parentId: null },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          take: 50,
        }),
        prisma.resourceFile.findMany({
          where: { workspaceId: input.workspaceId, projectId: input.projectId, deletedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 10,
        }),
        prisma.taskDocument.findMany({
          where: { deletedAt: null, task: { projectId: input.projectId, deletedAt: null } },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: 10,
          include: {
            createdBy: { select: { id: true, name: true } },
            task: { select: { id: true, key: true, title: true } },
          },
        }),
        prisma.task.findMany({
          where: { projectId: input.projectId, deletedAt: null, archivedAt: null },
          select: {
            id: true,
            status: true,
            assignees: { select: { userId: true, user: { select: { id: true, name: true } } } },
          },
        }),
      ]);

      const statusMap = new Map<string, { status: string; total: number; assigneeMap: Map<string, { userId: string; name: string; count: number }> }>();
      for (const task of tasks) {
        let entry = statusMap.get(task.status);
        if (!entry) {
          entry = { status: task.status, total: 0, assigneeMap: new Map() };
          statusMap.set(task.status, entry);
        }
        entry.total += 1;
        if (task.assignees.length === 0) {
          const unassigned = entry.assigneeMap.get('__unassigned__') ?? { userId: '', name: 'Unassigned', count: 0 };
          unassigned.count += 1;
          entry.assigneeMap.set('__unassigned__', unassigned);
        } else {
          for (const a of task.assignees) {
            const existing = entry.assigneeMap.get(a.userId) ?? { userId: a.user.id, name: a.user.name, count: 0 };
            existing.count += 1;
            entry.assigneeMap.set(a.userId, existing);
          }
        }
      }
      const workloadByStatus = [...statusMap.values()]
        .sort((a, b) => a.status.localeCompare(b.status))
        .map((s) => ({
          status: s.status,
          total: s.total,
          assignees: [...s.assigneeMap.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        }));

      return {
        recent: recent.map((i) => ({ id: i.id, itemType: i.itemType, itemId: i.itemId, openedAt: i.openedAt })),
        docs: taskDocs.map((d) => ({
          id: d.id,
          taskId: d.taskId,
          taskKey: d.task.key,
          taskTitle: d.task.title,
          title: d.title,
          currentVersion: d.currentVersion,
          createdById: d.createdById,
          createdByName: d.createdBy.name,
          updatedAt: d.updatedAt,
        })),
        bookmarks: bookmarks.map(mapBookmark),
        folders: folders.map(mapFolder),
        files: files.map(mapFile),
        workloadByStatus,
      };
    },

    // Dashboard preferences (project-scoped)
    async getDashboardPreference(input: Input & { projectId: string }) {
      await authorizeScopeView({ userId: input.userId, workspaceId: input.workspaceId, projectId: input.projectId });
      const pref = await prisma.resourceDashboardPreference.findUnique({
        where: { userId_projectId: { userId: input.userId, projectId: input.projectId } },
      });
      return { cards: (pref?.cards as any[]) ?? [] };
    },

    async setDashboardPreference(input: Input & { projectId: string; cards: Array<{ id: string; visible: boolean; order: number }> }) {
      await authorizeScopeView({ userId: input.userId, workspaceId: input.workspaceId, projectId: input.projectId });
      const pref = await prisma.resourceDashboardPreference.upsert({
        where: { userId_projectId: { userId: input.userId, projectId: input.projectId } },
        update: { cards: input.cards as any },
        create: { userId: input.userId, projectId: input.projectId, cards: input.cards as any },
      });
      return { cards: pref.cards as any[] };
    },
  };
}

export type ResourceService = ReturnType<typeof createResourceService>;
