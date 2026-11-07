import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';

type Input = { userId: string; workspaceId: string };

export function createFormService(prisma: PrismaClient = getPrismaClient()) {
  return {
    async create(input: Input & { title: string; description?: string | null; isPublic?: boolean }) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.ViewWorkspace });
      return prisma.$transaction(async (tx) => {
        const form = await tx.form.create({ data: { workspaceId: input.workspaceId, createdById: input.userId, title: input.title, description: input.description ?? null, isPublic: input.isPublic ?? false }, include: { fields: { orderBy: { position: 'asc' } } } });
        await recordAuditEvent(tx, { workspaceId: input.workspaceId, actorId: input.userId, action: 'form.created', targetType: 'Form', targetId: form.id, metadata: { title: input.title } });
        return form;
      });
    },

    async get(input: Input & { formId: string }) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.ViewWorkspace });
      const form = await prisma.form.findFirst({ where: { id: input.formId, workspaceId: input.workspaceId, deletedAt: null }, include: { fields: { orderBy: { position: 'asc' } }, _count: { select: { responses: true } } } });
      if (!form) throw new AppError(404, 'FORM_NOT_FOUND', 'That form does not exist');
      return form;
    },

    async list(input: Input & { cursor?: string; limit: number; status?: string }) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.ViewWorkspace });
      const forms = await prisma.form.findMany({ where: { workspaceId: input.workspaceId, deletedAt: null, ...(input.status ? { status: input.status as 'DRAFT' | 'PUBLISHED' | 'CLOSED' | 'ARCHIVED' } : {}) }, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: input.limit + 1, ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}), include: { _count: { select: { responses: true } } } });
      const hasMore = forms.length > input.limit;
      return { items: hasMore ? forms.slice(0, input.limit) : forms, nextCursor: hasMore ? forms[input.limit - 1]?.id ?? null : null };
    },

    async update(input: Input & { formId: string; title?: string; description?: string | null; isPublic?: boolean; status?: string }) {
      const ws = await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.ViewWorkspace });
      const form = await prisma.form.findFirst({ where: { id: input.formId, workspaceId: input.workspaceId, deletedAt: null } });
      if (!form) throw new AppError(404, 'FORM_NOT_FOUND', 'That form does not exist');
      if (form.createdById !== input.userId && ws.effectiveRole !== 'OWNER' && ws.effectiveRole !== 'PROJECT_MANAGER') throw new AppError(403, 'FORM_EDIT_FORBIDDEN', 'Only the creator or a manager can edit');
      return prisma.$transaction(async (tx) => {
        const updated = await tx.form.update({ where: { id: form.id }, data: { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.isPublic !== undefined ? { isPublic: input.isPublic } : {}), ...(input.status !== undefined ? { status: input.status as 'DRAFT' | 'PUBLISHED' | 'CLOSED' | 'ARCHIVED' } : {}) }, include: { fields: { orderBy: { position: 'asc' } } } });
        await recordAuditEvent(tx, { workspaceId: input.workspaceId, actorId: input.userId, action: 'form.updated', targetType: 'Form', targetId: form.id });
        return updated;
      });
    },

    async delete(input: Input & { formId: string }) {
      const ws = await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.ViewWorkspace });
      const form = await prisma.form.findFirst({ where: { id: input.formId, workspaceId: input.workspaceId, deletedAt: null } });
      if (!form) throw new AppError(404, 'FORM_NOT_FOUND', 'That form does not exist');
      if (form.createdById !== input.userId && ws.effectiveRole !== 'OWNER' && ws.effectiveRole !== 'PROJECT_MANAGER') throw new AppError(403, 'FORM_DELETE_FORBIDDEN', 'Only the creator or a manager can delete');
      await prisma.form.update({ where: { id: form.id }, data: { deletedAt: new Date() } });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'form.deleted', targetType: 'Form', targetId: form.id });
    },

    async addField(input: Input & { formId: string; label: string; type: string; required?: boolean; options?: string[]; placeholder?: string | null; position?: number }) {
      const ws = await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.ViewWorkspace });
      const form = await prisma.form.findFirst({ where: { id: input.formId, workspaceId: input.workspaceId, deletedAt: null } });
      if (!form) throw new AppError(404, 'FORM_NOT_FOUND', 'That form does not exist');
      if (form.createdById !== input.userId && ws.effectiveRole !== 'OWNER' && ws.effectiveRole !== 'PROJECT_MANAGER') throw new AppError(403, 'FORM_EDIT_FORBIDDEN', 'Only the creator or a manager can add fields');
      return prisma.formField.create({ data: { formId: input.formId, label: input.label, type: input.type as 'TEXT' | 'TEXTAREA' | 'NUMBER' | 'EMAIL' | 'SELECT' | 'MULTISELECT' | 'RADIO' | 'CHECKBOX' | 'DATE' | 'RATING' | 'SCALE', required: input.required ?? false, options: input.options ?? [], placeholder: input.placeholder ?? null, position: input.position ?? 0 } });
    },

    async submitResponse(input: Input & { formId: string; answers: Array<{ fieldId: string; value: string }> }) {
      // For public forms, don't require workspace access
      const form = await prisma.form.findFirst({ where: { id: input.formId, deletedAt: null }, include: { fields: true } });
      if (!form) throw new AppError(404, 'FORM_NOT_FOUND', 'That form does not exist');
      if (form.status !== 'PUBLISHED') throw new AppError(409, 'FORM_NOT_PUBLISHED', 'This form is not accepting responses');
      if (!form.isPublic) { await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: form.workspaceId, capability: WorkspaceCapability.ViewWorkspace }); }

      // Validate required fields
      const fieldMap = new Map(form.fields.map((f) => [f.id, f]));
      for (const field of form.fields) {
        if (field.required) {
          const answer = input.answers.find((a) => a.fieldId === field.id);
          if (!answer || !answer.value.trim()) throw new AppError(400, 'FIELD_REQUIRED', `Field '${field.label}' is required`);
        }
      }

      return prisma.formResponse.create({ data: { formId: input.formId, submittedBy: input.userId, answers: { create: input.answers.map((a) => { const f = fieldMap.get(a.fieldId); if (!f) throw new AppError(400, 'FIELD_NOT_FOUND', 'Unknown field'); return { fieldId: a.fieldId, value: a.value }; }) } });
    },

    async listResponses(input: Input & { formId: string; cursor?: string; limit: number }) {
      const ws = await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.ViewWorkspace });
      const form = await prisma.form.findFirst({ where: { id: input.formId, workspaceId: input.workspaceId, deletedAt: null } });
      if (!form) throw new AppError(404, 'FORM_NOT_FOUND', 'That form does not exist');
      if (form.createdById !== input.userId && ws.effectiveRole !== 'OWNER' && ws.effectiveRole !== 'PROJECT_MANAGER') throw new AppError(403, 'FORM_ACCESS_DENIED', 'Only the creator or a manager can view responses');
      const responses = await prisma.formResponse.findMany({ where: { formId: input.formId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: input.limit + 1, ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}), include: { answers: { include: { field: { select: { label: true, type: true } } } } } });
      const hasMore = responses.length > input.limit;
      return { items: hasMore ? responses.slice(0, input.limit) : responses, nextCursor: hasMore ? responses[input.limit - 1]?.id ?? null : null };
    },
  };
}
