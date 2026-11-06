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

export interface CalendarRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createCalendarService>;
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in');
  return req.auth.userId;
}

export function createCalendarRouter({
  config,
  service = createCalendarService(),
}: CalendarRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();

  router.get('/', requireAuth, requireActiveAccount,
    validate({ params: calendarWorkspaceParamsSchema, query: listEventsQuerySchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      const query = req.validated!.query as ListEventsQuery;
      sendSuccess(res, await service.list({ userId: userId(req), workspaceId, ...query }));
    });

  router.post('/', requireAuth, requireActiveAccount,
    validate({ params: calendarWorkspaceParamsSchema, body: createEventSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      const body = req.validated!.body as CreateEventInput;
      sendSuccess(res, await service.create({ userId: userId(req), workspaceId, ...body }), 201);
    });

  router.get('/:eventId', requireAuth, requireActiveAccount,
    validate({ params: eventParamsSchema }),
    async (req, res) => {
      const { workspaceId, eventId } = req.validated!.params as { workspaceId: string; eventId: string };
      sendSuccess(res, await service.get({ userId: userId(req), workspaceId, eventId }));
    });

  router.patch('/:eventId', requireAuth, requireActiveAccount,
    validate({ params: eventParamsSchema, body: updateEventSchema }),
    async (req, res) => {
      const { workspaceId, eventId } = req.validated!.params as { workspaceId: string; eventId: string };
      const body = req.validated!.body as UpdateEventInput;
      sendSuccess(res, await service.update({ userId: userId(req), workspaceId, eventId, ...body }));
    });

  router.post('/:eventId/cancel', requireAuth, requireActiveAccount,
    validate({ params: eventParamsSchema }),
    async (req, res) => {
      const { workspaceId, eventId } = req.validated!.params as { workspaceId: string; eventId: string };
      await service.cancel({ userId: userId(req), workspaceId, eventId });
      sendSuccess(res, { ok: true });
    });

  router.delete('/:eventId', requireAuth, requireActiveAccount,
    validate({ params: eventParamsSchema }),
    async (req, res) => {
      const { workspaceId, eventId } = req.validated!.params as { workspaceId: string; eventId: string };
      await service.delete({ userId: userId(req), workspaceId, eventId });
      sendSuccess(res, { ok: true });
    });

  router.get('/:eventId/invitations', requireAuth, requireActiveAccount,
    validate({ params: eventParamsSchema }),
    async (req, res) => {
      const { workspaceId, eventId } = req.validated!.params as { workspaceId: string; eventId: string };
      sendSuccess(res, await service.listInvitations({ userId: userId(req), workspaceId, eventId }));
    });

  router.post('/:eventId/invitations', requireAuth, requireActiveAccount,
    validate({ params: eventParamsSchema, body: invitationSchema }),
    async (req, res) => {
      const { workspaceId, eventId } = req.validated!.params as { workspaceId: string; eventId: string };
      const { userId: targetUserId } = req.validated!.body as { userId: string };
      await service.addInvitee({ userId: userId(req), workspaceId, eventId, targetUserId });
      sendSuccess(res, { ok: true }, 201);
    });

  router.delete('/:eventId/invitations/:userId', requireAuth, requireActiveAccount,
    validate({ params: invitationParamsSchema }),
    async (req, res) => {
      const { workspaceId, eventId, userId: targetUserId } = req.validated!.params as {
        workspaceId: string; eventId: string; userId: string;
      };
      await service.removeInvitee({ userId: userId(req), workspaceId, eventId, targetUserId });
      sendSuccess(res, { ok: true });
    });

  router.post('/:eventId/respond', requireAuth, requireActiveAccount,
    validate({
      params: eventParamsSchema,
      body: z.object({ status: z.enum(['ACCEPTED', 'DECLINED', 'TENTATIVE']) }),
    }),
    async (req, res) => {
      const { workspaceId, eventId } = req.validated!.params as { workspaceId: string; eventId: string };
      const { status } = req.validated!.body as { status: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' };
      await service.respondToInvitation({ userId: userId(req), workspaceId, eventId, status });
      sendSuccess(res, { ok: true });
    });

  return router;
}
