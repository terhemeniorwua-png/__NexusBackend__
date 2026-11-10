import type { AiConversation, AiMessage, Prisma, PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import {
  AiProviderError,
  AiUnavailableError,
  createAiClient,
  type AiChatMessage,
  type AiChatResponse,
  type AiClient,
  type AiSourceReference,
  type AiStreamEvent,
} from '../../services/providers/ai';
import { AppError } from '../../utils/errors';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import { requireWorkspaceAccess, WorkspaceCapability } from '../authorization';
import { createAiContextService } from './ai-context.service';
import { createAiUsageService } from './ai-usage.service';

/**
 * AI conversations (Phase 21).
 *
 * The service owns the full boundary: it verifies workspace access, builds
 * permission-filtered context through `AiContextService`, enforces usage
 * limits, persists the conversation and records every call. A provider
 * failure is recorded and surfaced as a clear 5xx; it never breaks any core
 * Nexus feature.
 */

export interface AiServiceDependencies {
  prisma?: PrismaClient;
  client?: AiClient;
  logger?: Logger;
  contextService?: ReturnType<typeof createAiContextService>;
  usageService?: ReturnType<typeof createAiUsageService>;
}

export interface AiChatInput {
  userId: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  query: string;
  projectId?: string | null;
  taskId?: string | null;
  documentId?: string | null;
  meetingId?: string | null;
  contextType?: string | null;
  contextId?: string | null;
}

export interface AiRequestMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
  requestId?: string | undefined;
}

export type AiChatStreamEvent = AiStreamEvent | { type: 'conversation'; conversationId: string };

const MAX_HISTORY_MESSAGES = 20;
const MAX_CONVERSATION_TITLE = 120;

function titleFromQuery(query: string): string {
  const trimmed = query.trim().replace(/\s+/g, ' ');
  return trimmed.length > MAX_CONVERSATION_TITLE
    ? `${trimmed.slice(0, MAX_CONVERSATION_TITLE - 1)}…`
    : trimmed;
}

function conversationSummary(conversation: AiConversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    workspaceId: conversation.workspaceId,
    status: conversation.status,
    contextType: conversation.contextType,
    contextId: conversation.contextId,
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

function messageSummary(message: AiMessage) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    status: message.status,
    model: message.model,
    tokenCount: message.tokenCount,
    references: message.references,
    createdAt: message.createdAt.toISOString(),
  };
}

function mapProviderError(error: unknown): never {
  if (error instanceof AiUnavailableError) {
    throw new AppError(503, error.code, error.message);
  }
  if (error instanceof AiProviderError) {
    if (error.statusCode === 429 || error.code === 'AI_RATE_LIMITED') {
      throw new AppError(
        429,
        'AI_RATE_LIMITED',
        'The AI service is rate limiting requests. Please try again shortly.',
      );
    }
    throw new AppError(502, error.code, 'The AI service could not complete the request');
  }
  throw new AppError(502, 'AI_PROVIDER_ERROR', 'The AI service could not complete the request');
}

function filterReferences(
  references: AiSourceReference[],
  sources: AiSourceReference[],
): AiSourceReference[] {
  const allowed = new Map(sources.map((source) => [`${source.type}:${source.id}`, source]));

  return references
    .map((reference) => allowed.get(`${reference.type}:${reference.id}`))
    .filter((reference): reference is AiSourceReference => Boolean(reference));
}

export function createAiService(config: AppConfig, dependencies: AiServiceDependencies = {}) {
  const prisma = dependencies.prisma ?? getPrismaClient();
  const logger = dependencies.logger ?? defaultLogger;
  const client = dependencies.client ?? createAiClient(config);
  const contextService = dependencies.contextService ?? createAiContextService(config, prisma);
  const usageService = dependencies.usageService ?? createAiUsageService(config, prisma);

  function ensureConfigured(): void {
    if (!client.isConfigured()) {
      throw new AppError(
        503,
        'AI_NOT_CONFIGURED',
        'The AI service is not configured. Enable it through the AI environment variables.',
      );
    }
  }

  async function resolveConversation(
    userId: string,
    conversationId: string,
  ): Promise<AiConversation> {
    const conversation = await prisma.aiConversation.findFirst({
      where: { id: conversationId, userId },
    });
    if (!conversation) {
      throw new AppError(404, 'AI_CONVERSATION_NOT_FOUND', 'That AI conversation does not exist');
    }
    if (conversation.status === 'ARCHIVED') {
      throw new AppError(409, 'AI_CONVERSATION_ARCHIVED', 'That AI conversation is archived');
    }
    return conversation;
  }

  async function buildMessages(
    conversationId: string | null,
    query: string,
    contextText: string,
  ): Promise<AiChatMessage[]> {
    const messages: AiChatMessage[] = [
      {
        role: 'system',
        content:
          'You are Nexus AI, the assistant inside the Nexus workspace platform. ' +
          'Answer only from the authorised context supplied by the backend. ' +
          'Never invent private data, never reveal identifiers that are not in the context, ' +
          'and never claim to have performed an action. Mutations require a proposal and ' +
          'explicit user approval through the Nexus AI actions API. ' +
          'When you use a source, cite it as [type:id]. Keep answers concise and useful.',
      },
    ];

    if (conversationId) {
      const history = await prisma.aiMessage.findMany({
        where: { conversationId, status: 'COMPLETED' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_HISTORY_MESSAGES,
      });
      for (const message of history.reverse()) {
        if (message.role === 'SYSTEM') continue;
        messages.push({
          role: message.role === 'ASSISTANT' ? 'assistant' : 'user',
          content: message.content,
        });
      }
    }

    messages.push({
      role: 'user',
      content: contextText
        ? `Authorised workspace context:\n${contextText}\n\nQuestion:\n${query}`
        : `Question:\n${query}`,
    });

    return messages;
  }

  async function prepare(input: AiChatInput) {
    ensureConfigured();

    let conversation: AiConversation | null = null;
    let workspaceId = input.workspaceId ?? null;

    if (input.conversationId) {
      conversation = await resolveConversation(input.userId, input.conversationId);
      if (workspaceId && conversation.workspaceId && workspaceId !== conversation.workspaceId) {
        throw new AppError(
          400,
          'AI_CONVERSATION_SCOPE_MISMATCH',
          'The conversation belongs to a different workspace',
        );
      }
      workspaceId = conversation.workspaceId ?? workspaceId;
    }

    if (workspaceId) {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
    }

    await usageService.assertWithinLimits(input.userId, workspaceId);

    const context = await contextService.build({
      userId: input.userId,
      workspaceId,
      projectId: input.projectId,
      taskId: input.taskId,
      documentId: input.documentId,
      meetingId: input.meetingId,
      query: input.query,
    });

    if (!conversation) {
      conversation = await prisma.aiConversation.create({
        data: {
          userId: input.userId,
          workspaceId,
          title: titleFromQuery(input.query),
          contextType: input.contextType ?? (input.projectId ? 'project' : null),
          contextId: input.contextId ?? input.projectId ?? null,
        },
      });
    } else {
      await prisma.aiConversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
    }

    await prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'USER',
        content: input.query,
        status: 'COMPLETED',
      },
    });

    const messages = await buildMessages(conversation.id, input.query, context.text);

    return { conversation, workspaceId, context, messages };
  }

  async function persistSuccess(
    conversationId: string,
    response: AiChatResponse,
    references: AiSourceReference[],
  ): Promise<void> {
    await prisma.$transaction([
      prisma.aiMessage.create({
        data: {
          conversationId,
          role: 'ASSISTANT',
          content: response.content,
          status: 'COMPLETED',
          model: response.model,
          tokenCount: response.usage.totalTokens,
          ...(references.length
            ? { references: references as unknown as Prisma.InputJsonValue }
            : {}),
        },
      }),
      prisma.aiConversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() },
      }),
    ]);
  }

  return {
    isConfigured(): boolean {
      return client.isConfigured();
    },

    async health() {
      return client.health();
    },

    async chat(input: AiChatInput, meta: AiRequestMeta = {}) {
      const startedAt = performance.now();
      const prepared = await prepare(input);
      const { conversation, workspaceId, context, messages } = prepared;

      try {
        const response = await client.chat({
          messages,
          context: context.sources,
          workspaceId,
          conversationId: conversation.id,
          operation: 'chat',
        });
        const references = filterReferences(response.references, context.sources);

        await persistSuccess(conversation.id, response, references);
        await usageService.record({
          userId: input.userId,
          workspaceId,
          conversationId: conversation.id,
          operation: 'chat',
          model: response.model,
          usage: response.usage,
          latencyMs: Math.round(performance.now() - startedAt),
          status: 'SUCCESS',
        });

        logger.info('ai_chat_completed', {
          conversationId: conversation.id,
          workspaceId,
          requestId: meta.requestId,
          tokens: response.usage.totalTokens,
        });

        return {
          conversationId: conversation.id,
          answer: response.content,
          references,
          model: response.model,
          usage: response.usage,
          sources: context.sources,
        };
      } catch (error) {
        const code =
          error instanceof AiUnavailableError || error instanceof AiProviderError
            ? error.code
            : 'AI_PROVIDER_ERROR';
        await usageService
          .record({
            userId: input.userId,
            workspaceId,
            conversationId: conversation.id,
            operation: 'chat',
            status: 'FAILURE',
            errorCode: code,
            latencyMs: Math.round(performance.now() - startedAt),
          })
          .catch(() => undefined);
        logger.warn('ai_chat_failed', {
          conversationId: conversation.id,
          workspaceId,
          requestId: meta.requestId,
          code,
        });
        mapProviderError(error);
      }
    },

    async *streamChat(
      input: AiChatInput,
      meta: AiRequestMeta = {},
    ): AsyncGenerator<AiChatStreamEvent> {
      const startedAt = performance.now();
      const prepared = await prepare(input);
      const { conversation, workspaceId, context, messages } = prepared;

      yield { type: 'conversation', conversationId: conversation.id };

      let content = '';
      let finalResponse: AiChatResponse | null = null;

      try {
        for await (const event of client.streamChat({
          messages,
          context: context.sources,
          workspaceId,
          conversationId: conversation.id,
          operation: 'chat_stream',
        })) {
          if (event.type === 'token') {
            content += event.content;
            yield event;
          } else if (event.type === 'references') {
            yield {
              type: 'references',
              references: filterReferences(event.references, context.sources),
            };
          } else if (event.type === 'done') {
            finalResponse = event.response;
          } else if (event.type === 'error') {
            throw new AiProviderError(event.message, event.code);
          }
        }

        const response: AiChatResponse = finalResponse ?? {
          content,
          model: config.aiModel || 'unknown',
          usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          },
          references: [],
        };

        const references = filterReferences(response.references, context.sources);
        await persistSuccess(conversation.id, response, references);
        await usageService.record({
          userId: input.userId,
          workspaceId,
          conversationId: conversation.id,
          operation: 'chat_stream',
          model: response.model,
          usage: response.usage,
          latencyMs: Math.round(performance.now() - startedAt),
          status: 'SUCCESS',
        });

        yield { type: 'done', response: { ...response, references } };
      } catch (error) {
        const code =
          error instanceof AiUnavailableError || error instanceof AiProviderError
            ? error.code
            : 'AI_PROVIDER_ERROR';
        await usageService
          .record({
            userId: input.userId,
            workspaceId,
            conversationId: conversation.id,
            operation: 'chat_stream',
            status: 'FAILURE',
            errorCode: code,
            latencyMs: Math.round(performance.now() - startedAt),
          })
          .catch(() => undefined);
        logger.warn('ai_stream_failed', {
          conversationId: conversation.id,
          workspaceId,
          requestId: meta.requestId,
          code,
        });
        yield {
          type: 'error',
          code,
          message: 'The AI service could not complete the streamed response',
        };
      }
    },

    async listConversations(
      userId: string,
      options: { workspaceId?: string | null; cursor?: string; limit?: number } = {},
    ) {
      if (options.workspaceId) {
        await requireWorkspaceAccess(prisma, {
          userId,
          workspaceId: options.workspaceId,
          capability: WorkspaceCapability.ViewWorkspace,
        });
      }

      const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
      const rows = await prisma.aiConversation.findMany({
        where: {
          userId,
          ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).map(conversationSummary);

      return {
        items,
        nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
      };
    },

    async getConversation(userId: string, conversationId: string) {
      const conversation = await resolveConversation(userId, conversationId);
      const messages = await prisma.aiMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 500,
      });

      return {
        ...conversationSummary(conversation),
        messages: messages.map(messageSummary),
      };
    },

    async deleteConversation(userId: string, conversationId: string) {
      await resolveConversation(userId, conversationId);
      await prisma.aiConversation.delete({ where: { id: conversationId } });
      return { deleted: true };
    },

    async usage(userId: string, workspaceId?: string | null) {
      if (workspaceId) {
        await requireWorkspaceAccess(prisma, {
          userId,
          workspaceId,
          capability: WorkspaceCapability.ViewWorkspace,
        });
      }
      return usageService.summary(userId, { workspaceId });
    },

    async pruneExpired() {
      const now = new Date();
      const conversationCutoff = new Date(
        now.getTime() - config.aiConversationRetentionDays * 86_400_000,
      );
      const writingCutoff = new Date(now.getTime() - config.aiWritingRetentionMinutes * 60_000);

      const [conversations, writingSessions] = await Promise.all([
        prisma.aiConversation.deleteMany({
          where: { updatedAt: { lt: conversationCutoff } },
        }),
        prisma.aiWritingSession.deleteMany({
          where: {
            OR: [{ expiresAt: { lt: now } }, { createdAt: { lt: writingCutoff } }],
          },
        }),
      ]);

      return {
        conversations: conversations.count,
        writingSessions: writingSessions.count,
      };
    },
  };
}
