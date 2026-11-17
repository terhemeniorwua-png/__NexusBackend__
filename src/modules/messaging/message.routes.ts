import multer from 'multer';
import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { userWorkspaceAccessContext } from '../workspaces/authorization';
import { sendSuccess } from '../../utils/http';
import {
  addReactionSchema,
  channelMessageParamsSchema,
  editMessageSchema,
  listMessagesQuerySchema,
  messageParamsSchema,
  sendMessageSchema,
  type ListMessagesQuery,
  type SendMessageInput,
  type EditMessageInput,
  type AddReactionInput,
} from './message.schemas';
import { createMessageService } from './message.service';

export interface MessageRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createMessageService>;
}

function authCtx(req: Request) {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in');
  return req.auth;
}

export function createMessageRouter({
  config,
  service = createMessageService(),
}: MessageRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();

  const ALLOWED_AUDIO = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg'];
  const MAX_VOICE_MS = 5 * 60 * 1000;
  const voiceUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2, parts: 3 },
  }).single('audio');

  router.post(
    '/:channelId/voice',
    requireAuth,
    requireActiveAccount,
    validate({ params: channelMessageParamsSchema }),
    (req, res, next) => {
      voiceUpload(req, res, (error: unknown) => {
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          next(new AppError(413, 'VOICE_TOO_LARGE', 'The voice message is too large'));
        } else if (error) {
          next(new AppError(400, 'VOICE_UPLOAD_INVALID', 'Upload exactly one file in the audio field'));
        } else {
          next();
        }
      });
    },
    async (req, res) => {
      const { workspaceId, channelId } = req.validated!.params as { workspaceId: string; channelId: string };
      const file = req.file;
      if (!file) throw new AppError(400, 'VOICE_REQUIRED', 'An audio file is required');
      const mime = (file.mimetype.split(';')[0] ?? '').trim();
      if (!ALLOWED_AUDIO.includes(mime)) {
        throw new AppError(415, 'VOICE_TYPE_UNSUPPORTED', 'Unsupported audio type');
      }
      const durationMs = Math.round(Number(req.body?.durationMs));
      if (!Number.isFinite(durationMs) || durationMs < 500 || durationMs > MAX_VOICE_MS + 2000) {
        throw new AppError(400, 'VOICE_DURATION_INVALID', 'Voice messages must be between 0.5 seconds and 5 minutes');
      }
      const message = await service.sendVoice({
        userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, channelId, audio: file.buffer, mime, durationMs,
      });
      sendSuccess(res, message, 201);
    },
  );

  router.get(
    '/:channelId/messages/:messageId/audio',
    requireAuth,
    requireActiveAccount,
    validate({ params: messageParamsSchema }),
    async (req, res) => {
      const { workspaceId, channelId, messageId } = req.validated!.params as {
        workspaceId: string; channelId: string; messageId: string;
      };
      const audio = await service.getAudio({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, channelId, messageId });
      res.setHeader('Content-Type', audio.mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(audio.data);
    },
  );

  router.post(
    '/:channelId/messages',
    requireAuth,
    requireActiveAccount,
    validate({ params: channelMessageParamsSchema, body: sendMessageSchema }),
    async (req, res) => {
      const { workspaceId, channelId } = req.validated!.params as {
        workspaceId: string;
        channelId: string;
      };
      const body = req.validated!.body as SendMessageInput;
      const message = await service.send({
        userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)),
        workspaceId,
        channelId,
        body: body.body,
        parentId: body.parentId,
        clientTempId: body.clientTempId,
      });
      sendSuccess(res, { ...message, clientTempId: body.clientTempId }, 201);
    },
  );

  router.get(
    '/:channelId/messages',
    requireAuth,
    requireActiveAccount,
    validate({ params: channelMessageParamsSchema, query: listMessagesQuerySchema }),
    async (req, res) => {
      const { workspaceId, channelId } = req.validated!.params as {
        workspaceId: string;
        channelId: string;
      };
      const query = req.validated!.query as ListMessagesQuery;
      const result = await service.list({
        userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)),
        workspaceId,
        channelId,
        cursor: query.cursor,
        limit: query.limit,
        includeDeleted: query.includeDeleted,
      });
      sendSuccess(res, result);
    },
  );

  router.get(
    '/:channelId/messages/:messageId/replies',
    requireAuth,
    requireActiveAccount,
    validate({ params: messageParamsSchema }),
    async (req, res) => {
      const { workspaceId, channelId, messageId } = req.validated!.params as {
        workspaceId: string;
        channelId: string;
        messageId: string;
      };
      sendSuccess(
        res,
        await service.getReplies({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, channelId, messageId }),
      );
    },
  );

  router.patch(
    '/:channelId/messages/:messageId',
    requireAuth,
    requireActiveAccount,
    validate({ params: messageParamsSchema, body: editMessageSchema }),
    async (req, res) => {
      const { workspaceId, channelId, messageId } = req.validated!.params as {
        workspaceId: string;
        channelId: string;
        messageId: string;
      };
      const body = req.validated!.body as EditMessageInput;
      sendSuccess(
        res,
        await service.edit({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, channelId, messageId, body: body.body }),
      );
    },
  );

  router.delete(
    '/:channelId/messages/:messageId',
    requireAuth,
    requireActiveAccount,
    validate({ params: messageParamsSchema }),
    async (req, res) => {
      const { workspaceId, channelId, messageId } = req.validated!.params as {
        workspaceId: string;
        channelId: string;
        messageId: string;
      };
      await service.delete({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, channelId, messageId });
      sendSuccess(res, { ok: true });
    },
  );

  router.post(
    '/:channelId/messages/:messageId/pin',
    requireAuth,
    requireActiveAccount,
    validate({ params: messageParamsSchema }),
    async (req, res) => {
      const { workspaceId, channelId, messageId } = req.validated!.params as {
        workspaceId: string;
        channelId: string;
        messageId: string;
      };
      sendSuccess(
        res,
        await service.pin({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, channelId, messageId }),
      );
    },
  );

  router.post(
    '/:channelId/messages/:messageId/unpin',
    requireAuth,
    requireActiveAccount,
    validate({ params: messageParamsSchema }),
    async (req, res) => {
      const { workspaceId, channelId, messageId } = req.validated!.params as {
        workspaceId: string;
        channelId: string;
        messageId: string;
      };
      sendSuccess(
        res,
        await service.unpin({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, channelId, messageId }),
      );
    },
  );

  router.post(
    '/:channelId/messages/:messageId/reactions',
    requireAuth,
    requireActiveAccount,
    validate({ params: messageParamsSchema, body: addReactionSchema }),
    async (req, res) => {
      const { workspaceId, channelId, messageId } = req.validated!.params as {
        workspaceId: string;
        channelId: string;
        messageId: string;
      };
      const body = req.validated!.body as AddReactionInput;
      sendSuccess(
        res,
        await service.addReaction({
          userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)),
          workspaceId,
          channelId,
          messageId,
          emoji: body.emoji,
        }),
        201,
      );
    },
  );

  router.delete(
    '/:channelId/messages/:messageId/reactions',
    requireAuth,
    requireActiveAccount,
    validate({ params: messageParamsSchema, query: addReactionSchema }),
    async (req, res) => {
      const { workspaceId, channelId, messageId } = req.validated!.params as {
        workspaceId: string;
        channelId: string;
        messageId: string;
      };
      const query = req.validated!.query as AddReactionInput;
      await service.removeReaction({
        userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)),
        workspaceId,
        channelId,
        messageId,
        emoji: query.emoji,
      });
      sendSuccess(res, { ok: true });
    },
  );

  router.post(
    '/:channelId/messages/:messageId/read',
    requireAuth,
    requireActiveAccount,
    validate({ params: messageParamsSchema }),
    async (req, res) => {
      const { workspaceId, channelId, messageId } = req.validated!.params as {
        workspaceId: string;
        channelId: string;
        messageId: string;
      };
      await service.markRead({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, channelId, messageId });
      sendSuccess(res, { ok: true });
    },
  );

  router.get(
    '/:channelId/unread-count',
    requireAuth,
    requireActiveAccount,
    validate({ params: channelMessageParamsSchema }),
    async (req, res) => {
      const { workspaceId, channelId } = req.validated!.params as {
        workspaceId: string;
        channelId: string;
      };
      sendSuccess(
        res,
        await service.getUnreadCount({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, channelId }),
      );
    },
  );

  return router;
}
