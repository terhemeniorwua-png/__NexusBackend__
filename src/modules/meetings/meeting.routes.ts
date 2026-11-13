import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { z } from 'zod';
import {
  createMeetingSchema, listMeetingsQuerySchema, meetingParamsSchema,
  meetingWorkspaceParams, participantParamsSchema, updateMeetingSchema,
  type CreateMeetingInput, type ListMeetingsQuery, type UpdateMeetingInput,
} from './meeting.schemas';
import { createCollaborationEmailNotifier } from '../../services/collaboration-email-notifier';
import { createMeetingService } from './meeting.service';
import { createLivekitToken, livekitConfig } from '../../lib/livekit';

export interface MeetingRouterOptions { config: AppConfig; service?: ReturnType<typeof createMeetingService> }

function userId(req: Request): string { if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in'); return req.auth.userId; }

export function createMeetingRouter({ config, service = createMeetingService(undefined, { meetingNotifier: createCollaborationEmailNotifier(config) }) }: MeetingRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get('/', requireAuth, requireActive, validate({ params: meetingWorkspaceParams, query: listMeetingsQuerySchema }), async (req, res) => {
    const { workspaceId } = req.validated!.params as { workspaceId: string };
    const q = req.validated!.query as ListMeetingsQuery;
    sendSuccess(res, await service.list({ userId: userId(req), workspaceId, ...q }));
  });

  router.post('/', requireAuth, requireActive, validate({ params: meetingWorkspaceParams, body: createMeetingSchema }), async (req, res) => {
    const { workspaceId } = req.validated!.params as { workspaceId: string };
    const body = req.validated!.body as CreateMeetingInput;
    sendSuccess(res, await service.create({ userId: userId(req), workspaceId, ...body }), 201);
  });

  router.get('/:meetingId', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    sendSuccess(res, await service.get({ userId: userId(req), workspaceId, meetingId }));
  });

  router.patch('/:meetingId', requireAuth, requireActive, validate({ params: meetingParamsSchema, body: updateMeetingSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    const body = req.validated!.body as UpdateMeetingInput;
    sendSuccess(res, await service.update({ userId: userId(req), workspaceId, meetingId, ...body }));
  });

  router.delete('/:meetingId', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    await service.delete({ userId: userId(req), workspaceId, meetingId });
    sendSuccess(res, { ok: true });
  });

  router.post('/:meetingId/token', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    const uid = userId(req);
    // Throws 403/404 unless this user may access the meeting.
    const meeting = await service.get({ userId: uid, workspaceId, meetingId });
    if (meeting.status === 'ENDED' || meeting.status === 'CANCELLED') {
      throw new AppError(409, 'MEETING_NOT_JOINABLE', 'This meeting is no longer available to join');
    }
    const room = `ws:${workspaceId}:meeting:${meetingId}`;
    let token: string;
    let url: string;
    try {
      token = await createLivekitToken({ userId: uid, displayName: req.auth!.name, room });
      url = livekitConfig.url;
    } catch {
      throw new AppError(503, 'CALLS_UNAVAILABLE', 'Calls are not available right now');
    }
    sendSuccess(res, { token, url, room });
  });

  router.post('/:meetingId/join', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    await service.join({ userId: userId(req), workspaceId, meetingId });
    sendSuccess(res, { ok: true });
  });

  router.post('/:meetingId/leave', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    await service.leave({ userId: userId(req), workspaceId, meetingId });
    sendSuccess(res, { ok: true });
  });

  router.get('/:meetingId/participants', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    sendSuccess(res, await service.listParticipants({ userId: userId(req), workspaceId, meetingId }));
  });

  router.post('/:meetingId/participants', requireAuth, requireActive, validate({ params: meetingParamsSchema, body: z.object({ userId: z.string().uuid() }) }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    const { userId: targetUserId } = req.validated!.body as { userId: string };
    await service.addParticipant({ userId: userId(req), workspaceId, meetingId, targetUserId });
    sendSuccess(res, { ok: true }, 201);
  });

  router.delete('/:meetingId/participants/:userId', requireAuth, requireActive, validate({ params: participantParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId, userId: targetUserId } = req.validated!.params as { workspaceId: string; meetingId: string; userId: string };
    await service.removeParticipant({ userId: userId(req), workspaceId, meetingId, targetUserId });
    sendSuccess(res, { ok: true });
  });

  return router;
}
