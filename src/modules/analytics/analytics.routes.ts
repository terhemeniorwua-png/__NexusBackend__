import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { analyticsQuerySchema, type AnalyticsQuery } from './analytics.schemas';
import { createAnalyticsService } from './analytics.service';

export interface AnalyticsRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createAnalyticsService>;
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in');
  return req.auth.userId;
}

export function createAnalyticsRouter({
  config,
  service = createAnalyticsService({ config }),
}: AnalyticsRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get(
    '/',
    requireAuth,
    requireActive,
    validate({ query: analyticsQuerySchema }),
    async (req, res) => {
      const q = req.validated!.query as AnalyticsQuery;
      const snapshot = await service.getSnapshot({
        userId: userId(req),
        workspaceId: q.workspaceId ?? null,
        range: q.range,
        ...(q.startDate ? { startDate: new Date(q.startDate) } : {}),
        ...(q.endDate ? { endDate: new Date(q.endDate) } : {}),
      });

      sendSuccess(res, snapshot);
    },
  );

  return router;
}
