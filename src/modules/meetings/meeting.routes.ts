import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { userWorkspaceAccessContext } from '../workspaces/authorization';
import { sendSuccess } from '../../utils/http';
import { z } from 'zod';
import {
  createMeetingSchema, listMeetingsQuerySchema, meetingParamsSchema,
  meetingWorkspaceParams, participantParamsSchema, updateMeetingSchema,
  type CreateMeetingInput, type ListMeetingsQuery, type UpdateMeetingInput,
} from './meeting.schemas';
import { createCollaborationEmailNotifier } from '../../services/collaboration-email-notifier';
import { createMeetingService } from './meeting.service';
import { emitToUser } from '../../realtime/io-registry';
import { getPrismaClient } from '../../db/prisma';

const RING_TIMEOUT_MS = 30_000;
import { createLivekitToken, livekitConfig } from '../../lib/livekit';
import { RoomServiceClient, TrackType } from 'livekit-server-sdk';

export interface MeetingRouterOptions { config: AppConfig; service?: ReturnType<typeof createMeetingService> }

function authCtx(req: Request) { if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in'); return req.auth; }
function userId(req: Request): string { return authCtx(req).userId; }

export function createMeetingRouter({ config, service = createMeetingService(undefined, { meetingNotifier: createCollaborationEmailNotifier(config) }) }: MeetingRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get('/', requireAuth, requireActive, validate({ params: meetingWorkspaceParams, query: listMeetingsQuerySchema }), async (req, res) => {
    const { workspaceId } = req.validated!.params as { workspaceId: string };
    const q = req.validated!.query as ListMeetingsQuery;
    sendSuccess(res, await service.list({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, ...q }));
  });

  router.post('/', requireAuth, requireActive, validate({ params: meetingWorkspaceParams, body: createMeetingSchema }), async (req, res) => {
    const { workspaceId } = req.validated!.params as { workspaceId: string };
    const body = req.validated!.body as CreateMeetingInput;
    sendSuccess(res, await service.create({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, ...body }), 201);
  });

  router.get('/:meetingId', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    sendSuccess(res, await service.get({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, meetingId }));
  });

  router.patch('/:meetingId', requireAuth, requireActive, validate({ params: meetingParamsSchema, body: updateMeetingSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    const body = req.validated!.body as UpdateMeetingInput;
    const callerId = authCtx(req).userId;
    const meeting = await service.update({ userId: callerId, workspaceId, meetingId, context: userWorkspaceAccessContext(authCtx(req)), ...body });
    if (body.status === 'LIVE') {
      try {
        const people = await service.listParticipants({ userId: callerId, workspaceId, meetingId, context: userWorkspaceAccessContext(authCtx(req)) });
        const ws = await getPrismaClient().workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
        for (const p of people) {
          if (p.userId !== callerId && p.status === 'INVITED') {
            emitToUser(p.userId, 'call:incoming', {
              workspaceId,
              meetingId,
              title: meeting.title,
              callerId,
              callerName: req.auth?.name ?? 'Someone',
              workspaceName: ws?.name ?? 'a workspace',
            });
            const inviteeId = p.userId;
            const timer = setTimeout(() => {
              void (async () => {
                try {
                  const still = await getPrismaClient().meetingParticipant.findFirst({
                    where: { meetingId, userId: inviteeId, status: 'INVITED' },
                    select: { userId: true },
                  });
                  if (!still) return; // accepted or declined in time
                  const payload = { workspaceId, meetingId, title: meeting.title, callerId, calleeId: inviteeId };
                  emitToUser(inviteeId, 'call:missed', payload);
                  emitToUser(callerId, 'call:missed', payload);
                } catch {
                  // best-effort
                }
              })();
            }, RING_TIMEOUT_MS);
            timer.unref();
          }
        }
      } catch {
        // Ringing is best-effort and must never fail the update.
      }
    }
    sendSuccess(res, meeting);
  });

  router.delete('/:meetingId', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    await service.delete({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, meetingId });
    sendSuccess(res, { ok: true });
  });

  router.post('/:meetingId/token', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    const uid = authCtx(req).userId;
    // Throws 403/404 unless this user may access the meeting.
    const meeting = await service.get({ userId: uid, workspaceId, meetingId, context: userWorkspaceAccessContext(authCtx(req)) });
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

  // ---- Host controls ------------------------------------------------------
  const roomNameFor = (workspaceId: string, meetingId: string) => `ws:${workspaceId}:meeting:${meetingId}`;
  const roomClient = () => new RoomServiceClient(livekitConfig.httpUrl, livekitConfig.apiKey, livekitConfig.apiSecret);
  async function requireHost(req: Request, uid: string, workspaceId: string, meetingId: string) {
    const meeting = await service.get({ userId: uid, workspaceId, meetingId, context: userWorkspaceAccessContext(authCtx(req)) });
    if (meeting.createdById !== uid) throw new AppError(403, 'HOST_ONLY', 'Only the host can do this');
    return meeting;
  }

  router.post('/:meetingId/host/end', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    const uid = authCtx(req).userId;
    await requireHost(req, uid, workspaceId, meetingId);
    const meeting = await service.update({ userId: uid, workspaceId, meetingId, context: userWorkspaceAccessContext(authCtx(req)), status: 'ENDED' });
    try {
      // Closing the room disconnects everyone currently in the call.
      await roomClient().deleteRoom(roomNameFor(workspaceId, meetingId));
    } catch {
      // Room may not exist (nobody connected); the meeting is already ENDED.
    }
    sendSuccess(res, meeting);
  });

  router.post('/:meetingId/host/mute-all', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    const uid = authCtx(req).userId;
    await requireHost(req, uid, workspaceId, meetingId);
    const room = roomNameFor(workspaceId, meetingId);
    let muted = 0;
    try {
      const client = roomClient();
      const people = await client.listParticipants(room);
      for (const person of people) {
        if (person.identity === uid) continue;
        for (const track of person.tracks) {
          if (track.type === TrackType.AUDIO && !track.muted) {
            await client.mutePublishedTrack(room, person.identity, track.sid, true);
            muted += 1;
          }
        }
      }
    } catch {
      throw new AppError(503, 'CALLS_UNAVAILABLE', 'Calls are not available right now');
    }
    sendSuccess(res, { muted });
  });

  router.post('/:meetingId/host/remove', requireAuth, requireActive, validate({ params: meetingParamsSchema, body: z.object({ userId: z.string().uuid() }) }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    const { userId: targetId } = req.validated!.body as { userId: string };
    const uid = authCtx(req).userId;
    await requireHost(req, uid, workspaceId, meetingId);
    if (targetId === uid) throw new AppError(400, 'CANNOT_REMOVE_SELF', 'You cannot remove yourself');
    try {
      await roomClient().removeParticipant(roomNameFor(workspaceId, meetingId), targetId);
    } catch {
      // Already gone from the room.
    }
    sendSuccess(res, { ok: true });
  });

  router.post('/:meetingId/decline', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    const uid = authCtx(req).userId;
    // Throws 403/404 unless this user may see the meeting.
    const meeting = await service.get({ userId: uid, workspaceId, meetingId, context: userWorkspaceAccessContext(authCtx(req)) });
    const result = await getPrismaClient().meetingParticipant.updateMany({
      where: { meetingId, userId: uid, status: 'INVITED' },
      data: { status: 'DECLINED' },
    });
    if (result.count > 0 && meeting.createdById !== uid) {
      emitToUser(meeting.createdById, 'call:declined', {
        workspaceId,
        meetingId,
        title: meeting.title,
        userId: uid,
        userName: req.auth?.name ?? 'Someone',
      });
    }
    sendSuccess(res, { ok: true });
  });

  router.post('/:meetingId/join', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    await service.join({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, meetingId });
    sendSuccess(res, { ok: true });
  });

  router.post('/:meetingId/leave', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    await service.leave({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, meetingId });
    sendSuccess(res, { ok: true });
  });

  router.get('/:meetingId/participants', requireAuth, requireActive, validate({ params: meetingParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    sendSuccess(res, await service.listParticipants({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, meetingId }));
  });

  router.post('/:meetingId/participants', requireAuth, requireActive, validate({ params: meetingParamsSchema, body: z.object({ userId: z.string().uuid() }) }), async (req, res) => {
    const { workspaceId, meetingId } = req.validated!.params as { workspaceId: string; meetingId: string };
    const { userId: targetUserId } = req.validated!.body as { userId: string };
    await service.addParticipant({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, meetingId, targetUserId });
    sendSuccess(res, { ok: true }, 201);
  });

  router.delete('/:meetingId/participants/:userId', requireAuth, requireActive, validate({ params: participantParamsSchema }), async (req, res) => {
    const { workspaceId, meetingId, userId: targetUserId } = req.validated!.params as { workspaceId: string; meetingId: string; userId: string };
    await service.removeParticipant({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, meetingId, targetUserId });
    sendSuccess(res, { ok: true });
  });

  return router;
}
