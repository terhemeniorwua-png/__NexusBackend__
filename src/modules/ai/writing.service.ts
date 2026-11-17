import type { Prisma, PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import {
  AiProviderError,
  AiUnavailableError,
  createAiClient,
  type AiClient,
  type AiWritingSuggestion,
} from '../../services/providers/ai';
import { AppError } from '../../utils/errors';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import { requireWorkspaceAccess, WorkspaceCapability } from '../authorization';
import type { WorkspaceAccessContext } from '../authorization/workspace.policy';
import { createAiUsageService } from './ai-usage.service';

/**
 * Nexus Write (Phase 22).
 *
 * Analysis never changes the user's text. Suggestions are stored with the
 * original text for a short retention window, and the accept endpoint returns
 * the resulting text to the client. The backend does not write into a
 * document, message or comment unless the user's editor applies the returned
 * value and saves it through the normal document API.
 */

export interface WritingServiceDependencies {
  prisma?: PrismaClient;
  client?: AiClient;
  logger?: Logger;
  usageService?: ReturnType<typeof createAiUsageService>;
  now?: () => Date;
}

export interface AnalyzeWritingInput {
  userId: string;
  workspaceId?: string | null;
  text: string;
  features: string[];
  language?: string;
  toneTarget?: string;
}

export interface RewriteWritingInput {
  userId: string;
  workspaceId?: string | null;
  text: string;
  instruction: string;
  tone?: string;
  operation?: string;
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
    throw new AppError(502, error.code, 'The AI service could not complete the writing request');
  }
  throw new AppError(
    502,
    'AI_PROVIDER_ERROR',
    'The AI service could not complete the writing request',
  );
}

function readSuggestions(value: Prisma.JsonValue): AiWritingSuggestion[] {
  if (!Array.isArray(value)) return [];
  const suggestions: AiWritingSuggestion[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.id === 'string' &&
      typeof candidate.original === 'string' &&
      typeof candidate.replacement === 'string' &&
      typeof candidate.offset === 'number' &&
      typeof candidate.length === 'number'
    ) {
      suggestions.push(candidate as unknown as AiWritingSuggestion);
    }
  }
  return suggestions;
}

export function applySuggestions(original: string, suggestions: AiWritingSuggestion[]): string {
  const candidates = suggestions
    .filter((suggestion) => Number.isInteger(suggestion.offset) && suggestion.offset >= 0)
    .filter((suggestion) => suggestion.offset <= original.length)
    .filter((suggestion) => Number.isInteger(suggestion.length) && suggestion.length >= 0)
    .sort((a, b) => a.offset - b.offset || b.length - a.length);

  // Resolve overlapping suggestions before touching the text. Nested fixes are
  // common (an outer phrase rewrite that contains an inner grammar fix), so we
  // prefer the earliest, longest span and discard anything that overlaps it.
  // Applying an inner fix first would leave a half-rewritten phrase.
  const selected: AiWritingSuggestion[] = [];
  let coveredEnd = 0;
  for (const suggestion of candidates) {
    if (suggestion.offset < coveredEnd) continue;
    selected.push(suggestion);
    coveredEnd = suggestion.offset + suggestion.length;
  }

  let result = original;
  // Apply from the end so an earlier offset stays valid after a later edit
  // changes the length of the string.
  for (const suggestion of [...selected].sort((a, b) => b.offset - a.offset)) {
    const declaredEnd = suggestion.offset + suggestion.length;
    const actual = original.slice(suggestion.offset, declaredEnd);
    const matches = !suggestion.original || actual === suggestion.original;

    if (matches) {
      result =
        result.slice(0, suggestion.offset) + suggestion.replacement + result.slice(declaredEnd);
      continue;
    }

    // The provider offsets may be approximate. Fall back to an exact match of
    // the original fragment, still without touching anything else.
    const index = original.indexOf(suggestion.original, suggestion.offset);
    if (index >= 0) {
      result =
        result.slice(0, index) +
        suggestion.replacement +
        result.slice(index + suggestion.original.length);
    }
  }

  return result;
}

export function createWritingService(
  config: AppConfig,
  dependencies: WritingServiceDependencies = {},
) {
  const prisma = dependencies.prisma ?? getPrismaClient();
  const logger = dependencies.logger ?? defaultLogger;
  const now = dependencies.now ?? (() => new Date());
  const client = dependencies.client ?? createAiClient(config);
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

  async function verifyWorkspace(userId: string, workspaceId?: string | null): Promise<void> {
    if (!workspaceId) return;
    await requireWorkspaceAccess(prisma, {
      userId,
      workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
           context: (input as { context: WorkspaceAccessContext }).context,
      });
  }

  return {
    async analyze(input: AnalyzeWritingInput) {
      ensureConfigured();
      await verifyWorkspace(input.userId, input.workspaceId);
      await usageService.assertWithinLimits(input.userId, input.workspaceId);

      const startedAt = performance.now();

      try {
        const result = await client.analyzeWriting({
          text: input.text,
          features: input.features,
          ...(input.language ? { language: input.language } : {}),
          ...(input.toneTarget ? { toneTarget: input.toneTarget } : {}),
          workspaceId: input.workspaceId ?? null,
          operation: 'writing_analyze',
        });

        const expiresAt = new Date(now().getTime() + config.aiWritingRetentionMinutes * 60_000);
        const session = await prisma.aiWritingSession.create({
          data: {
            userId: input.userId,
            workspaceId: input.workspaceId ?? null,
            originalText: input.text,
            suggestions: result.suggestions as unknown as Prisma.InputJsonValue,
            detectedTone: result.detectedTone ?? null,
            summary: result.summary ?? null,
            expiresAt,
          },
        });

        await usageService.record({
          userId: input.userId,
          workspaceId: input.workspaceId,
          operation: 'writing_analyze',
          model: result.model,
          usage: result.usage,
          latencyMs: Math.round(performance.now() - startedAt),
          status: 'SUCCESS',
        });

        return {
          sessionId: session.id,
          suggestions: result.suggestions,
          detectedTone: result.detectedTone ?? null,
          summary: result.summary ?? null,
          usage: result.usage,
          expiresAt: expiresAt.toISOString(),
        };
      } catch (error) {
        await usageService
          .record({
            userId: input.userId,
            workspaceId: input.workspaceId,
            operation: 'writing_analyze',
            status: 'FAILURE',
            errorCode:
              error instanceof AiUnavailableError || error instanceof AiProviderError
                ? error.code
                : 'AI_PROVIDER_ERROR',
            latencyMs: Math.round(performance.now() - startedAt),
          })
          .catch(() => undefined);
        logger.warn('ai_writing_analyze_failed', { userId: input.userId });
        mapProviderError(error);
      }
    },

    async rewrite(input: RewriteWritingInput) {
      ensureConfigured();
      await verifyWorkspace(input.userId, input.workspaceId);
      await usageService.assertWithinLimits(input.userId, input.workspaceId);

      const operation = input.operation ?? 'writing_rewrite';
      const startedAt = performance.now();

      try {
        const result = await client.rewrite({
          text: input.text,
          instruction: input.instruction,
          ...(input.tone ? { tone: input.tone } : {}),
          workspaceId: input.workspaceId ?? null,
          operation,
        });

        await usageService.record({
          userId: input.userId,
          workspaceId: input.workspaceId,
          operation,
          model: result.model,
          usage: result.usage,
          latencyMs: Math.round(performance.now() - startedAt),
          status: 'SUCCESS',
        });

        return {
          text: result.text,
          explanation: result.explanation ?? null,
          usage: result.usage,
        };
      } catch (error) {
        await usageService
          .record({
            userId: input.userId,
            workspaceId: input.workspaceId,
            operation,
            status: 'FAILURE',
            errorCode:
              error instanceof AiUnavailableError || error instanceof AiProviderError
                ? error.code
                : 'AI_PROVIDER_ERROR',
            latencyMs: Math.round(performance.now() - startedAt),
          })
          .catch(() => undefined);
        logger.warn('ai_writing_rewrite_failed', { userId: input.userId, operation });
        mapProviderError(error);
      }
    },

    async acceptSuggestion(userId: string, sessionId: string, suggestionIds: string[]) {
      const session = await prisma.aiWritingSession.findFirst({
        where: { id: sessionId, userId },
      });
      if (!session) {
        throw new AppError(
          404,
          'AI_WRITING_SESSION_NOT_FOUND',
          'That writing session does not exist',
        );
      }
      if (session.status !== 'ACTIVE') {
        throw new AppError(
          409,
          'AI_WRITING_SESSION_CLOSED',
          'That writing session is no longer active',
        );
      }
      if (session.expiresAt.getTime() <= now().getTime()) {
        await prisma.aiWritingSession.update({
          where: { id: session.id },
          data: { status: 'EXPIRED', originalText: '' },
        });
        throw new AppError(410, 'AI_WRITING_SESSION_EXPIRED', 'That writing session has expired');
      }

      const suggestions = readSuggestions(session.suggestions);
      const selected = suggestions.filter((suggestion) => suggestionIds.includes(suggestion.id));
      if (selected.length === 0) {
        throw new AppError(
          400,
          'AI_SUGGESTION_NOT_FOUND',
          'None of the supplied suggestions belong to this session',
        );
      }

      const text = applySuggestions(session.originalText, selected);

      await prisma.aiWritingSession.update({
        where: { id: session.id },
        data: {
          status: 'ACCEPTED',
          acceptedAt: now(),
          acceptedSuggestionIds: selected.map((suggestion) => suggestion.id),
          // The original is no longer needed once the caller has the result.
          originalText: '',
        },
      });

      return {
        sessionId: session.id,
        text,
        appliedSuggestionIds: selected.map((suggestion) => suggestion.id),
      };
    },

    async dismissSession(userId: string, sessionId: string) {
      const session = await prisma.aiWritingSession.findFirst({
        where: { id: sessionId, userId },
      });
      if (!session) {
        throw new AppError(
          404,
          'AI_WRITING_SESSION_NOT_FOUND',
          'That writing session does not exist',
        );
      }

      await prisma.aiWritingSession.update({
        where: { id: session.id },
        data: {
          status: 'DISMISSED',
          dismissedAt: now(),
          originalText: '',
        },
      });

      return { sessionId: session.id, dismissed: true };
    },
  };
}
