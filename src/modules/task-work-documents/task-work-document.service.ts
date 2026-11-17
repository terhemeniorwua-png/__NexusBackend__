import { Prisma, type PrismaClient } from '@prisma/client';
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
import type { WorkspaceAccessContext } from '../authorization/workspace.policy';
import type { ProjectAuthorizationResource, ProjectPermissionValue } from '../authorization';
import type { WorkspaceAccessContext } from '../authorization/workspace.policy';
import { MAX_CONTENT_BYTES } from './task-work-document.schemas';

type Input = { userId: string; workspaceId: string; context: WorkspaceAccessContext; projectId: string; taskId: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Minimal ProseMirror/TipTap JSON sanitizer: allow known node/mark shapes, strip unknown attrs/marks/types recursively.
const ALLOWED_MARKS = new Set(['bold', 'italic', 'link', 'strike', 'code', 'underline']);
const ALLOWED_NODES = new Set([
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
  'hardBreak',
  'blockquote',
  'codeBlock',
  'horizontalRule',
]);

function sanitizeMarks(marks: unknown): unknown[] | undefined {
  if (!Array.isArray(marks)) return undefined;
  const out: unknown[] = [];
  for (const mark of marks) {
    if (!isPlainObject(mark) || typeof mark.type !== 'string' || !ALLOWED_MARKS.has(mark.type)) continue;
    if (mark.type === 'link') {
      const href = isPlainObject(mark.attrs) && typeof mark.attrs.href === 'string' ? mark.attrs.href : '';
      const safeHref = /^(https?:|mailto:)/i.test(href) ? href : '';
      if (!safeHref) continue;
      out.push({ type: 'link', attrs: { href: safeHref, target: '_blank', rel: 'noopener noreferrer' } });
    } else {
      out.push({ type: mark.type });
    }
  }
  return out.length ? out : undefined;
}

function sanitizeNode(node: unknown): Record<string, unknown> | null {
  if (!isPlainObject(node) || typeof node.type !== 'string') return null;
  if (!ALLOWED_NODES.has(node.type)) return null;
  const out: Record<string, unknown> = { type: node.type };
  if (node.type === 'text') {
    if (typeof node.text !== 'string') return null;
    out.text = node.text;
    const marks = sanitizeMarks(node.marks);
    if (marks) out.marks = marks;
    return out;
  }
  if (node.type === 'heading') {
    const level = isPlainObject(node.attrs) && typeof node.attrs.level === 'number' ? node.attrs.level : 1;
    out.attrs = { level: Math.min(6, Math.max(1, Math.round(level))) };
  }
  if (node.type === 'tableCell' || node.type === 'tableHeader') {
    const attrs = isPlainObject(node.attrs) ? node.attrs : {};
    const colspan = typeof attrs.colspan === 'number' ? Math.max(1, Math.round(attrs.colspan)) : 1;
    const rowspan = typeof attrs.rowspan === 'number' ? Math.max(1, Math.round(attrs.rowspan)) : 1;
    out.attrs = { colspan, rowspan };
  }
  if (Array.isArray(node.content)) {
    const content = node.content.map(sanitizeNode).filter(Boolean) as Record<string, unknown>[];
    if (
      content.length ||
      node.type === 'doc' ||
      node.type === 'paragraph' ||
      node.type === 'tableRow' ||
      node.type === 'listItem' ||
      node.type === 'table' ||
      node.type === 'bulletList' ||
      node.type === 'orderedList' ||
      node.type === 'tableCell' ||
      node.type === 'tableHeader' ||
      node.type === 'blockquote' ||
      node.type === 'codeBlock'
    ) {
      out.content = content;
    }
  } else if (node.type === 'doc') {
    out.content = [];
  }
  return out;
}

export function sanitizeDocumentContent(input: unknown): Prisma.InputJsonValue {
  const root = sanitizeNode(input);
  const doc = root && root.type === 'doc' ? root : { type: 'doc', content: [] };
  const json = JSON.stringify(doc);
  if (Buffer.byteLength(json, 'utf8') > MAX_CONTENT_BYTES) {
    throw new AppError(400, 'DOCUMENT_TOO_LARGE', 'Document content exceeds the maximum allowed size');
  }
  return doc as Prisma.InputJsonValue;
}

function toSummary(doc: {
  id: string;
  taskId: string;
  title: string;
  createdById: string;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  createdBy: { id: string; name: string };
}) {
  return {
    id: doc.id,
    taskId: doc.taskId,
    title: doc.title,
    createdById: doc.createdById,
    createdBy: doc.createdBy,
    currentVersion: doc.currentVersion,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function createTaskWorkDocumentService(prisma: PrismaClient = getPrismaClient()) {
  const authorize = async (
    input: Input,
    permission: ProjectPermissionValue,
    resource?: ProjectAuthorizationResource,
  ) => {
    const workspace = await requireWorkspaceAccess(prisma, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
           context: (input as { context: WorkspaceAccessContext }).context,
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

  async function ensureTaskAccess(input: Input) {
    const access = await authorize(input, ProjectPermission.TaskView, {
      kind: 'task',
      taskId: input.taskId,
    });
    const task = await prisma.task.findFirst({
      where: { id: input.taskId, projectId: access.project.id, deletedAt: null },
      select: { id: true, key: true, projectId: true },
    });
    if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
    return { access, task };
  }

  async function canEdit(input: Input): Promise<boolean> {
    // Create/edit allowed for users with task.update or task assignees (per Phase 4A spec).
    await ensureTaskAccess(input);
    try {
      await authorize(input, ProjectPermission.TaskUpdate, { kind: 'task', taskId: input.taskId });
      return true;
    } catch {
      const assignee = await prisma.taskAssignee.findFirst({
        where: { taskId: input.taskId, userId: input.userId },
        select: { id: true },
      });
      return Boolean(assignee);
    }
  }

  return {
    async list(input: Input) {
      await ensureTaskAccess(input);
      const docs = await prisma.taskDocument.findMany({
        where: { taskId: input.taskId, deletedAt: null },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        include: { createdBy: { select: { id: true, name: true } } },
      });
      return { items: docs.map(toSummary) };
    },

    async create(input: Input & { title: string; content?: unknown }, context: RequestContext) {
      if (!(await canEdit(input))) {
        throw new AppError(
          403,
          'PERMISSION_DENIED',
          'You do not have permission to create work documents for this task',
          { requiredPermission: ProjectPermission.TaskUpdate },
        );
      }
      const content = sanitizeDocumentContent(input.content ?? { type: 'doc', content: [] });
      const created = await prisma.$transaction(async (tx) => {
        const doc = await tx.taskDocument.create({
          data: {
            taskId: input.taskId,
            title: input.title,
            createdById: input.userId,
            currentVersion: 1,
            versions: { create: { version: 1, content, savedById: input.userId } },
          },
          include: { createdBy: { select: { id: true, name: true } } },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.work_document.created',
          targetType: 'TaskDocument',
          targetId: doc.id,
          metadata: { taskId: input.taskId, projectId: input.projectId, title: doc.title, version: 1 },
          ...context,
        });
        return doc;
      });
      const latest = await prisma.taskDocumentVersion.findFirst({
        where: { documentId: created.id, version: created.currentVersion },
        select: { content: true },
      });
      return { ...toSummary(created), content: latest?.content ?? { type: 'doc', content: [] } };
    },

    async get(input: Input & { documentId: string }) {
      await ensureTaskAccess(input);
      const doc = await prisma.taskDocument.findFirst({
        where: { id: input.documentId, taskId: input.taskId, deletedAt: null },
        include: { createdBy: { select: { id: true, name: true } } },
      });
      if (!doc) throw new AppError(404, 'WORK_DOCUMENT_NOT_FOUND', 'That work document does not exist');
      const version = await prisma.taskDocumentVersion.findFirst({
        where: { documentId: doc.id, version: doc.currentVersion },
      });
      return { ...toSummary(doc), content: version?.content ?? { type: 'doc', content: [] } };
    },

    async update(
      input: Input & { documentId: string; baseVersion: number; content: unknown; title?: string; mode: 'autosave' | 'manual' },
      context: RequestContext,
    ) {
      if (!(await canEdit(input))) {
        throw new AppError(
          403,
          'PERMISSION_DENIED',
          'You do not have permission to edit this work document',
          { requiredPermission: ProjectPermission.TaskUpdate },
        );
      }
      const content = sanitizeDocumentContent(input.content);
      const existing = await prisma.taskDocument.findFirst({
        where: { id: input.documentId, taskId: input.taskId, deletedAt: null },
        include: { createdBy: { select: { id: true, name: true } } },
      });
      if (!existing) throw new AppError(404, 'WORK_DOCUMENT_NOT_FOUND', 'That work document does not exist');

      if (input.baseVersion !== existing.currentVersion) {
        const latest = await prisma.taskDocumentVersion.findFirst({
          where: { documentId: existing.id, version: existing.currentVersion },
        });
        throw new AppError(409, 'WORK_DOCUMENT_CONFLICT', 'This document was updated by someone else', {
          details: {
            currentVersion: existing.currentVersion,
            latestContent: latest?.content ?? { type: 'doc', content: [] },
            document: toSummary(existing),
          },
        });
      }

      // Autosave throttling: no more than one version per minute per user per document.
      if (input.mode === 'autosave') {
        const latestVersion = await prisma.taskDocumentVersion.findFirst({
          where: { documentId: existing.id, version: existing.currentVersion },
          select: { id: true, savedById: true, createdAt: true },
        });
        if (latestVersion && latestVersion.savedById === input.userId) {
          const ageMs = Date.now() - latestVersion.createdAt.getTime();
          if (ageMs < 60_000) {
            // Coalesce into the latest autosave version within window (persist content, no new version number)
            const updated = await prisma.$transaction(async (tx) => {
              await tx.taskDocumentVersion.update({ where: { id: latestVersion.id }, data: { content } });
              const doc = await tx.taskDocument.update({
                where: { id: existing.id },
                data: { ...(input.title ? { title: input.title } : {}), updatedAt: new Date() },
                include: { createdBy: { select: { id: true, name: true } } },
              });
              return doc;
            });
            return { ...toSummary(updated), content, throttled: true };
          }
        }
      }

      const result = await prisma.$transaction(async (tx) => {
        const nextVersion = existing.currentVersion + 1;
        await tx.taskDocumentVersion.create({
          data: { documentId: existing.id, version: nextVersion, content, savedById: input.userId },
        });
        const doc = await tx.taskDocument.update({
          where: { id: existing.id },
          data: { currentVersion: nextVersion, ...(input.title ? { title: input.title } : {}) },
          include: { createdBy: { select: { id: true, name: true } } },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.work_document.updated',
          targetType: 'TaskDocument',
          targetId: doc.id,
          metadata: { taskId: input.taskId, projectId: input.projectId, version: nextVersion, mode: input.mode },
          ...context,
        });
        return doc;
      });
      return { ...toSummary(result), content, throttled: false };
    },

    async listVersions(input: Input & { documentId: string }) {
      await ensureTaskAccess(input);
      const doc = await prisma.taskDocument.findFirst({
        where: { id: input.documentId, taskId: input.taskId, deletedAt: null },
        select: { id: true, currentVersion: true },
      });
      if (!doc) throw new AppError(404, 'WORK_DOCUMENT_NOT_FOUND', 'That work document does not exist');
      const versions = await prisma.taskDocumentVersion.findMany({
        where: { documentId: doc.id },
        orderBy: [{ version: 'desc' }],
        select: { id: true, version: true, savedById: true, createdAt: true, savedBy: { select: { id: true, name: true } } },
      });
      return { items: versions, currentVersion: doc.currentVersion };
    },

    async getVersion(input: Input & { documentId: string; version: number }) {
      await ensureTaskAccess(input);
      const doc = await prisma.taskDocument.findFirst({
        where: { id: input.documentId, taskId: input.taskId, deletedAt: null },
        select: { id: true },
      });
      if (!doc) throw new AppError(404, 'WORK_DOCUMENT_NOT_FOUND', 'That work document does not exist');
      const v = await prisma.taskDocumentVersion.findFirst({
        where: { documentId: doc.id, version: input.version },
        include: { savedBy: { select: { id: true, name: true } } },
      });
      if (!v) throw new AppError(404, 'WORK_DOCUMENT_VERSION_NOT_FOUND', 'That version does not exist');
      return { id: v.id, version: v.version, savedBy: v.savedBy, createdAt: v.createdAt, content: v.content };
    },

    async restore(input: Input & { documentId: string; version: number }, context: RequestContext) {
      if (!(await canEdit(input))) {
        throw new AppError(
          403,
          'PERMISSION_DENIED',
          'You do not have permission to restore this work document',
          { requiredPermission: ProjectPermission.TaskUpdate },
        );
      }
      const existing = await prisma.taskDocument.findFirst({
        where: { id: input.documentId, taskId: input.taskId, deletedAt: null },
        include: { createdBy: { select: { id: true, name: true } } },
      });
      if (!existing) throw new AppError(404, 'WORK_DOCUMENT_NOT_FOUND', 'That work document does not exist');
      const source = await prisma.taskDocumentVersion.findFirst({
        where: { documentId: existing.id, version: input.version },
        select: { content: true },
      });
      if (!source) throw new AppError(404, 'WORK_DOCUMENT_VERSION_NOT_FOUND', 'That version does not exist');

      const result = await prisma.$transaction(async (tx) => {
        const nextVersion = existing.currentVersion + 1;
        await tx.taskDocumentVersion.create({
          data: {
            documentId: existing.id,
            version: nextVersion,
            content: source.content as Prisma.InputJsonValue,
            savedById: input.userId,
          },
        });
        const doc = await tx.taskDocument.update({
          where: { id: existing.id },
          data: { currentVersion: nextVersion },
          include: { createdBy: { select: { id: true, name: true } } },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.work_document.restored',
          targetType: 'TaskDocument',
          targetId: doc.id,
          metadata: {
            taskId: input.taskId,
            projectId: input.projectId,
            restoredFrom: input.version,
            version: nextVersion,
          },
          ...context,
        });
        return doc;
      });
      return { ...toSummary(result), content: source.content };
    },

    async remove(input: Input & { documentId: string }, context: RequestContext) {
      // Delete is permission-controlled: require task.update (assignee-only without task.update cannot delete)
      await ensureTaskAccess(input);
      try {
        await authorize(input, ProjectPermission.TaskUpdate, { kind: 'task', taskId: input.taskId });
      } catch {
        throw new AppError(
          403,
          'PERMISSION_DENIED',
          'You do not have permission to delete this work document',
          { requiredPermission: ProjectPermission.TaskUpdate },
        );
      }
      const existing = await prisma.taskDocument.findFirst({
        where: { id: input.documentId, taskId: input.taskId, deletedAt: null },
        select: { id: true, title: true },
      });
      if (!existing) throw new AppError(404, 'WORK_DOCUMENT_NOT_FOUND', 'That work document does not exist');
      await prisma.$transaction(async (tx) => {
        await tx.taskDocument.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'task.work_document.deleted',
          targetType: 'TaskDocument',
          targetId: existing.id,
          metadata: { taskId: input.taskId, projectId: input.projectId, title: existing.title },
          ...context,
        });
      });
      return { id: existing.id, deleted: true };
    },
  };
}
