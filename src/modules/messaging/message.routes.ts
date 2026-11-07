import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
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

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in');
  return req.auth.userId;
}

export function createMessageRouter({
  config,
  service = createMessageService(),
}: MessageRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();

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
        userId: userId(req),
        workspaceId,
        channelId,
        body: body.body,
        parentId: body.parentId,
      });
      sendSuccess(res, message, 201);
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
        userId: userId(req),
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
        await service.getReplies({ userId: userId(req), workspaceId, channelId, messageId }),
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
        await service.edit({ userId: userId(req), workspaceId, channelId, messageId, body: body.body }),
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
      await service.delete({ userId: userId(req), workspaceId, channelId, messageId });
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
        await service.pin({ userId: userId(req), workspaceId, channelId, messageId }),
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
        await service.unpin({ userId: userId(req), workspaceId, channelId, messageId }),
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
          userId: userId(req),
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
        userId: userId(req),
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
      await service.markRead({ userId: userId(req), workspaceId, channelId, messageId });
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
        await service.getUnreadCount({ userId: userId(req), workspaceId, channelId }),
      );
    },
  );

  return router;
}
