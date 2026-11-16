import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import type { AiUsage } from '../../services/providers/ai';
import { AppError } from '../../utils/errors';

/**
 * AI usage accounting and limits (Phase 21).
 *
 * Every call is recorded, including failed calls, so a provider outage is
 * visible and a single account cannot consume the workspace's budget without
 * a trace. PostgreSQL is the source of truth; PostgreSQL is the source of
 * truth; Redis is never the only record of usage.
 */

export interface AiUsageInput {
  userId: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  operation: string;
  model?: string | null;
  usage?: AiUsage | null;
  latencyMs?: number | null;
  status: 'SUCCESS' | 'FAILURE';
  errorCode?: string | null;
}

export interface AiUsageSummary {
  dailyRequests: number;
  dailyRequestLimit: number;
  monthlyTokens: number;
  monthlyTokenLimit: number;
  remainingDailyRequests: number;
  remainingMonthlyTokens: number;
  since: { day: string; month: string };
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function createAiUsageService(
  config: Pick<AppConfig, 'aiDailyRequestLimit' | 'aiMonthlyTokenLimit'>,
  prisma: PrismaClient = getPrismaClient(),
  now: () => Date = () => new Date(),
) {
  return {
    async record(input: AiUsageInput): Promise<void> {
      const usage = input.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      await prisma.aiUsageRecord.create({
        data: {
          userId: input.userId,
          workspaceId: input.workspaceId ?? null,
          conversationId: input.conversationId ?? null,
          operation: input.operation,
          model: input.model ?? null,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          latencyMs: input.latencyMs ?? null,
          status: input.status,
          errorCode: input.errorCode ?? null,
        },
      });
    },

    async summary(
      userId: string,
      options: { workspaceId?: string | null } = {},
    ): Promise<AiUsageSummary> {
      const current = now();
      const dayStart = startOfUtcDay(current);
      const monthStart = startOfUtcMonth(current);
      const scope = {
        userId,
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      };

      const [dailyRequests, monthly] = await Promise.all([
        prisma.aiUsageRecord.count({
          where: { ...scope, createdAt: { gte: dayStart } },
        }),
        prisma.aiUsageRecord.aggregate({
          where: { ...scope, createdAt: { gte: monthStart } },
          _sum: { totalTokens: true },
        }),
      ]);

      const monthlyTokens = monthly._sum.totalTokens ?? 0;

      return {
        dailyRequests,
        dailyRequestLimit: config.aiDailyRequestLimit,
        monthlyTokens,
        monthlyTokenLimit: config.aiMonthlyTokenLimit,
        remainingDailyRequests: Math.max(0, config.aiDailyRequestLimit - dailyRequests),
        remainingMonthlyTokens: Math.max(0, config.aiMonthlyTokenLimit - monthlyTokens),
        since: { day: dayStart.toISOString(), month: monthStart.toISOString() },
      };
    },

    async assertWithinLimits(userId: string, workspaceId?: string | null): Promise<void> {
      const current = now();
      const scope = { userId, ...(workspaceId ? { workspaceId } : {}) };

      const [dailyRequests, monthly] = await Promise.all([
        prisma.aiUsageRecord.count({
          where: { ...scope, createdAt: { gte: startOfUtcDay(current) } },
        }),
        prisma.aiUsageRecord.aggregate({
          where: { ...scope, createdAt: { gte: startOfUtcMonth(current) } },
          _sum: { totalTokens: true },
        }),
      ]);

      if (dailyRequests >= config.aiDailyRequestLimit) {
        throw new AppError(
          429,
          'AI_USAGE_LIMIT_EXCEEDED',
          'Your daily AI request limit has been reached. Try again tomorrow.',
          {
            details: {
              limit: config.aiDailyRequestLimit,
              resetAt: new Date(startOfUtcDay(current).getTime() + 86_400_000).toISOString(),
            },
          },
        );
      }

      const monthlyTokens = monthly._sum.totalTokens ?? 0;
      if (monthlyTokens >= config.aiMonthlyTokenLimit) {
        throw new AppError(
          429,
          'AI_USAGE_LIMIT_EXCEEDED',
          'Your monthly AI token limit has been reached.',
          {
            details: {
              limit: config.aiMonthlyTokenLimit,
              used: monthlyTokens,
              resetAt: new Date(
                Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1),
              ).toISOString(),
            },
          },
        );
      }

      // Per-workspace rate limits: cap aggregate workspace AI usage.
      if (workspaceId) {
        const [wsDaily, wsMonthly] = await Promise.all([
          prisma.aiUsageRecord.count({
            where: { workspaceId, createdAt: { gte: startOfUtcDay(current) } },
          }),
          prisma.aiUsageRecord.aggregate({
            where: { workspaceId, createdAt: { gte: startOfUtcMonth(current) } },
            _sum: { totalTokens: true },
          }),
        ]);
        if (wsDaily >= config.aiDailyRequestLimit) {
          throw new AppError(
            429,
            'AI_WORKSPACE_LIMIT_EXCEEDED',
            'This workspace has reached its daily AI request limit. Try again tomorrow.',
            { details: { limit: config.aiDailyRequestLimit } },
          );
        }
        const wsMonthlyTokens = wsMonthly._sum.totalTokens ?? 0;
        if (wsMonthlyTokens >= config.aiMonthlyTokenLimit) {
          throw new AppError(
            429,
            'AI_WORKSPACE_LIMIT_EXCEEDED',
            'This workspace has reached its monthly AI token limit.',
            { details: { limit: config.aiMonthlyTokenLimit, used: wsMonthlyTokens } },
          );
        }
      }
    },
  };
}
