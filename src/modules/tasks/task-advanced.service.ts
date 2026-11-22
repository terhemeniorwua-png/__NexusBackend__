import { Prisma, type CustomFieldType, type PrismaClient, type ProjectStatus, type ProjectVisibility, type TaskPriority, type TaskStatus } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import { recordAuditEvent } from '../../services/audit';
import {
  ProjectPermission,
  authorizeProject,
  requireWorkspaceAccess,
  WorkspaceCapability,
} from '../authorization';
import { assertProjectWritable } from '../projects/project-archive';
import type { RequestContext } from '../auth/auth.types';
import type {
  CreateCustomFieldInput,
  CreateProjectTemplateInput,
  CreateSavedViewInput,
  CreateTaskTemplateInput,
  UpdateCustomFieldInput,
  UpdateProjectTemplateInput,
  UpdateSavedViewInput,
  UpdateTaskTemplateInput,
  UpsertRecurrenceInput,
} from './task-advanced.schemas';
import { generateTaskKey } from './task.service';

type Ctx = RequestContext;

type JsonValue = Prisma.InputJsonValue;
type CustomFieldOption = { value: string; label: string; color?: string };

// Templates are JSON and were historically cast straight to TaskStatus. Only
// pre-BE-7 statuses are valid initial states; AWAITING_CLARIFICATION must be
// reachable only through the clarification service.
const TEMPLATE_TASK_STATUSES: readonly TaskStatus[] = [
  'ASSIGNED',
  'IN_PROGRESS',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'CHANGES_REQUESTED',
];

function templateTaskStatus(value: unknown): TaskStatus {
  return typeof value === 'string' && (TEMPLATE_TASK_STATUSES as readonly string[]).includes(value)
    ? (value as TaskStatus)
    : 'ASSIGNED';
}

function slugifyKey(name: string): string {
  return (
    name
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_')
      .toLowerCase()
      .slice(0, 80) || 'field'
  );
}

function isIsoDateString(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function asOptions(value: unknown): CustomFieldOption[] {
  if (!Array.isArray(value)) return [];
  const out: CustomFieldOption[] = [];
  for (const o of value) {
    if (!o || typeof o !== 'object') continue;
    const rec = o as Record<string, unknown>;
    if (typeof rec.value !== 'string' || typeof rec.label !== 'string') continue;
    out.push({ value: rec.value, label: rec.label, color: typeof rec.color === 'string' ? rec.color : undefined });
  }
  return out;
}

function validateCustomFieldValue(
  type: string,
  value: unknown,
  options: unknown,
): { ok: boolean; normalized: JsonValue | null; message?: string } {
  if (value === null || value === undefined) return { ok: true, normalized: null };
  switch (type) {
    case 'TEXT':
      if (typeof value !== 'string') return { ok: false, normalized: null, message: 'Expected text value' };
      return { ok: true, normalized: value };
    case 'NUMBER':
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, normalized: null, message: 'Expected number value' };
      return { ok: true, normalized: value };
    case 'DATE':
      if (!isIsoDateString(value)) return { ok: false, normalized: null, message: 'Expected ISO date string value' };
      return { ok: true, normalized: new Date(value).toISOString() };
    case 'CHECKBOX':
      if (typeof value !== 'boolean') return { ok: false, normalized: null, message: 'Expected boolean value' };
      return { ok: true, normalized: value };
    case 'USER':
      if (typeof value !== 'string') return { ok: false, normalized: null, message: 'Expected user id string' };
      return { ok: true, normalized: value };
    case 'SELECT': {
      if (typeof value !== 'string') return { ok: false, normalized: null, message: 'Expected option value string' };
      const opts = asOptions(options).map((o) => o.value);
      if (opts.length && !opts.includes(value)) return { ok: false, normalized: null, message: 'Value is not a valid option' };
      return { ok: true, normalized: value };
    }
    case 'MULTI_SELECT': {
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        return { ok: false, normalized: null, message: 'Expected array of option values' };
      }
      const opts = asOptions(options).map((o) => o.value);
      if (opts.length) {
        for (const v of value) if (!opts.includes(v)) return { ok: false, normalized: null, message: `Value "${v}" is not a valid option` };
      }
      const uniq = [...new Set(value)];
      return { ok: true, normalized: uniq };
    }
    default:
      return { ok: false, normalized: null, message: 'Unsupported field type' };
  }
}

async function authorizeProjectAccess(
  prisma: PrismaClient,
  input: { userId: string; workspaceId: string; projectId: string },
  permission: (typeof ProjectPermission)[keyof typeof ProjectPermission],
  resource?: { kind: 'task'; taskId: string },
) {
  const workspace = await requireWorkspaceAccess(prisma, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    capability: WorkspaceCapability.ViewWorkspace,
  });
  return authorizeProject(prisma, {
    actor: { userId: input.userId, workspaceId: input.workspaceId, workspaceRole: workspace.effectiveRole },
    projectId: input.projectId,
    permission,
    ...(resource ? { resource } : {}),
  });
}

function computeNextRunAt(
  rule: { frequency: string; interval: number; daysOfWeek?: number[]; dayOfMonth?: number | null; nextRunAt?: Date | null },
  from: Date,
): Date | null {
  const base = rule.nextRunAt && rule.nextRunAt > from ? new Date(rule.nextRunAt) : new Date(from);
  const d = new Date(base);
  const interval = Math.max(1, rule.interval || 1);
  if (rule.frequency === 'DAILY') {
    d.setUTCDate(d.getUTCDate() + interval);
    return d;
  }
  if (rule.frequency === 'WEEKLY') {
    const days = rule.daysOfWeek && rule.daysOfWeek.length ? [...rule.daysOfWeek].sort((a, b) => a - b) : [d.getUTCDay()];
    for (let step = 1; step <= 7 * interval + 7; step++) {
      const cand = new Date(base);
      cand.setUTCDate(cand.getUTCDate() + step);
      if (days.includes(cand.getUTCDay())) {
        if (step >= 1) return cand;
      }
    }
    d.setUTCDate(d.getUTCDate() + 7 * interval);
    return d;
  }
  if (rule.frequency === 'MONTHLY') {
    const dom = rule.dayOfMonth && rule.dayOfMonth >= 1 && rule.dayOfMonth <= 31 ? rule.dayOfMonth : d.getUTCDate();
    const cand = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + interval, 1));
    const last = new Date(Date.UTC(cand.getUTCFullYear(), cand.getUTCMonth() + 1, 0)).getUTCDate();
    cand.setUTCDate(Math.min(dom, last));
    cand.setUTCHours(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), 0);
    return cand;
  }
  return null;
}

type RecurrenceGenerationResult =
  | { status: 'generated'; task: unknown }
  | { status: 'skipped_inactive' | 'skipped_complete' | 'skipped_ended' | 'skipped_not_due' | 'claimed_by_other' | 'skipped_missing' };

async function generateRecurrenceInstanceForRule(
  prisma: PrismaClient,
  ruleId: string,
  options: { now: Date; actorId: string | null; context?: Ctx; requireDue: boolean },
): Promise<RecurrenceGenerationResult> {
  const rule = await prisma.taskRecurrenceRule.findUnique({
    where: { id: ruleId },
    include: {
      task: {
        include: {
          customFieldValues: true,
          project: { select: { id: true, key: true, workspaceId: true } },
        },
      },
    },
  });
  if (!rule || !rule.task || rule.task.deletedAt) return { status: 'skipped_missing' };
  if (!rule.active) return { status: 'skipped_inactive' };
  if (rule.maxOccurrences && rule.occurrenceCount >= rule.maxOccurrences) return { status: 'skipped_complete' };
  if (rule.endsAt && rule.endsAt.getTime() < options.now.getTime()) return { status: 'skipped_ended' };

  const source = rule.task;
  const dueBase = source.dueDate ?? source.startDate ?? options.now;
  const scheduledFor = rule.nextRunAt ?? computeNextRunAt(rule, dueBase) ?? options.now;
  if (options.requireDue && scheduledFor.getTime() > options.now.getTime()) return { status: 'skipped_not_due' };

  const durationMs = source.startDate && source.dueDate ? source.dueDate.getTime() - source.startDate.getTime() : 0;
  const nextStart = source.startDate ? new Date(scheduledFor.getTime() - durationMs) : null;
  const nextDue = source.dueDate ? new Date(scheduledFor) : (source.startDate ? new Date(scheduledFor) : null);
  const actorId = options.actorId ?? source.creatorId;
  const workspaceId = source.project.workspaceId;
  const projectId = source.project.id;
  const sourceSeriesId = source.recurrenceSourceId ?? source.id;

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.taskRecurrenceRule.updateMany({
      where: {
        id: rule.id,
        active: true,
        occurrenceCount: rule.occurrenceCount,
        ...(rule.nextRunAt ? { nextRunAt: rule.nextRunAt } : { nextRunAt: null }),
      },
      data: { updatedAt: options.now },
    });
    if (claimed.count !== 1) return { status: 'claimed_by_other' };

    const key = await generateTaskKey(tx, projectId, source.project.key);
    const task = await tx.task.create({
      data: {
        projectId,
        key,
        title: source.title,
        description: source.description,
        status: 'ASSIGNED',
        priority: source.priority,
        category: source.category,
        labels: source.labels,
        startDate: nextStart,
        dueDate: nextDue,
        creatorId: actorId,
        recurrenceSourceId: sourceSeriesId,
      },
    });

    if (source.customFieldValues.length) {
      await tx.taskCustomFieldValue.createMany({
        data: source.customFieldValues.map((v) => ({ taskId: task.id, fieldId: v.fieldId, value: v.value as Prisma.InputJsonValue })),
        skipDuplicates: true,
      });
    }

    const newCount = rule.occurrenceCount + 1;
    const following = computeNextRunAt(rule, nextDue ?? scheduledFor);
    const shouldDeactivate = Boolean(
      (rule.maxOccurrences && newCount >= rule.maxOccurrences) ||
        (rule.endsAt && following && following.getTime() > rule.endsAt.getTime()) ||
        (rule.endsAt && scheduledFor.getTime() > rule.endsAt.getTime()),
    );

    await tx.taskRecurrenceRule.update({
      where: { id: rule.id },
      data: {
        occurrenceCount: newCount,
        nextRunAt: shouldDeactivate ? null : following,
        active: shouldDeactivate ? false : rule.active,
      },
    });

    await recordAuditEvent(tx, {
      workspaceId,
      actorId,
      action: 'task.recurrence_generated',
      targetType: 'Task',
      targetId: task.id,
      metadata: {
        projectId,
        sourceTaskId: source.id,
        key: task.key,
        recurrenceRuleId: rule.id,
        occurrence: newCount,
        scheduledFor: scheduledFor.toISOString(),
        automatic: !options.actorId || options.actorId === source.creatorId,
      },
      ...(options.context ?? {}),
    });

    return { status: 'generated', task };
  });
}

export function createTaskAdvancedService(prisma: PrismaClient = getPrismaClient()) {
  return {
    // Custom fields
    async listCustomFields(input: { userId: string; workspaceId: string; projectId: string }) {
      await authorizeProjectAccess(prisma, input, ProjectPermission.TaskView);
      return prisma.projectCustomField.findMany({
        where: { projectId: input.projectId },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      });
    },

    async createCustomField(input: { userId: string; workspaceId: string; projectId: string } & CreateCustomFieldInput, context: Ctx) {
      const access = await authorizeProjectAccess(prisma, input, ProjectPermission.Update);
      assertProjectWritable(access.project);
      const keyBase = input.key || slugifyKey(input.name);
      let key = keyBase;
      for (let i = 0; i < 50; i++) {
        const exists = await prisma.projectCustomField.findUnique({ where: { projectId_key: { projectId: input.projectId, key } }, select: { id: true } });
        if (!exists) break;
        key = `${keyBase}_${i + 2}`;
      }
      const field = await prisma.projectCustomField.create({
        data: {
          projectId: input.projectId,
          name: input.name,
          key,
          type: input.type,
          description: input.description ?? null,
          options: input.options === undefined || input.options === null ? Prisma.DbNull : (input.options as unknown as Prisma.InputJsonValue),
          required: input.required ?? false,
          position: input.position ?? 0,
          createdById: input.userId,
        },
      });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'project.custom_field_created', targetType: 'ProjectCustomField', targetId: field.id, metadata: { projectId: input.projectId, key: field.key, type: field.type }, ...context });
      return field;
    },

    async updateCustomField(input: { userId: string; workspaceId: string; projectId: string; fieldId: string } & UpdateCustomFieldInput, context: Ctx) {
      const access = await authorizeProjectAccess(prisma, input, ProjectPermission.Update);
      assertProjectWritable(access.project);
      const existing = await prisma.projectCustomField.findFirst({ where: { id: input.fieldId, projectId: input.projectId } });
      if (!existing) throw new AppError(404, 'CUSTOM_FIELD_NOT_FOUND', 'Custom field not found');
      const field = await prisma.projectCustomField.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.options !== undefined ? { options: input.options === null ? Prisma.DbNull : (input.options as unknown as Prisma.InputJsonValue) } : {}),
          ...(input.required !== undefined ? { required: input.required } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
        },
      });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'project.custom_field_updated', targetType: 'ProjectCustomField', targetId: field.id, metadata: { projectId: input.projectId }, ...context });
      return field;
    },

    async deleteCustomField(input: { userId: string; workspaceId: string; projectId: string; fieldId: string }, context: Ctx) {
      const access = await authorizeProjectAccess(prisma, input, ProjectPermission.Update);
      assertProjectWritable(access.project);
      const existing = await prisma.projectCustomField.findFirst({ where: { id: input.fieldId, projectId: input.projectId } });
      if (!existing) throw new AppError(404, 'CUSTOM_FIELD_NOT_FOUND', 'Custom field not found');
      await prisma.projectCustomField.delete({ where: { id: existing.id } });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'project.custom_field_deleted', targetType: 'ProjectCustomField', targetId: existing.id, metadata: { projectId: input.projectId, key: existing.key }, ...context });
      return { id: existing.id, deleted: true };
    },

    async setTaskCustomFieldValues(
      input: { userId: string; workspaceId: string; projectId: string; taskId: string; values: Array<{ fieldId: string; value?: unknown }> },
      context: Ctx,
    ) {
      const access = await authorizeProjectAccess(prisma, input, ProjectPermission.TaskUpdate, { kind: 'task', taskId: input.taskId });
      assertProjectWritable(access.project);
      const task = await prisma.task.findFirst({ where: { id: input.taskId, projectId: input.projectId, deletedAt: null }, select: { id: true } });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      const fieldIds = [...new Set(input.values.map((v) => v.fieldId))];
      const fields = await prisma.projectCustomField.findMany({ where: { id: { in: fieldIds }, projectId: input.projectId } });
      const byId = new Map(fields.map((f) => [f.id, f]));
      const writes = [] as ReturnType<typeof prisma.taskCustomFieldValue.upsert>[];
      for (const item of input.values) {
        const field = byId.get(item.fieldId);
        if (!field) throw new AppError(400, 'CUSTOM_FIELD_INVALID', `Custom field ${item.fieldId} is not valid for this project`);
        const v = validateCustomFieldValue(field.type, item.value, field.options);
        if (!v.ok) throw new AppError(400, 'CUSTOM_FIELD_VALUE_INVALID', v.message || 'Invalid custom field value', { details: { fieldId: field.id, key: field.key } });
        if (field.required && (v.normalized === null || v.normalized === undefined || v.normalized === '')) {
          throw new AppError(400, 'CUSTOM_FIELD_REQUIRED', `Custom field "${field.name}" is required`, { details: { fieldId: field.id } });
        }
        writes.push(
          prisma.taskCustomFieldValue.upsert({
            where: { taskId_fieldId: { taskId: task.id, fieldId: field.id } },
            create: { taskId: task.id, fieldId: field.id, value: v.normalized === null ? Prisma.DbNull : v.normalized },
            update: { value: v.normalized === null ? Prisma.DbNull : v.normalized },
            include: { field: true },
          }),
        );
      }
      const results = writes.length ? await prisma.$transaction(writes) : [];
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'task.custom_fields_updated', targetType: 'Task', targetId: task.id, metadata: { projectId: input.projectId, fieldIds }, ...context });
      return { taskId: task.id, values: results };
    },

    async getTaskCustomFieldValues(input: { userId: string; workspaceId: string; projectId: string; taskId: string }) {
      await authorizeProjectAccess(prisma, input, ProjectPermission.TaskView, { kind: 'task', taskId: input.taskId });
      const task = await prisma.task.findFirst({ where: { id: input.taskId, projectId: input.projectId, deletedAt: null }, select: { id: true } });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      return prisma.taskCustomFieldValue.findMany({ where: { taskId: task.id }, include: { field: true }, orderBy: { field: { position: 'asc' } } });
    },

    // Saved views
    async listSavedViews(input: { userId: string; workspaceId: string; projectId: string }) {
      await authorizeProjectAccess(prisma, input, ProjectPermission.TaskView);
      return prisma.taskSavedView.findMany({
        where: { projectId: input.projectId, OR: [{ ownerId: input.userId }, { isShared: true }] },
        orderBy: [{ isShared: 'desc' }, { updatedAt: 'desc' }],
      });
    },

    async createSavedView(input: { userId: string; workspaceId: string; projectId: string } & CreateSavedViewInput, context: Ctx) {
      const access = await authorizeProjectAccess(prisma, input, ProjectPermission.TaskView);
      assertProjectWritable(access.project);
      const view = await prisma.taskSavedView.create({
        data: {
          projectId: input.projectId,
          ownerId: input.userId,
          name: input.name,
          isShared: input.isShared ?? false,
          config: input.config as unknown as Prisma.InputJsonValue,
        },
      });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'project.task_view_created', targetType: 'TaskSavedView', targetId: view.id, metadata: { projectId: input.projectId, isShared: view.isShared }, ...context });
      return view;
    },

    async updateSavedView(input: { userId: string; workspaceId: string; projectId: string; viewId: string } & UpdateSavedViewInput, context: Ctx) {
      const access = await authorizeProjectAccess(prisma, input, ProjectPermission.TaskView);
      assertProjectWritable(access.project);
      const existing = await prisma.taskSavedView.findFirst({ where: { id: input.viewId, projectId: input.projectId } });
      if (!existing) throw new AppError(404, 'SAVED_VIEW_NOT_FOUND', 'Saved view not found');
      if (existing.ownerId !== input.userId) {
        if (!existing.isShared) {
          throw new AppError(403, 'PERMISSION_DENIED', 'You do not have access to modify this view');
        }
        await authorizeProjectAccess(prisma, input, ProjectPermission.Update);
      }
      const mergedConfig = input.config !== undefined
        ? { ...((existing.config as Record<string, unknown>) || { version: 1, filters: {}, sort: null, group: null }), ...(input.config as Record<string, unknown>), version: 1 }
        : undefined;
      const view = await prisma.taskSavedView.update({
        where: { id: existing.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.isShared !== undefined ? { isShared: input.isShared } : {}),
          ...(mergedConfig !== undefined ? { config: mergedConfig as unknown as Prisma.InputJsonValue } : {}),
        },
      });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'project.task_view_updated', targetType: 'TaskSavedView', targetId: view.id, metadata: { projectId: input.projectId }, ...context });
      return view;
    },

    async deleteSavedView(input: { userId: string; workspaceId: string; projectId: string; viewId: string }, context: Ctx) {
      const access = await authorizeProjectAccess(prisma, input, ProjectPermission.TaskView);
      assertProjectWritable(access.project);
      const existing = await prisma.taskSavedView.findFirst({ where: { id: input.viewId, projectId: input.projectId } });
      if (!existing) throw new AppError(404, 'SAVED_VIEW_NOT_FOUND', 'Saved view not found');
      if (existing.ownerId !== input.userId) {
        if (!existing.isShared) {
          throw new AppError(403, 'PERMISSION_DENIED', 'You do not have access to delete this view');
        }
        await authorizeProjectAccess(prisma, input, ProjectPermission.Update);
      }
      await prisma.taskSavedView.delete({ where: { id: existing.id } });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'project.task_view_deleted', targetType: 'TaskSavedView', targetId: existing.id, metadata: { projectId: input.projectId }, ...context });
      return { id: existing.id, deleted: true };
    },

    // Recurrence
    async getRecurrence(input: { userId: string; workspaceId: string; projectId: string; taskId: string }) {
      await authorizeProjectAccess(prisma, input, ProjectPermission.TaskView, { kind: 'task', taskId: input.taskId });
      const rule = await prisma.taskRecurrenceRule.findUnique({ where: { taskId: input.taskId } });
      if (!rule) throw new AppError(404, 'RECURRENCE_NOT_FOUND', 'Recurrence rule not found');
      return rule;
    },

    async upsertRecurrence(input: { userId: string; workspaceId: string; projectId: string; taskId: string } & UpsertRecurrenceInput, context: Ctx) {
      const access = await authorizeProjectAccess(prisma, input, ProjectPermission.TaskUpdate, { kind: 'task', taskId: input.taskId });
      assertProjectWritable(access.project);
      const task = await prisma.task.findFirst({ where: { id: input.taskId, projectId: input.projectId, deletedAt: null }, select: { id: true, dueDate: true } });
      if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      const from = task.dueDate ?? new Date();
      const baseRule = { frequency: input.frequency, interval: input.interval ?? 1, daysOfWeek: input.daysOfWeek ?? [], dayOfMonth: input.dayOfMonth ?? null, nextRunAt: input.nextRunAt ? new Date(input.nextRunAt) : null };
      const nextRunAt = baseRule.nextRunAt ?? computeNextRunAt(baseRule, from);
      const rule = await prisma.taskRecurrenceRule.upsert({
        where: { taskId: task.id },
        create: {
          taskId: task.id,
          frequency: input.frequency,
          interval: input.interval ?? 1,
          daysOfWeek: input.daysOfWeek ?? [],
          dayOfMonth: input.dayOfMonth ?? null,
          endsAt: input.endsAt ? new Date(input.endsAt) : null,
          maxOccurrences: input.maxOccurrences ?? null,
          nextRunAt,
          active: input.active ?? true,
        },
        update: {
          frequency: input.frequency,
          interval: input.interval ?? 1,
          daysOfWeek: input.daysOfWeek ?? [],
          dayOfMonth: input.dayOfMonth ?? null,
          endsAt: input.endsAt ? new Date(input.endsAt) : null,
          maxOccurrences: input.maxOccurrences ?? null,
          nextRunAt,
          active: input.active ?? true,
        },
      });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'task.recurrence_upserted', targetType: 'TaskRecurrenceRule', targetId: rule.id, metadata: { projectId: input.projectId, taskId: task.id }, ...context });
      return rule;
    },

    async deleteRecurrence(input: { userId: string; workspaceId: string; projectId: string; taskId: string }, context: Ctx) {
      const access = await authorizeProjectAccess(prisma, input, ProjectPermission.TaskUpdate, { kind: 'task', taskId: input.taskId });
      assertProjectWritable(access.project);
      const existing = await prisma.taskRecurrenceRule.findUnique({ where: { taskId: input.taskId } });
      if (!existing) throw new AppError(404, 'RECURRENCE_NOT_FOUND', 'Recurrence rule not found');
      await prisma.taskRecurrenceRule.delete({ where: { id: existing.id } });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'task.recurrence_deleted', targetType: 'TaskRecurrenceRule', targetId: existing.id, metadata: { projectId: input.projectId, taskId: input.taskId }, ...context });
      return { taskId: input.taskId, deleted: true };
    },

    async generateNextRecurrence(input: { userId: string; workspaceId: string; projectId: string; taskId: string }, context: Ctx) {
      const access = await authorizeProjectAccess(prisma, input, ProjectPermission.TaskCreate);
      assertProjectWritable(access.project);
      const source = await prisma.task.findFirst({
        where: { id: input.taskId, projectId: input.projectId, deletedAt: null },
        select: { id: true, projectId: true, project: { select: { workspaceId: true } }, recurrenceRule: { select: { id: true } } },
      });
      if (!source) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      if (!source.recurrenceRule) throw new AppError(400, 'RECURRENCE_INACTIVE', 'Task recurrence is not active');

      const result = await generateRecurrenceInstanceForRule(prisma, source.recurrenceRule.id, {
        now: new Date(),
        actorId: input.userId,
        context,
        requireDue: false,
      });
      if (result.status === 'generated' && result.task) return result.task;
      if (result.status === 'skipped_inactive') throw new AppError(400, 'RECURRENCE_INACTIVE', 'Task recurrence is not active');
      if (result.status === 'skipped_complete') throw new AppError(400, 'RECURRENCE_COMPLETE', 'Recurrence has reached max occurrences');
      if (result.status === 'skipped_ended') throw new AppError(400, 'RECURRENCE_ENDED', 'Recurrence has ended');
      if (result.status === 'skipped_not_due') throw new AppError(409, 'RECURRENCE_NOT_DUE', 'Recurrence is not due yet');
      if (result.status === 'claimed_by_other') throw new AppError(409, 'RECURRENCE_ALREADY_GENERATED', 'Recurrence instance was already generated');
      throw new AppError(400, 'RECURRENCE_NOT_GENERATED', 'Could not generate recurrence instance');
    },

    async processDueRecurrences(now: Date = new Date()): Promise<{ processed: number; generated: number; skipped: number }> {
      const dueRules = await prisma.taskRecurrenceRule.findMany({
        where: {
          active: true,
          nextRunAt: { lte: now },
          task: { deletedAt: null, archivedAt: null },
        },
        select: { id: true },
        take: 100,
        orderBy: { nextRunAt: 'asc' },
      });

      let generated = 0;
      let skipped = 0;
      for (const rule of dueRules) {
        const result = await generateRecurrenceInstanceForRule(prisma, rule.id, {
          now,
          actorId: null,
          context: undefined,
          requireDue: true,
        });
        if (result.status === 'generated') generated += 1;
        else skipped += 1;
      }
      return { processed: dueRules.length, generated, skipped };
    },

    // Task templates (project-scoped)
    async listTaskTemplates(input: { userId: string; workspaceId: string; projectId: string }) {
      await authorizeProjectAccess(prisma, input, ProjectPermission.TaskView);
      return prisma.taskTemplate.findMany({ where: { projectId: input.projectId }, orderBy: { updatedAt: 'desc' } });
    },
    async createTaskTemplate(input: { userId: string; workspaceId: string; projectId: string } & CreateTaskTemplateInput, context: Ctx) {
      const access = await authorizeProjectAccess(prisma, input, ProjectPermission.Update);
      assertProjectWritable(access.project);
      const tpl = await prisma.taskTemplate.create({ data: { workspaceId: input.workspaceId, projectId: input.projectId, name: input.name, description: input.description ?? null, data: input.data as unknown as Prisma.InputJsonValue, createdById: input.userId } });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'project.task_template_created', targetType: 'TaskTemplate', targetId: tpl.id, metadata: { projectId: input.projectId }, ...context });
      return tpl;
    },
    async updateTaskTemplate(input: { userId: string; workspaceId: string; projectId: string; templateId: string } & UpdateTaskTemplateInput, context: Ctx) {
      const access = await authorizeProjectAccess(prisma, input, ProjectPermission.Update);
      assertProjectWritable(access.project);
      const existing = await prisma.taskTemplate.findFirst({ where: { id: input.templateId, projectId: input.projectId } });
      if (!existing) throw new AppError(404, 'TASK_TEMPLATE_NOT_FOUND', 'Task template not found');
      const tpl = await prisma.taskTemplate.update({ where: { id: existing.id }, data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.data !== undefined ? { data: input.data as unknown as Prisma.InputJsonValue } : {}) } });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'project.task_template_updated', targetType: 'TaskTemplate', targetId: tpl.id, metadata: { projectId: input.projectId }, ...context });
      return tpl;
    },
    async deleteTaskTemplate(input: { userId: string; workspaceId: string; projectId: string; templateId: string }, context: Ctx) {
      const access = await authorizeProjectAccess(prisma, input, ProjectPermission.Update);
      assertProjectWritable(access.project);
      const existing = await prisma.taskTemplate.findFirst({ where: { id: input.templateId, projectId: input.projectId } });
      if (!existing) throw new AppError(404, 'TASK_TEMPLATE_NOT_FOUND', 'Task template not found');
      await prisma.taskTemplate.delete({ where: { id: existing.id } });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'project.task_template_deleted', targetType: 'TaskTemplate', targetId: existing.id, metadata: { projectId: input.projectId }, ...context });
      return { id: existing.id, deleted: true };
    },
    async createTaskFromTemplate(input: { userId: string; workspaceId: string; projectId: string; templateId: string; title?: string; assigneeIds?: string[]; startDate?: string | null; dueDate?: string | null }, context: Ctx) {
      const access = await authorizeProjectAccess(prisma, input, ProjectPermission.TaskCreate);
      assertProjectWritable(access.project);
      const tpl = await prisma.taskTemplate.findFirst({ where: { id: input.templateId, projectId: input.projectId } });
      if (!tpl) throw new AppError(404, 'TASK_TEMPLATE_NOT_FOUND', 'Task template not found');
      const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true, key: true } });
      if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project not found');
      const data = (tpl.data as Record<string, unknown>) || {};
      return prisma.$transaction(async (tx) => {
        const key = await generateTaskKey(tx, project.id, project.key);
        const task = await tx.task.create({
          data: {
            projectId: project.id,
            key,
            title: input.title || (typeof data.title === 'string' ? data.title : tpl.name),
            description: typeof data.description === 'string' ? data.description : null,
            status: templateTaskStatus(data.status),
            priority: (typeof data.priority === 'string' ? data.priority : 'MEDIUM') as TaskPriority,
            category: typeof data.category === 'string' ? data.category : null,
            labels: Array.isArray(data.labels) ? (data.labels as string[]) : [],
            startDate: input.startDate ? new Date(input.startDate) : (typeof data.startDate === 'string' ? new Date(data.startDate) : null),
            dueDate: input.dueDate ? new Date(input.dueDate) : (typeof data.dueDate === 'string' ? new Date(data.dueDate) : null),
            creatorId: input.userId,
            ...(input.assigneeIds?.length ? { assignees: { create: input.assigneeIds.map((userId) => ({ userId, assignedBy: input.userId })) } } : {}),
          },
        });
        if (Array.isArray(data.customFieldValues)) {
          const valid = data.customFieldValues.filter((v): v is { fieldId: string; value?: unknown } => Boolean(v) && typeof (v as { fieldId?: unknown }).fieldId === 'string');
          if (valid.length) {
            await tx.taskCustomFieldValue.createMany({ data: valid.map((v) => ({ taskId: task.id, fieldId: v.fieldId, value: (v.value ?? null) as Prisma.InputJsonValue })), skipDuplicates: true });
          }
        }
        await recordAuditEvent(tx, { workspaceId: input.workspaceId, actorId: input.userId, action: 'task.created_from_template', targetType: 'Task', targetId: task.id, metadata: { projectId: project.id, templateId: tpl.id, key: task.key }, ...context });
        return task;
      });
    },

    // Project templates (workspace-scoped)
    async listProjectTemplates(input: { userId: string; workspaceId: string }) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.ViewWorkspace });
      return prisma.projectTemplate.findMany({ where: { workspaceId: input.workspaceId }, orderBy: { updatedAt: 'desc' } });
    },
    async createProjectTemplate(input: { userId: string; workspaceId: string } & CreateProjectTemplateInput, context: Ctx) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.UpdateWorkspace });
      const tpl = await prisma.projectTemplate.create({ data: { workspaceId: input.workspaceId, name: input.name, description: input.description ?? null, data: input.data as unknown as Prisma.InputJsonValue, createdById: input.userId } });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'workspace.project_template_created', targetType: 'ProjectTemplate', targetId: tpl.id, metadata: {}, ...context });
      return tpl;
    },
    async updateProjectTemplate(input: { userId: string; workspaceId: string; templateId: string } & UpdateProjectTemplateInput, context: Ctx) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.UpdateWorkspace });
      const existing = await prisma.projectTemplate.findFirst({ where: { id: input.templateId, workspaceId: input.workspaceId } });
      if (!existing) throw new AppError(404, 'PROJECT_TEMPLATE_NOT_FOUND', 'Project template not found');
      const tpl = await prisma.projectTemplate.update({ where: { id: existing.id }, data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.data !== undefined ? { data: input.data as unknown as Prisma.InputJsonValue } : {}) } });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'workspace.project_template_updated', targetType: 'ProjectTemplate', targetId: tpl.id, metadata: {}, ...context });
      return tpl;
    },
    async deleteProjectTemplate(input: { userId: string; workspaceId: string; templateId: string }, context: Ctx) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.UpdateWorkspace });
      const existing = await prisma.projectTemplate.findFirst({ where: { id: input.templateId, workspaceId: input.workspaceId } });
      if (!existing) throw new AppError(404, 'PROJECT_TEMPLATE_NOT_FOUND', 'Project template not found');
      await prisma.projectTemplate.delete({ where: { id: existing.id } });
      await recordAuditEvent(prisma, { workspaceId: input.workspaceId, actorId: input.userId, action: 'workspace.project_template_deleted', targetType: 'ProjectTemplate', targetId: existing.id, metadata: {}, ...context });
      return { id: existing.id, deleted: true };
    },
    async createProjectFromTemplate(input: { userId: string; workspaceId: string; templateId: string; name: string; key: string; description?: string | null }, context: Ctx) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.UpdateWorkspace });
      const tpl = await prisma.projectTemplate.findFirst({ where: { id: input.templateId, workspaceId: input.workspaceId } });
      if (!tpl) throw new AppError(404, 'PROJECT_TEMPLATE_NOT_FOUND', 'Project template not found');
      const data = (tpl.data as Record<string, unknown>) || {};
      return prisma.$transaction(async (tx) => {
        const existing = await tx.project.findUnique({ where: { workspaceId_key: { workspaceId: input.workspaceId, key: input.key } }, select: { id: true } });
        if (existing) throw new AppError(409, 'PROJECT_KEY_TAKEN', 'A project with this key already exists in the workspace');
        const project = await tx.project.create({
          data: {
            workspaceId: input.workspaceId,
            name: input.name,
            key: input.key,
            description: input.description ?? (typeof data.description === 'string' ? data.description : null),
            status: (typeof data.status === 'string' ? data.status : 'PLANNING') as ProjectStatus,
            visibility: (typeof data.visibility === 'string' ? data.visibility : 'WORKSPACE') as ProjectVisibility,
            ownerId: input.userId,
          },
        });
        await tx.projectMembership.create({ data: { projectId: project.id, userId: input.userId, role: 'PROJECT_MANAGER' } });
        if (Array.isArray(data.customFields)) {
          for (const [i, cf] of data.customFields.entries()) {
            const field = cf as Record<string, unknown>;
            if (!field || typeof field.name !== 'string' || typeof field.type !== 'string') continue;
            const key = typeof field.key === 'string' ? field.key : (slugifyKey(field.name) || `field_${i + 1}`);
            await tx.projectCustomField.create({
              data: {
                projectId: project.id,
                name: field.name,
                key,
                type: field.type as CustomFieldType,
                description: typeof field.description === 'string' ? field.description : null,
                options: field.options == null ? Prisma.DbNull : (field.options as Prisma.InputJsonValue),
                required: Boolean(field.required),
                position: typeof field.position === 'number' ? field.position : i,
                createdById: input.userId,
              },
            }).catch(() => null);
          }
        }
        if (Array.isArray(data.tasks)) {
          for (const t of data.tasks) {
            const taskData = t as Record<string, unknown>;
            if (!taskData || typeof taskData.title !== 'string') continue;
            const taskKey = await generateTaskKey(tx, project.id, project.key);
            await tx.task.create({
              data: {
                projectId: project.id,
                key: taskKey,
                title: taskData.title,
                description: typeof taskData.description === 'string' ? taskData.description : null,
                status: templateTaskStatus(taskData.status),
                priority: (typeof taskData.priority === 'string' ? taskData.priority : 'MEDIUM') as TaskPriority,
                labels: Array.isArray(taskData.labels) ? (taskData.labels as string[]) : [],
                creatorId: input.userId,
              },
            });
          }
        }
        await recordAuditEvent(tx, { workspaceId: input.workspaceId, actorId: input.userId, action: 'project.created_from_template', targetType: 'Project', targetId: project.id, metadata: { templateId: tpl.id, key: project.key }, ...context });
        return project;
      });
    },
  };
}
