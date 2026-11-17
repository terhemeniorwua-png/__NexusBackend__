import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  createEventSchema,
  calendarWorkspaceParamsSchema,
  eventParamsSchema,
  invitationParamsSchema,
  invitationSchema,
  listEventsQuerySchema,
  updateEventSchema,
  type CreateEventInput,
  type ListEventsQuery,
  type UpdateEventInput,
} from './calendar.schemas';
import { createCalendarService } from './calendar.service';
import { userWorkspaceAccessContext } from '../workspaces/authorization';

export interface CalendarRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createCalendarService>;
}

function requireAuth(req: Request) {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in');
  return req.auth;
}
function userId(req: Request): string { return requireAuth(req).userId; }

export function createCalendarRouter({
  config,
  service = createCalendarService(),
}: CalendarRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuthMiddleware = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();

  router.get('/', requireAuthMiddleware, requireActiveAccount,
    validate({ params: calendarWorkspaceParamsSchema, query: listEventsQuerySchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      const query = req.validated!.query as ListEventsQuery;
      const auth = requireAuth(req);
      sendSuccess(res, await service.list({ userId: auth.userId, workspaceId, context: userWorkspaceAccessContext(auth), ...query }));
    });

  router.post('/', requireAuthMiddleware, requireActiveAccount,
    validate({ params: calendarWorkspaceParamsSchema, body: createEventSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      const body = req.validated!.body as CreateEventInput;
      const auth = requireAuth(req);
      sendSuccess(res, await service.create({ userId: auth.userId, workspaceId, context: userWorkspaceAccessContext(auth), ...body }), 201);
    });

  router.get('/:eventId', requireAuthMiddleware, requireActiveAccount,
    validate({ params: eventParamsSchema }),
    async (req, res) => {
      const { workspaceId, eventId } = req.validated!.params as { workspaceId: string; eventId: string };
      const auth = requireAuth(req);
      sendSuccess(res, await service.get({ userId: auth.userId, workspaceId, context: userWorkspaceAccessContext(auth), eventId }));
    });

  router.patch('/:eventId', requireAuthMiddleware, requireActiveAccount,
    validate({ params: eventParamsSchema, body: updateEventSchema }),
    async (req, res) => {
      const { workspaceId, eventId } = req.validated!.params as { workspaceId: string; eventId: string };
      const body = req.validated!.body as UpdateEventInput;
      const auth = requireAuth(req);
      sendSuccess(res, await service.update({ userId: auth.userId, workspaceId, context: userWorkspaceAccessContext(auth), eventId, ...body }));
    });

  router.post('/:eventId/cancel', requireAuthMiddleware, requireActiveAccount,
    validate({ params: eventParamsSchema }),
    async (req, res) => {
      const { workspaceId, eventId } = req.validated!.params as { workspaceId: string; eventId: string };
      const auth = requireAuth(req);
      await service.cancel({ userId: auth.userId, workspaceId, context: userWorkspaceAccessContext(auth), eventId });
      sendSuccess(res, { ok: true });
    });

  router.delete('/:eventId', requireAuthMiddleware, requireActiveAccount,
    validate({ params: eventParamsSchema }),
    async (req, res) => {
      const { workspaceId, eventId } = req.validated!.params as { workspaceId: string; eventId: string };
      const auth = requireAuth(req);
      await service.delete({ userId: auth.userId, workspaceId, context: userWorkspaceAccessContext(auth), eventId });
      sendSuccess(res, { ok: true });
    });

  router.get('/:eventId/invitations', requireAuthMiddleware, requireActiveAccount,
    validate({ params: eventParamsSchema }),
    async (req, res) => {
      const { workspaceId, eventId } = req.validated!.params as { workspaceId: string; eventId: string };
      const auth = requireAuth(req);
      sendSuccess(res, await service.listInvitations({ userId: auth.userId, workspaceId, context: userWorkspaceAccessContext(auth), eventId }));
    });

  router.post('/:eventId/invitations', requireAuthMiddleware, requireActiveAccount,
    validate({ params: eventParamsSchema, body: invitationSchema }),
    async (req, res) => {
      const { workspaceId, eventId } = req.validated!.params as { workspaceId: string; eventId: string };
      const { userId: targetUserId } = req.validated!.body as { userId: string };
      const auth = requireAuth(req);
      await service.addInvitee({ userId: auth.userId, workspaceId, context: userWorkspaceAccessContext(auth), eventId, targetUserId });
      sendSuccess(res, { ok: true }, 201);
    });

  router.delete('/:eventId/invitations/:userId', requireAuthMiddleware, requireActiveAccount,
    validate({ params: invitationParamsSchema }),
    async (req, res) => {
      const { workspaceId, eventId, userId: targetUserId } = req.validated!.params as {
        workspaceId: string; eventId: string; userId: string;
      };
      const auth = requireAuth(req);
      await service.removeInvitee({ userId: auth.userId, workspaceId, context: userWorkspaceAccessContext(auth), eventId, targetUserId });
      sendSuccess(res, { ok: true });
    });

  router.post('/:eventId/respond', requireAuthMiddleware, requireActiveAccount,
    validate({
      params: eventParamsSchema,
      body: z.object({ status: z.enum(['ACCEPTED', 'DECLINED', 'TENTATIVE']) }),
    }),
    async (req, res) => {
      const { workspaceId, eventId } = req.validated!.params as { workspaceId: string; eventId: string };
      const { status } = req.validated!.body as { status: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' };
      const auth = requireAuth(req);
      await service.respondToInvitation({ userId: auth.userId, workspaceId, context: userWorkspaceAccessContext(auth), eventId, status });
      sendSuccess(res, { ok: true });
    });

  return router;
}
