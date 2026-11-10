import type { AutomationActionType, AutomationTrigger, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import { z } from 'zod';

const uuid = z.string().uuid();

export const createAutomationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  trigger: z.enum(['EVENT_TASK_CREATED', 'EVENT_TASK_COMPLETED', 'EVENT_MEMBER_JOINED', 'SCHEDULED_DAILY', 'SCHEDULED_WEEKLY'] as const),
  condition: z.record(z.string(), z.string()).optional().nullable(),
  action: z.enum(['SEND_NOTIFICATION', 'CREATE_TASK', 'SEND_WEBHOOK'] as const),
  actionConfig: z.record(z.string(), z.string()),
  enabled: z.boolean().optional().default(true),
  maxRetries: z.number().int().min(0).max(10).optional().default(3),
}).strict().superRefine((value, ctx) => {
  const config = value.actionConfig;
  if (value.action === 'SEND_NOTIFICATION') {
    if (!config.userIds && !config.userId) {
      ctx.addIssue({ code: 'custom', path: ['actionConfig', 'userIds'], message: 'SEND_NOTIFICATION requires userIds or userId' });
    }
    if (!config.title?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['actionConfig', 'title'], message: 'SEND_NOTIFICATION requires a title' });
    }
  }
  if (value.action === 'CREATE_TASK') {
    if (!config.projectId) {
      ctx.addIssue({ code: 'custom', path: ['actionConfig', 'projectId'], message: 'CREATE_TASK requires a projectId' });
    }
    if (!config.title?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['actionConfig', 'title'], message: 'CREATE_TASK requires a title' });
    }
  }
  if (value.action === 'SEND_WEBHOOK') {
    if (!config.url?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['actionConfig', 'url'], message: 'SEND_WEBHOOK requires a url' });
    } else {
      try {
        const url = new URL(config.url);
        if (url.protocol !== 'https:') {
          ctx.addIssue({ code: 'custom', path: ['actionConfig', 'url'], message: 'Webhook URLs must use HTTPS' });
        }
      } catch {
        ctx.addIssue({ code: 'custom', path: ['actionConfig', 'url'], message: 'The webhook URL is not valid' });
      }
    }
  }
});

export const updateAutomationSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
}).strict();

export const automationWorkspaceParams = z.object({ workspaceId: uuid });
export const automationParamsSchema = z.object({ workspaceId: uuid, automationId: uuid });
export const automationRunParamsSchema = z.object({
  workspaceId: uuid,
  automationId: uuid,
  runId: uuid,
});
export const listAutomationRunsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  })
  .strict();

export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;

type Input = { userId: string; workspaceId: string };

export function createAutomationService(prisma: PrismaClient = getPrismaClient()) {
  return {
    async create(input: Input & CreateAutomationInput) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.UpdateWorkspace });
      const auto = await prisma.$transaction(async (tx) => {
        const created = await tx.automation.create({ data: { workspaceId: input.workspaceId, createdById: input.userId, name: input.name, trigger: input.trigger as AutomationTrigger, condition: input.condition ?? undefined, action: input.action as AutomationActionType, actionConfig: input.actionConfig, enabled: input.enabled ?? true, maxRetries: input.maxRetries ?? 3 } });
        await recordAuditEvent(tx, { workspaceId: input.workspaceId, actorId: input.userId, action: 'automation.created', targetType: 'Automation', targetId: created.id, metadata: { name: input.name, trigger: input.trigger } });
        return created;
      });
      return auto;
    },

    async list(input: Input) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.ViewWorkspace });
      return prisma.automation.findMany({ where: { workspaceId: input.workspaceId, deletedAt: null }, orderBy: { name: 'asc' } });
    },

    async get(input: Input & { automationId: string }) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.ViewWorkspace });
      const auto = await prisma.automation.findFirst({ where: { id: input.automationId, workspaceId: input.workspaceId, deletedAt: null }, include: { runs: { orderBy: { createdAt: 'desc' }, take: 10 } } });
      if (!auto) throw new AppError(404, 'AUTOMATION_NOT_FOUND', 'That automation does not exist');
      return auto;
    },

    async update(input: Input & { automationId: string; name?: string; enabled?: boolean }) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.UpdateWorkspace });
      const auto = await prisma.automation.findFirst({ where: { id: input.automationId, workspaceId: input.workspaceId, deletedAt: null } });
      if (!auto) throw new AppError(404, 'AUTOMATION_NOT_FOUND', 'That automation does not exist');
      return prisma.automation.update({ where: { id: auto.id }, data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.enabled !== undefined ? { enabled: input.enabled } : {}) } });
    },

    async delete(input: Input & { automationId: string }) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.UpdateWorkspace });
      const auto = await prisma.automation.findFirst({ where: { id: input.automationId, workspaceId: input.workspaceId, deletedAt: null } });
      if (!auto) throw new AppError(404, 'AUTOMATION_NOT_FOUND', 'That automation does not exist');
      await prisma.automation.update({ where: { id: auto.id }, data: { deletedAt: new Date() } });
    },

    async recordRun(input: { automationId: string; status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED'; error?: string }) {
      return prisma.automationRun.create({ data: { automationId: input.automationId, status: input.status, attempts: 1, startedAt: new Date(), completedAt: new Date(), error: input.error ?? null } });
    },

    async listRuns(input: Input & { automationId: string; limit?: number }) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.ViewWorkspace });
      const automation = await prisma.automation.findFirst({
        where: { id: input.automationId, workspaceId: input.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!automation) throw new AppError(404, 'AUTOMATION_NOT_FOUND', 'That automation does not exist');
      return prisma.automationRun.findMany({
        where: { automationId: automation.id },
        orderBy: { createdAt: 'desc' },
        take: input.limit ?? 50,
      });
    },

    /**
     * Reset a terminally failed run so the worker can execute it again. The
     * automation owner's permissions are re-checked by the engine when the run
     * executes, so retrying never grants access that has since been removed.
     */
    async retryRun(input: Input & { automationId: string; runId: string }) {
      await requireWorkspaceAccess(prisma, { userId: input.userId, workspaceId: input.workspaceId, capability: WorkspaceCapability.UpdateWorkspace });
      const automation = await prisma.automation.findFirst({
        where: { id: input.automationId, workspaceId: input.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!automation) throw new AppError(404, 'AUTOMATION_NOT_FOUND', 'That automation does not exist');
      const run = await prisma.automationRun.findFirst({
        where: { id: input.runId, automationId: automation.id, status: 'FAILED' },
      });
      if (!run) throw new AppError(404, 'AUTOMATION_RUN_NOT_FOUND', 'That failed run does not exist');
      return prisma.automationRun.update({
        where: { id: run.id },
        data: {
          status: 'PENDING',
          attempts: 0,
          error: null,
          startedAt: null,
          completedAt: null,
          nextAttemptAt: new Date(),
        },
      });
    },
  };
}
