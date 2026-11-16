import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  analyticsQuerySchema,
  analyticsScopedQuerySchema,
  type AnalyticsQuery,
  type AnalyticsScopedQuery,
} from './analytics.schemas';
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
        projectId: q.projectId ?? null,
        range: q.range,
        ...(q.startDate ? { startDate: new Date(q.startDate) } : {}),
        ...(q.endDate ? { endDate: new Date(q.endDate) } : {}),
      });

      sendSuccess(res, snapshot);
    },
  );

  const scoped = (handler: (q: AnalyticsScopedQuery, uid: string) => Promise<unknown>) => {
    return [
      requireAuth,
      requireActive,
      validate({ query: analyticsScopedQuerySchema }),
      async (req: Request, res: import('express').Response) => {
        const q = req.validated!.query as AnalyticsScopedQuery;
        sendSuccess(res, await handler(q, userId(req)));
      },
    ] as const;
  };

  router.get(
    '/tasks/by-status',
    ...scoped((q, uid) =>
      service.tasksByStatus({
        userId: uid,
        workspaceId: q.workspaceId,
        projectId: q.projectId ?? null,
        range: q.range,
        ...(q.startDate ? { startDate: new Date(q.startDate) } : {}),
        ...(q.endDate ? { endDate: new Date(q.endDate) } : {}),
      }),
    ),
  );

  router.get(
    '/tasks/by-assignee',
    ...scoped((q, uid) =>
      service.tasksByAssignee({
        userId: uid,
        workspaceId: q.workspaceId,
        projectId: q.projectId ?? null,
        range: q.range,
        ...(q.startDate ? { startDate: new Date(q.startDate) } : {}),
        ...(q.endDate ? { endDate: new Date(q.endDate) } : {}),
      }),
    ),
  );

  router.get(
    '/tasks/throughput',
    ...scoped((q, uid) =>
      service.tasksThroughput({
        userId: uid,
        workspaceId: q.workspaceId,
        projectId: q.projectId ?? null,
        range: q.range,
        ...(q.startDate ? { startDate: new Date(q.startDate) } : {}),
        ...(q.endDate ? { endDate: new Date(q.endDate) } : {}),
      }),
    ),
  );

  router.get(
    '/tasks/workload',
    ...scoped((q, uid) =>
      service.tasksWorkload({
        userId: uid,
        workspaceId: q.workspaceId,
        projectId: q.projectId ?? null,
        range: q.range,
        ...(q.startDate ? { startDate: new Date(q.startDate) } : {}),
        ...(q.endDate ? { endDate: new Date(q.endDate) } : {}),
      }),
    ),
  );

  router.get(
    '/time-logged',
    ...scoped((q, uid) =>
      service.timeLogged({
        userId: uid,
        workspaceId: q.workspaceId,
        projectId: q.projectId ?? null,
        range: q.range,
        ...(q.startDate ? { startDate: new Date(q.startDate) } : {}),
        ...(q.endDate ? { endDate: new Date(q.endDate) } : {}),
      }),
    ),
  );

  return router;
}
