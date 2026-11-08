import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  listNotificationsQuerySchema,
  markReadSchema,
  preferenceParamsSchema,
  updatePreferenceSchema,
  type ListNotificationsQuery,
  type MarkReadInput,
  type UpdatePreferenceInput,
} from './notification.schemas';
import { createNotificationService } from './notification.service';

export interface NotificationRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createNotificationService>;
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in');
  return req.auth.userId;
}

export function createNotificationRouter({
  config,
  service = createNotificationService(),
}: NotificationRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();

  // List notifications for the current user
  router.get(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ query: listNotificationsQuerySchema }),
    async (req, res) => {
      const query = req.validated!.query as ListNotificationsQuery;
      sendSuccess(
        res,
        await service.list({
          userId: userId(req),
          cursor: query.cursor,
          limit: query.limit,
          unreadOnly: query.unreadOnly,
          type: query.type,
        }),
      );
    },
  );

  // Get unread count
  router.get(
    '/unread-count',
    requireAuth,
    requireActiveAccount,
    async (_req, res) => {
      sendSuccess(res, await service.getUnreadCount({ userId: userId(_req) }));
    },
  );

  // Mark specific notifications as read
  router.post(
    '/read',
    requireAuth,
    requireActiveAccount,
    validate({ body: markReadSchema }),
    async (req, res) => {
      const body = req.validated!.body as MarkReadInput;
      await service.markRead({ userId: userId(req), notificationIds: body.notificationIds });
      sendSuccess(res, { ok: true });
    },
  );

  // Mark all as read
  router.post(
    '/read-all',
    requireAuth,
    requireActiveAccount,
    async (req, res) => {
      await service.markAllRead({ userId: userId(req) });
      sendSuccess(res, { ok: true });
    },
  );

  // List notification preferences for a workspace
  router.get(
    '/preferences/:workspaceId',
    requireAuth,
    requireActiveAccount,
    validate({ params: preferenceParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(
        res,
        await service.listPreferences({ userId: userId(req), workspaceId }),
      );
    },
  );

  // Update a notification preference
  router.put(
    '/preferences/:workspaceId',
    requireAuth,
    requireActiveAccount,
    validate({ params: preferenceParamsSchema, body: updatePreferenceSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      const body = req.validated!.body as UpdatePreferenceInput;
      await service.updatePreference({
        userId: userId(req),
        workspaceId,
        type: body.type,
        inAppEnabled: body.inAppEnabled,
      });
      sendSuccess(res, { ok: true });
    },
  );

  // Activity feed for a workspace
  router.get(
    '/activity/:workspaceId',
    requireAuth,
    requireActiveAccount,
    validate({
      params: preferenceParamsSchema,
      query: listNotificationsQuerySchema.omit({ type: true, unreadOnly: true }),
    }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      const query = req.validated!.query as { cursor?: string; limit: number };
      sendSuccess(
        res,
        await service.listActivity({
          userId: userId(req),
          workspaceId,
          cursor: query.cursor,
          limit: query.limit,
        }),
      );
    },
  );

  return router;
}
