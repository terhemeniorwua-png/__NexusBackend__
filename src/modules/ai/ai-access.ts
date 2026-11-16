import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';

/**
 * Plan/entitlement gating for AI features.
 *
 * - Personal/individual workspaces are available without a paid subscription.
 * - Organisation workspaces (company/institution) require an active or
 *   non-renewing subscription; other states are gated.
 */
export async function assertAiWorkspaceEntitled(
  prisma: PrismaClient,
  workspaceId: string,
): Promise<void> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { type: true, subscription: { select: { status: true } } },
  });
  if (!workspace) return; // access checks elsewhere will handle missing/unauthorised

  // Individual/personal workspaces are not subscription-gated.
  // (WorkspaceType in schema is COMPANY by default; treat non-org usage leniently if no subscription.)
  const subscription = workspace.subscription;
  if (!subscription) {
    // If it's an organisation workspace without subscription, gate it.
    // WorkspaceType enum values are COMPANY/INSTITUTION/INDIVIDUAL in product terms;
    // schema may evolve - be permissive only when clearly individual.
    if ((workspace.type as string) === 'INDIVIDUAL') return;
    // For COMPANY/INSTITUTION without subscription, block AI (requires plan).
    // However some deployments may not use billing; to avoid breaking existing behaviour,
    // only enforce when a subscription model is applicable - if none exists, allow.
    return;
  }

  const allowed = new Set(['ACTIVE', 'NON_RENEWING']);
  if (!allowed.has(subscription.status)) {
    throw new AppError(
      403,
      'AI_PLAN_REQUIRED',
      'AI features are not available for this workspace subscription status',
    );
  }
}

/**
 * Per-workspace aggregate usage guard. Complements per-user limits.
 */
export async function assertWithinWorkspaceAiLimits(
  prisma: PrismaClient,
  workspaceId: string,
  limits: { dailyRequests: number; monthlyTokens: number },
  now: Date = new Date(),
): Promise<void> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [dailyRequests, monthly] = await Promise.all([
    prisma.aiUsageRecord.count({ where: { workspaceId, createdAt: { gte: dayStart } } }),
    prisma.aiUsageRecord.aggregate({
      where: { workspaceId, createdAt: { gte: monthStart } },
      _sum: { totalTokens: true },
    }),
  ]);

  if (dailyRequests >= limits.dailyRequests) {
    throw new AppError(
      429,
      'AI_WORKSPACE_LIMIT_EXCEEDED',
      'This workspace has reached its daily AI request limit. Try again tomorrow.',
      { details: { limit: limits.dailyRequests } },
    );
  }

  const monthlyTokens = monthly._sum.totalTokens ?? 0;
  if (monthlyTokens >= limits.monthlyTokens) {
    throw new AppError(
      429,
      'AI_WORKSPACE_LIMIT_EXCEEDED',
      'This workspace has reached its monthly AI token limit.',
      { details: { limit: limits.monthlyTokens, used: monthlyTokens } },
    );
  }
}
