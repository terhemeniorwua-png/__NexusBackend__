import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { requireProjectAccess, ProjectCapability } from '../authorization/project.policy';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import { projectVisibleToUser } from '../projects/project-visibility';
import { assertProjectWritable } from '../projects/project-archive';

export interface DocumentSummary {
  id: string;
  workspaceId: string;
  projectId: string | null;
  taskId: string | null;
  title: string;
  content: string;
  authorId: string;
  authorName: string;
  revisionCount: number;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentCommentSummary {
  id: string;
  documentId: string;
  authorId: string;
  authorName: string;
  body: string;
  editedAt: string | null;
  createdAt: string;
}

type Input = { userId: string; workspaceId: string };

export function createDocumentService(prisma: PrismaClient = getPrismaClient()) {
  const include = {
    author: { select: { name: true } },
    _count: { select: { revisions: true, comments: true } },
  } as const;
  type IncludedDocument = Prisma.DocumentGetPayload<{ include: typeof include }>;

  function documentVisibilityWhere(input: { userId: string; workspaceId: string; organizationRole: string | null }) {
    const visible = projectVisibleToUser(input.userId);
    const scopedVisible = input.organizationRole
      ? visible
      : { OR: [{ workspaceId: input.workspaceId }, visible] };
    const sameWorkspaceVisible = { workspaceId: input.workspaceId, ...scopedVisible };
    return { AND: [
      { OR: [{ projectId: null }, { project: { is: sameWorkspaceVisible } }] },
      { OR: [{ taskId: null }, { task: { is: { project: { is: sameWorkspaceVisible } } } }] },
    ] };
  }

  async function documentProjectIds(input: {
    userId: string; workspaceId: string; projectId: string | null; taskId: string | null;
    workspaceRole: Parameters<typeof requireProjectAccess>[1]['workspaceRole'];
    capability: typeof ProjectCapability.ViewFiles | typeof ProjectCapability.ManageFiles;
    requireWritable?: boolean;
  }): Promise<string[]> {
    const projectIds = new Set<string>();
    if (input.projectId) projectIds.add(input.projectId);
    if (input.taskId) {
      const task = await prisma.task.findFirst({
        where: { id: input.taskId, deletedAt: null, project: { is: { workspaceId: input.workspaceId, deletedAt: null } } },
        select: { projectId: true },
      });
      if (!task) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'That document does not exist');
      if (input.projectId && input.projectId !== task.projectId) {
        throw new AppError(409, 'DOCUMENT_TARGET_MISMATCH', 'The document project and task must match');
      }
      projectIds.add(task.projectId);
    }
    for (const projectId of projectIds) {
      const access = await requireProjectAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId, projectId,
        workspaceRole: input.workspaceRole, capability: input.capability,
      });
      if (input.requireWritable) assertProjectWritable(access.project);
    }
    return [...projectIds];
  }

  function toSummary(row: {
    id: string; workspaceId: string; projectId: string | null; taskId: string | null;
    title: string; content: string; authorId: string; createdAt: Date; updatedAt: Date;
    author: { name: string }; _count: { revisions: number; comments: number };
  }): DocumentSummary {
    const { _count, author, ...doc } = row;
    return {
      ...doc,
      authorName: author.name,
      revisionCount: _count.revisions,
      commentCount: _count.comments,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  }

  return {
    async create(
      input: Input & { title: string; content?: string; projectId?: string | null; taskId?: string | null },
    ): Promise<DocumentSummary> {
      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const projectIds = await documentProjectIds({
        userId: input.userId, workspaceId: input.workspaceId,
        projectId: input.projectId ?? null, taskId: input.taskId ?? null,
        workspaceRole: workspace.effectiveRole, capability: ProjectCapability.ManageFiles,
        requireWritable: true,
      });

      const doc = await prisma.$transaction(async (tx) => {
        const created = await tx.document.create({
          data: {
            workspaceId: input.workspaceId,
            projectId: projectIds[0] ?? null,
            taskId: input.taskId ?? null,
            title: input.title,
            content: input.content ?? '',
            authorId: input.userId,
          },
          include,
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId, actorId: input.userId,
          action: 'document.created', targetType: 'Document', targetId: created.id,
          metadata: { title: input.title, projectId: projectIds[0] ?? null },
        });
        return created;
      });
      return toSummary(doc);
    },

    async get(input: Input & { documentId: string }): Promise<DocumentSummary> {
      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const doc = await prisma.document.findFirst({
        where: {
          id: input.documentId, workspaceId: input.workspaceId, deletedAt: null,
          ...documentVisibilityWhere({ userId: input.userId, workspaceId: input.workspaceId,
            organizationRole: workspace.membership.organizationRole }),
        },
        include,
      });
      if (!doc) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'That document does not exist');

      await documentProjectIds({
        userId: input.userId, workspaceId: input.workspaceId, projectId: doc.projectId,
        taskId: doc.taskId, workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.ViewFiles,
      });
      return toSummary(doc);
    },

    async list(
      input: Input & { projectId?: string; taskId?: string; search?: string; cursor?: string; limit: number },
    ): Promise<{ items: DocumentSummary[]; nextCursor: string | null }> {
      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      if (input.projectId) {
        await requireProjectAccess(prisma, {
          userId: input.userId, workspaceId: input.workspaceId,
          projectId: input.projectId, workspaceRole: workspace.effectiveRole,
          capability: ProjectCapability.ViewFiles,
        });
      }

      if (input.taskId) {
        const task = await prisma.task.findFirst({
          where: { id: input.taskId, deletedAt: null, project: { is: { workspaceId: input.workspaceId, deletedAt: null } } },
          select: { projectId: true },
        });
        if (!task || (input.projectId && input.projectId !== task.projectId))
          throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist in this workspace');
        await requireProjectAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId,
          projectId: task.projectId, workspaceRole: workspace.effectiveRole,
          capability: ProjectCapability.ViewFiles });
      }

      const where = { workspaceId: input.workspaceId, deletedAt: null,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.search ? { title: { contains: input.search, mode: 'insensitive' as const } } : {}),
      };
      const visibleDocs: IncludedDocument[] = [];
      let scanCursor = input.cursor;
      let exhausted = false;
      const scanSize = Math.min(Math.max(input.limit * 2, 25), 100);
      while (visibleDocs.length <= input.limit && !exhausted) {
        const candidates = await prisma.document.findMany({ where,
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: scanSize,
          ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}), include });
        if (!candidates.length) break;
        scanCursor = candidates[candidates.length - 1]!.id;
        exhausted = candidates.length < scanSize;
        for (const candidate of candidates) {
          try {
            await documentProjectIds({ userId: input.userId, workspaceId: input.workspaceId,
              projectId: candidate.projectId, taskId: candidate.taskId,
              workspaceRole: workspace.effectiveRole, capability: ProjectCapability.ViewFiles });
            visibleDocs.push(candidate);
          } catch (error) {
            if (error instanceof AppError && (error.statusCode === 403 || error.statusCode === 404)) continue;
            throw error;
          }
          if (visibleDocs.length > input.limit) break;
        }
      }
      const hasMore = visibleDocs.length > input.limit;
      const items = (hasMore ? visibleDocs.slice(0, input.limit) : visibleDocs).map(toSummary);
      const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;
      return { items, nextCursor };
    },

    async update(
      input: Input & { documentId: string; title?: string; content?: string },
    ): Promise<DocumentSummary> {
      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const doc = await prisma.document.findFirst({
        where: { id: input.documentId, workspaceId: input.workspaceId, deletedAt: null },
      });
      if (!doc) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'That document does not exist');

      const projectIds = await documentProjectIds({ userId: input.userId, workspaceId: input.workspaceId,
        projectId: doc.projectId, taskId: doc.taskId, workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.ManageFiles, requireWritable: true });
      if (projectIds.length === 0) {
        const isOwner = doc.authorId === input.userId;
        const isAdmin = workspace.effectiveRole === 'OWNER' || workspace.effectiveRole === 'PROJECT_MANAGER';
        if (!isOwner && !isAdmin) {
          throw new AppError(403, 'DOCUMENT_EDIT_FORBIDDEN', 'You can only edit your own documents');
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        // Save current content as a revision before overwriting
        if (input.content !== undefined && input.content !== doc.content) {
          await tx.documentRevision.create({
            data: { documentId: doc.id, content: doc.content, authorId: input.userId },
          });
        }
        const changed = await tx.document.update({
          where: { id: doc.id },
          data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.content !== undefined ? { content: input.content } : {}),
          },
          include,
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId, actorId: input.userId,
          action: 'document.updated', targetType: 'Document', targetId: doc.id,
          metadata: { title: input.title ?? doc.title },
        });
        return changed;
      });
      return toSummary(updated);
    },

    async delete(input: Input & { documentId: string }): Promise<void> {
      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const doc = await prisma.document.findFirst({
        where: { id: input.documentId, workspaceId: input.workspaceId, deletedAt: null },
      });
      if (!doc) throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'That document does not exist');

      const projectIds = await documentProjectIds({ userId: input.userId, workspaceId: input.workspaceId,
        projectId: doc.projectId, taskId: doc.taskId, workspaceRole: workspace.effectiveRole,
        capability: ProjectCapability.ManageFiles, requireWritable: true });

      const isOwner = doc.authorId === input.userId;
      const isAdmin = workspace.effectiveRole === 'OWNER' || workspace.effectiveRole === 'PROJECT_MANAGER';
      if (projectIds.length === 0 && !isOwner && !isAdmin) {
        throw new AppError(403, 'DOCUMENT_DELETE_FORBIDDEN', 'You can only delete your own documents');
      }

      await prisma.$transaction(async (tx) => {
        await tx.document.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId, actorId: input.userId,
          action: 'document.deleted', targetType: 'Document', targetId: doc.id,
          metadata: { title: doc.title },
        });
      });
    },

    async listRevisions(
      input: Input & { documentId: string },
    ): Promise<Array<{ id: string; authorId: string; authorName: string; content: string; createdAt: string }>> {
      await this.get(input); // Enforces access
      const revisions = await prisma.documentRevision.findMany({
        where: { documentId: input.documentId },
        orderBy: [{ createdAt: 'desc' }],
        include: { author: { select: { name: true } } },
      });
      return revisions.map((r) => ({
        id: r.id, authorId: r.authorId, authorName: r.author.name,
        content: r.content, createdAt: r.createdAt.toISOString(),
      }));
    },

    async addComment(
      input: Input & { documentId: string; body: string },
    ): Promise<DocumentCommentSummary> {
      await this.get(input); // Enforces access
      const doc = await prisma.document.findFirst({
        where: { id: input.documentId, workspaceId: input.workspaceId, deletedAt: null },
        select: { projectId: true, taskId: true },
      });
      if (doc && (doc.projectId || doc.taskId)) {
        const workspace = await requireWorkspaceAccess(prisma, {
          userId: input.userId, workspaceId: input.workspaceId,
          capability: WorkspaceCapability.ViewWorkspace,
        });
        await documentProjectIds({
          userId: input.userId, workspaceId: input.workspaceId,
          projectId: doc.projectId, taskId: doc.taskId,
          workspaceRole: workspace.effectiveRole, capability: ProjectCapability.ViewFiles,
          requireWritable: true,
        });
      }

      const comment = await prisma.$transaction(async (tx) => {
        const created = await tx.documentComment.create({
          data: { documentId: input.documentId, authorId: input.userId, body: input.body },
          include: { author: { select: { name: true } } },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId, actorId: input.userId,
          action: 'document.comment_created', targetType: 'DocumentComment', targetId: created.id,
          metadata: { documentId: input.documentId },
        });
        return created;
      });

      return {
        id: comment.id, documentId: comment.documentId,
        authorId: comment.authorId, authorName: comment.author.name,
        body: comment.body, editedAt: comment.editedAt?.toISOString() ?? null,
        createdAt: comment.createdAt.toISOString(),
      };
    },

    async listComments(
      input: Input & { documentId: string },
    ): Promise<DocumentCommentSummary[]> {
      await this.get(input); // Enforces access
      const comments = await prisma.documentComment.findMany({
        where: { documentId: input.documentId, deletedAt: null },
        orderBy: [{ createdAt: 'asc' }],
        include: { author: { select: { name: true } } },
      });
      return comments.map((c) => ({
        id: c.id, documentId: c.documentId,
        authorId: c.authorId, authorName: c.author.name,
        body: c.body, editedAt: c.editedAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
      }));
    },

    async deleteComment(
      input: Input & { documentId: string; commentId: string },
    ): Promise<void> {
      await this.get(input);
      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const doc = await prisma.document.findFirst({
        where: { id: input.documentId, workspaceId: input.workspaceId, deletedAt: null },
        select: { projectId: true, taskId: true },
      });
      if (doc && (doc.projectId || doc.taskId)) {
        await documentProjectIds({
          userId: input.userId, workspaceId: input.workspaceId,
          projectId: doc.projectId, taskId: doc.taskId,
          workspaceRole: workspace.effectiveRole, capability: ProjectCapability.ViewFiles,
          requireWritable: true,
        });
      }

      const comment = await prisma.documentComment.findFirst({
        where: { id: input.commentId, documentId: input.documentId, deletedAt: null },
      });
      if (!comment) throw new AppError(404, 'COMMENT_NOT_FOUND', 'That comment does not exist');

      const isAuthor = comment.authorId === input.userId;
      const isAdmin = workspace.effectiveRole === 'OWNER' || workspace.effectiveRole === 'PROJECT_MANAGER';
      if (!isAuthor && !isAdmin) {
        throw new AppError(403, 'COMMENT_DELETE_FORBIDDEN', 'You can only delete your own comments');
      }

      await prisma.$transaction(async (tx) => {
        await tx.documentComment.update({
          where: { id: comment.id },
          data: { deletedAt: new Date() },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'document.comment_deleted',
          targetType: 'DocumentComment',
          targetId: comment.id,
          metadata: { documentId: input.documentId },
        });
      });
    },
  };
}

export type DocumentService = ReturnType<typeof createDocumentService>;
