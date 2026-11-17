/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import type { AiActionProposal, Prisma, PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { AiProviderError, AiUnavailableError } from '../../services/providers/ai';
import { AppError } from '../../utils/errors';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import {
  ChannelCapability,
  ProjectCapability,
  requireChannelAccess,
  requireProjectAccess,
  requireWorkspaceAccess,
  WorkspaceCapability,
} from '../authorization';
import type { WorkspaceAccessContext } from '../authorization/workspace.policy';
import { assertAiWorkspaceEntitled } from './ai-access';
import { createCalendarService } from '../calendar/calendar.service';
import { createMessageService } from '../messaging/message.service';
import type { RequestContext } from '../auth/auth.types';
import { createDocumentService } from '../documents/document.service';
import { createTaskService } from '../tasks/task.service';
import type { CreateTaskInput } from '../tasks/task.schemas';
import type { AiActionProposalBody, AiActionTypeValue } from './ai.schemas';
import { validateActionPayload } from './ai.schemas';

/**
 * AI action approval and execution (Phase 23).
 *
 * AI can propose a mutation, but a proposal is inert until the user approves
 * it and explicitly executes it. Both steps re-evaluate the caller's current
 * permissions. Execution transitions the proposal from APPROVED to EXECUTING
 * with a conditional update, so two concurrent requests cannot execute the
 * same action twice.
 */

export interface AiActionServiceDependencies {
  prisma?: PrismaClient;
  taskService?: ReturnType<typeof createTaskService>;
  documentService?: ReturnType<typeof createDocumentService>;
  messageService?: ReturnType<typeof createMessageService>;
  calendarService?: ReturnType<typeof createCalendarService>;
  logger?: Logger;
  now?: () => Date;
}

function asObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function proposalSummary(proposal: AiActionProposal) {
  return {
    id: proposal.id,
    workspaceId: proposal.workspaceId,
    actionType: proposal.actionType,
    status: proposal.status,
    title: proposal.title,
    summary: proposal.summary,
    payload: proposal.payload,
    sourceReferences: proposal.sourceReferences,
    expiresAt: proposal.expiresAt.toISOString(),
    approvedAt: proposal.approvedAt?.toISOString() ?? null,
    rejectedAt: proposal.rejectedAt?.toISOString() ?? null,
    executedAt: proposal.executedAt?.toISOString() ?? null,
    executionResult: proposal.executionResult,
    failureReason: proposal.failureReason,
    createdAt: proposal.createdAt.toISOString(),
    updatedAt: proposal.updatedAt.toISOString(),
  };
}

function providerErrorCode(error: unknown): string {
  if (error instanceof AiUnavailableError || error instanceof AiProviderError) return error.code;
  return error instanceof AppError ? error.code : 'AI_ACTION_FAILED';
}

export function createAiActionService(
  config: AppConfig,
  dependencies: AiActionServiceDependencies = {},
) {
  const prisma = dependencies.prisma ?? getPrismaClient();
  const logger = dependencies.logger ?? defaultLogger;
  const now = dependencies.now ?? (() => new Date());
  const taskService = dependencies.taskService ?? createTaskService(prisma);
  const documentService = dependencies.documentService ?? createDocumentService(prisma);
  const messageService = dependencies.messageService ?? createMessageService(prisma);
  const calendarService = dependencies.calendarService ?? createCalendarService(prisma);

  async function checkActionPermission(
    userId: string,
    workspaceId: string,
    actionType: AiActionTypeValue,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const access = await requireWorkspaceAccess(prisma, {
      userId,
      workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
           context: (input as { context: WorkspaceAccessContext }).context,
      });

    const requireProject = async (
      projectId: string,
      capability: (typeof ProjectCapability)[keyof typeof ProjectCapability],
    ) => {
      await requireProjectAccess(prisma, {
        userId,
        workspaceId,
        projectId,
        workspaceRole: access.effectiveRole,
        capability,
      });
    };

    if (actionType === 'CREATE_TASK') {
      await requireProject(String(payload.projectId), ProjectCapability.CreateTask);
      return;
    }

    if (actionType === 'ADD_TASK_COMMENT') {
      await requireProject(String(payload.projectId), ProjectCapability.ViewTasks);
      return;
    }

    if (actionType === 'COMPLETE_TASK') {
      await requireProject(String(payload.projectId), ProjectCapability.ManageTask);
      return;
    }

    if (actionType === 'CREATE_DOCUMENT') {
      const projectId = typeof payload.projectId === 'string' ? payload.projectId : null;
      if (projectId) {
        await requireProject(projectId, ProjectCapability.ManageFiles);
      } else if (typeof payload.taskId === 'string') {
        const task = await prisma.task.findFirst({
          where: { id: payload.taskId, project: { workspaceId }, deletedAt: null },
          select: { projectId: true },
        });
        if (!task) throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
        await requireProject(task.projectId, ProjectCapability.ManageFiles);
      }
      return;
    }

    if (actionType === 'SEND_NOTIFICATION') {
      await requireWorkspaceAccess(prisma, {
        userId,
        workspaceId,
        capability: WorkspaceCapability.ManageMembers,
             context: (input as { context: WorkspaceAccessContext }).context,
      });
      const recipientId = String(payload.recipientId);
      const recipient = await prisma.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: recipientId } },
        select: { status: true },
      });
      if (!recipient || recipient.status !== 'ACTIVE') {
        throw new AppError(
          400,
          'AI_ACTION_RECIPIENT_INVALID',
          'The notification recipient is not an active workspace member',
        );
      }
      return;
    }

    if (actionType === 'POST_MESSAGE') {
      await requireChannelAccess(prisma, {
        userId,
        workspaceId,
        channelId: String(payload.channelId),
        capability: ChannelCapability.View,
             context: (input as { context: WorkspaceAccessContext }).context,
      });
      return;
    }

    if (actionType === 'SCHEDULE_EVENT') {
      // Workspace access already verified; project access (if any) is enforced by calendar service.
      const projectId = typeof payload.projectId === 'string' ? payload.projectId : null;
      if (projectId) {
        await requireProjectAccess(prisma, {
          userId,
          workspaceId,
          projectId,
          workspaceRole: access.effectiveRole,
          capability: ProjectCapability.ViewProject,
        });
      }
      return;
    }
  }

  async function findOwnedProposal(userId: string, proposalId: string): Promise<AiActionProposal> {
    const proposal = await prisma.aiActionProposal.findFirst({
      where: { id: proposalId, userId },
    });
    if (!proposal) {
      throw new AppError(404, 'AI_ACTION_NOT_FOUND', 'That AI action proposal does not exist');
    }
    return proposal;
  }

  async function executeApproved(
    proposal: AiActionProposal,
    context: RequestContext,
  ): Promise<Record<string, unknown>> {
    const payload = asObject(proposal.payload);
    const validated = validateActionPayload(proposal.actionType, payload);

    if (!validated.success) {
      throw new AppError(
        400,
        'AI_ACTION_PAYLOAD_INVALID',
        'The approved action payload is no longer valid',
        {
          details: validated.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        },
      );
    }

    await checkActionPermission(
      proposal.userId,
      proposal.workspaceId,
      proposal.actionType,
      validated.data as unknown as Record<string, unknown>,
    );

    switch (proposal.actionType as string) {
      case 'CREATE_TASK': {
        const { projectId, ...taskInput } = validated.data as unknown as CreateTaskInput & {
          projectId: string;
        };
        const task = await taskService.create(
          {
            userId: proposal.userId,
            workspaceId: proposal.workspaceId,
            projectId,
            ...taskInput,
          },
          context,
        );
        return { taskId: task.id, key: task.key, title: task.title };
      }

      case 'ADD_TASK_COMMENT': {
        const { projectId, taskId, body, parentId } = validated.data as unknown as {
          projectId: string;
          taskId: string;
          body: string;
          parentId?: string;
        };
        const comment = await taskService.addComment(
          {
            userId: proposal.userId,
            workspaceId: proposal.workspaceId,
            projectId,
            taskId,
            body,
            mentionedUserIds: [],
            ...(parentId ? { parentId } : {}),
          },
          context,
        );
        return { commentId: comment.id, taskId };
      }

      case 'COMPLETE_TASK': {
        const { projectId, taskId } = validated.data as unknown as {
          projectId: string;
          taskId: string;
        };
        const task = await taskService.complete(
          {
            userId: proposal.userId,
            workspaceId: proposal.workspaceId,
            projectId,
            taskId,
          },
          context,
        );
        return { taskId: task.id, status: task.status };
      }

      case 'CREATE_DOCUMENT': {
        const documentInput = validated.data as unknown as {
          title: string;
          content?: string;
          projectId?: string | null;
          taskId?: string | null;
        };
        const document = await documentService.create({
          userId: proposal.userId,
          workspaceId: proposal.workspaceId,
          ...documentInput,
        });
        return { documentId: document.id, title: document.title };
      }

      case 'SEND_NOTIFICATION': {
        const { recipientId, title, body } = validated.data as unknown as {
          recipientId: string;
          title: string;
          body?: string;
        };
        await createNotification(prisma, {
          userId: recipientId,
          type: 'PROJECT_UPDATE',
          title,
          ...(body ? { body } : {}),
          data: {
            workspaceId: proposal.workspaceId,
            source: 'ai_action',
            proposalId: proposal.id,
          },
        });
        return { recipientId, notified: true };
      }

      case 'POST_MESSAGE': {
        const { channelId, body, parentId } = validated.data as unknown as {
          channelId: string;
          body: string;
          parentId?: string | null;
        };
        const message = await messageService.send({
          userId: proposal.userId,
          workspaceId: proposal.workspaceId,
          channelId,
          body,
          ...(parentId ? { parentId } : {}),
        });
        return { messageId: message.id, channelId };
      }

      case 'SCHEDULE_EVENT': {
        const eventInput = validated.data as unknown as {
          title: string;
          description?: string | null;
          location?: string | null;
          startAt: string;
          endAt: string;
          allDay?: boolean;
          status?: string;
          visibility?: string;
          projectId?: string | null;
          inviteeIds?: string[];
        };
        const event = await calendarService.create({
          userId: proposal.userId,
          workspaceId: proposal.workspaceId,
          title: eventInput.title,
          startAt: eventInput.startAt,
          endAt: eventInput.endAt,
          allDay: eventInput.allDay ?? false,
          status: eventInput.status ?? 'CONFIRMED',
          visibility: eventInput.visibility ?? 'PUBLIC',
          ...(eventInput.description !== undefined ? { description: eventInput.description } : {}),
          ...(eventInput.location !== undefined ? { location: eventInput.location } : {}),
          ...(eventInput.projectId !== undefined ? { projectId: eventInput.projectId } : {}),
          ...(eventInput.inviteeIds ? { inviteeIds: eventInput.inviteeIds } : {}),
        });
        return { eventId: event.id, title: event.title };
      }

      default:
        throw new AppError(
          400,
          'AI_ACTION_TYPE_UNSUPPORTED',
          'That AI action type is not supported',
        );
    }
  }

  return {
    async propose(userId: string, input: AiActionProposalBody, context: RequestContext = {}) {
      const validated = validateActionPayload(input.actionType, input.payload as unknown);
      if (!validated.success) {
        throw new AppError(
          400,
          'AI_ACTION_PAYLOAD_INVALID',
          'The proposed action payload is invalid',
          {
            details: validated.issues.map((issue) => ({
              path: issue.path,
              message: issue.message,
            })),
          },
        );
      }

      await assertAiWorkspaceEntitled(prisma, input.workspaceId);
      await checkActionPermission(
        userId,
        input.workspaceId,
        input.actionType,
        validated.data as unknown as Record<string, unknown>,
      );

      const idempotencyKey = input.idempotencyKey ?? `ai-action:${randomUUID()}`;

      const existing = await prisma.aiActionProposal.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        if (existing.userId !== userId || existing.workspaceId !== input.workspaceId) {
          throw new AppError(
            409,
            'AI_ACTION_IDEMPOTENCY_CONFLICT',
            'That idempotency key is already in use',
          );
        }
        return proposalSummary(existing);
      }

      const expiresAt = new Date(now().getTime() + config.aiActionApprovalTtlSeconds * 1_000);

      const proposal = await prisma.aiActionProposal.create({
        data: {
          workspaceId: input.workspaceId,
          userId,
          conversationId: input.conversationId ?? null,
          actionType: input.actionType as any,
          title: input.title ?? `${input.actionType.replaceAll('_', ' ').toLowerCase()}`,
          summary: input.summary ?? null,
          payload: validated.data as unknown as Prisma.InputJsonValue,
          sourceReferences: input.sourceReferences as unknown as Prisma.InputJsonValue,
          idempotencyKey,
          expiresAt,
        },
      });

      await recordAuditEvent(prisma, {
        workspaceId: input.workspaceId,
        actorId: userId,
        action: 'ai.action_proposed',
        targetType: 'AiActionProposal',
        targetId: proposal.id,
        metadata: { actionType: proposal.actionType },
        ip: context.ip,
        userAgent: context.userAgent,
      });

      return proposalSummary(proposal);
    },

    async list(
      userId: string,
      options: {
        workspaceId: string;
        status?: AiActionProposal['status'];
        cursor?: string;
        limit?: number;
      },
    ) {
      await requireWorkspaceAccess(prisma, {
        userId,
        workspaceId: options.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
             context: (input as { context: WorkspaceAccessContext }).context,
      });

      const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
      const rows = await prisma.aiActionProposal.findMany({
        where: {
          userId,
          workspaceId: options.workspaceId,
          ...(options.status ? { status: options.status } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(proposalSummary);

      return {
        items,
        nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      };
    },

    async get(userId: string, proposalId: string) {
      const proposal = await findOwnedProposal(userId, proposalId);
      await requireWorkspaceAccess(prisma, {
        userId,
        workspaceId: proposal.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
             context: (input as { context: WorkspaceAccessContext }).context,
      });
      return proposalSummary(proposal);
    },

    async approve(
      userId: string,
      proposalId: string,
      note: string | undefined,
      context: RequestContext = {},
    ) {
      const proposal = await findOwnedProposal(userId, proposalId);
      await assertAiWorkspaceEntitled(prisma, proposal.workspaceId);
      await checkActionPermission(
        userId,
        proposal.workspaceId,
        proposal.actionType,
        asObject(proposal.payload),
      );

      if (proposal.status !== 'PROPOSED') {
        throw new AppError(
          409,
          'AI_ACTION_NOT_PENDING',
          `That AI action is ${proposal.status.toLowerCase()} and cannot be approved`,
        );
      }
      if (proposal.expiresAt.getTime() <= now().getTime()) {
        await prisma.aiActionProposal.update({
          where: { id: proposal.id },
          data: { status: 'EXPIRED' },
        });
        throw new AppError(410, 'AI_ACTION_EXPIRED', 'That AI action proposal has expired');
      }

      const updated = await prisma.$transaction(async (tx) => {
        await tx.aiActionApproval.create({
          data: {
            proposalId: proposal.id,
            userId,
            decision: 'APPROVED',
            note: note ?? null,
            ip: context.ip?.slice(0, 128) ?? null,
            userAgent: context.userAgent?.slice(0, 512) ?? null,
          },
        });
        return tx.aiActionProposal.update({
          where: { id: proposal.id },
          data: { status: 'APPROVED', approvedAt: now() },
        });
      });

      await recordAuditEvent(prisma, {
        workspaceId: proposal.workspaceId,
        actorId: userId,
        action: 'ai.action_approved',
        targetType: 'AiActionProposal',
        targetId: proposal.id,
        metadata: { actionType: proposal.actionType },
        ip: context.ip,
        userAgent: context.userAgent,
      });

      return proposalSummary(updated);
    },

    async reject(
      userId: string,
      proposalId: string,
      note: string | undefined,
      context: RequestContext = {},
    ) {
      const proposal = await findOwnedProposal(userId, proposalId);

      if (proposal.status !== 'PROPOSED' && proposal.status !== 'APPROVED') {
        throw new AppError(
          409,
          'AI_ACTION_NOT_REJECTABLE',
          `That AI action is ${proposal.status.toLowerCase()} and cannot be rejected`,
        );
      }

      const updated = await prisma.$transaction(async (tx) => {
        await tx.aiActionApproval.create({
          data: {
            proposalId: proposal.id,
            userId,
            decision: 'REJECTED',
            note: note ?? null,
            ip: context.ip?.slice(0, 128) ?? null,
            userAgent: context.userAgent?.slice(0, 512) ?? null,
          },
        });
        return tx.aiActionProposal.update({
          where: { id: proposal.id },
          data: { status: 'REJECTED', rejectedAt: now() },
        });
      });

      await recordAuditEvent(prisma, {
        workspaceId: proposal.workspaceId,
        actorId: userId,
        action: 'ai.action_rejected',
        targetType: 'AiActionProposal',
        targetId: proposal.id,
        metadata: { actionType: proposal.actionType },
        ip: context.ip,
        userAgent: context.userAgent,
      });

      return proposalSummary(updated);
    },

    async cancel(userId: string, proposalId: string, context: RequestContext = {}) {
      const proposal = await findOwnedProposal(userId, proposalId);

      if (proposal.status !== 'PROPOSED' && proposal.status !== 'APPROVED') {
        throw new AppError(
          409,
          'AI_ACTION_NOT_CANCELLABLE',
          `That AI action is ${proposal.status.toLowerCase()} and cannot be cancelled`,
        );
      }

      const updated = await prisma.aiActionProposal.update({
        where: { id: proposal.id },
        data: { status: 'CANCELLED' },
      });

      await recordAuditEvent(prisma, {
        workspaceId: proposal.workspaceId,
        actorId: userId,
        action: 'ai.action_cancelled',
        targetType: 'AiActionProposal',
        targetId: proposal.id,
        metadata: { actionType: proposal.actionType },
        ip: context.ip,
        userAgent: context.userAgent,
      });

      return proposalSummary(updated);
    },

    async execute(userId: string, proposalId: string, context: RequestContext = {}) {
      const proposal = await findOwnedProposal(userId, proposalId);

      if (proposal.status !== 'APPROVED') {
        throw new AppError(
          409,
          'AI_ACTION_NOT_APPROVED',
          'The AI action must be approved before it can be executed',
        );
      }
      if (proposal.expiresAt.getTime() <= now().getTime()) {
        await prisma.aiActionProposal.update({
          where: { id: proposal.id },
          data: { status: 'EXPIRED' },
        });
        throw new AppError(410, 'AI_ACTION_EXPIRED', 'That AI action approval has expired');
      }

      // Re-check permission immediately before the mutation. An approval is
      // not a permanent grant: a role or membership may have changed since.
      await assertAiWorkspaceEntitled(prisma, proposal.workspaceId);
      await checkActionPermission(
        userId,
        proposal.workspaceId,
        proposal.actionType,
        asObject(proposal.payload),
      );

      const claimed = await prisma.aiActionProposal.updateMany({
        where: { id: proposal.id, status: 'APPROVED' },
        data: { status: 'EXECUTING' },
      });
      if (claimed.count !== 1) {
        throw new AppError(
          409,
          'AI_ACTION_ALREADY_EXECUTING',
          'That AI action is already being executed',
        );
      }

      try {
        const result = await executeApproved(proposal, context);
        const updated = await prisma.aiActionProposal.update({
          where: { id: proposal.id },
          data: {
            status: 'EXECUTED',
            executedAt: now(),
            executionResult: result as Prisma.InputJsonValue,
            failureReason: null,
          },
        });

        await recordAuditEvent(prisma, {
          workspaceId: proposal.workspaceId,
          actorId: userId,
          action: 'ai.action_executed',
          targetType: 'AiActionProposal',
          targetId: proposal.id,
          metadata: { actionType: proposal.actionType, result },
          ip: context.ip,
          userAgent: context.userAgent,
        });

        return proposalSummary(updated);
      } catch (error) {
        const code = providerErrorCode(error);
        const message =
          error instanceof Error ? error.message.slice(0, 500) : 'Action execution failed';

        await prisma.aiActionProposal.update({
          where: { id: proposal.id },
          data: { status: 'FAILED', failureReason: message },
        });

        await recordAuditEvent(prisma, {
          workspaceId: proposal.workspaceId,
          actorId: userId,
          action: 'ai.action_failed',
          targetType: 'AiActionProposal',
          targetId: proposal.id,
          metadata: { actionType: proposal.actionType, code },
          ip: context.ip,
          userAgent: context.userAgent,
        }).catch(() => undefined);

        logger.warn('ai_action_failed', {
          proposalId: proposal.id,
          actionType: proposal.actionType,
          code,
        });

        if (error instanceof AppError) throw error;
        throw new AppError(500, 'AI_ACTION_FAILED', 'The approved AI action could not be executed');
      }
    },
  };
}
