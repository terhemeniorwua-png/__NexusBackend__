import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { z } from 'zod';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import { getPrismaClient } from '../../db/prisma';

export interface AuditRouterOptions { config: AppConfig }
function userId(req: Request): string { if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in'); return req.auth.userId; }

const auditQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  actorId: z.string().uuid().optional(),
  action: z.string().max(200).optional(),
  targetType: z.string().max(100).optional(),
});
const workspaceIdParams = z.object({ workspaceId: z.string().uuid() });

export function createAuditRouter({ config }: AuditRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();
  const prisma = getPrismaClient();

  router.get('/', requireAuth, requireActive,
    validate({ params: workspaceIdParams, query: auditQuerySchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      const q = req.validated!.query as { cursor?: string; limit: number; actorId?: string; action?: string; targetType?: string };

      // Only workspace owners/managers can access audit logs
      const access = await requireWorkspaceAccess(prisma, { userId: userId(req), workspaceId, capability: WorkspaceCapability.ManageMembers });
      if (access.effectiveRole !== 'OWNER' && access.effectiveRole !== 'PROJECT_MANAGER') {
        throw new AppError(403, 'INSUFFICIENT_ROLE', 'Only workspace managers can access audit logs');
      }

      const entries = await prisma.auditLog.findMany({
        where: {
          workspaceId,
          ...(q.actorId ? { actorId: q.actorId } : {}),
          ...(q.action ? { action: { contains: q.action, mode: 'insensitive' } } : {}),
          ...(q.targetType ? { targetType: q.targetType } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        include: { actor: { select: { id: true, name: true } } },
      });

      const hasMore = entries.length > q.limit;
      const items = (hasMore ? entries.slice(0, q.limit) : entries).map((e) => ({
        id: e.id, action: e.action, targetType: e.targetType, targetId: e.targetId,
        actor: e.actor ? { id: e.actor.id, name: e.actor.name } : null,
        metadata: e.metadata, createdAt: e.createdAt.toISOString(),
      }));
      const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;

      sendSuccess(res, { items, nextCursor });
    },
  );

  return router;
}
