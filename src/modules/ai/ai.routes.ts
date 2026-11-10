import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { createAiActionService } from './ai-action.service';
import {
  aiActionDecisionSchema,
  aiActionListQuerySchema,
  aiActionParamsSchema,
  aiActionProposalSchema,
  aiChatBodySchema,
  aiConversationParamsSchema,
  aiConversationQuerySchema,
  aiUsageQuerySchema,
  aiWritingAcceptSchema,
  aiWritingAnalyzeSchema,
  aiWritingRewriteSchema,
  aiWritingSessionParamsSchema,
  type AiChatBody,
  type AiWritingAnalyzeBody,
  type AiWritingRewriteBody,
} from './ai.schemas';
import { createAiService } from './ai.service';
import { createWritingService } from './writing.service';

export interface AiRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createAiService>;
  writingService?: ReturnType<typeof createWritingService>;
  actionService?: ReturnType<typeof createAiActionService>;
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in');
  return req.auth.userId;
}

function requestMeta(req: Request) {
  return {
    ip: req.ip,
    userAgent: req.header('user-agent'),
    requestId: req.requestId,
  };
}

function sseWrite(res: import('express').Response, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createAiRouter({
  config,
  service = createAiService(config),
  writingService = createWritingService(config),
  actionService = createAiActionService(config),
}: AiRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  // -------------------------------------------------------------------------
  // Service health
  // -------------------------------------------------------------------------

  router.get('/health', requireAuth, requireActive, async (_req, res) => {
    const status = await service.health();
    sendSuccess(res, {
      configured: service.isConfigured(),
      ...status,
    });
  });

  // -------------------------------------------------------------------------
  // Conversations (Phase 21)
  // -------------------------------------------------------------------------

  router.post(
    '/chat',
    requireAuth,
    requireActive,
    validate({ body: aiChatBodySchema }),
    async (req, res) => {
      const body = req.validated!.body as AiChatBody;
      sendSuccess(res, await service.chat({ userId: userId(req), ...body }, requestMeta(req)));
    },
  );

  router.post(
    '/chat/stream',
    requireAuth,
    requireActive,
    validate({ body: aiChatBodySchema }),
    async (req, res) => {
      if (!service.isConfigured()) {
        throw new AppError(
          503,
          'AI_NOT_CONFIGURED',
          'The AI service is not configured. Enable it through the AI environment variables.',
        );
      }

      const body = req.validated!.body as AiChatBody;
      res.status(200);
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders?.();

      const abort = new AbortController();
      req.on('close', () => abort.abort());

      try {
        for await (const event of service.streamChat(
          { userId: userId(req), ...body },
          requestMeta(req),
        )) {
          if (abort.signal.aborted) break;
          sseWrite(res, event);
        }
      } catch (error) {
        sseWrite(res, {
          type: 'error',
          code: error instanceof AppError ? error.code : 'AI_STREAM_FAILED',
          message:
            error instanceof AppError ? error.message : 'The AI stream could not be completed',
        });
      } finally {
        res.end();
      }
    },
  );

  router.get(
    '/conversations',
    requireAuth,
    requireActive,
    validate({ query: aiConversationQuerySchema }),
    async (req, res) => {
      const query = req.validated!.query as {
        workspaceId?: string;
        cursor?: string;
        limit: number;
      };
      sendSuccess(
        res,
        await service.listConversations(userId(req), {
          workspaceId: query.workspaceId,
          cursor: query.cursor,
          limit: query.limit,
        }),
      );
    },
  );

  router.get(
    '/conversations/:conversationId',
    requireAuth,
    requireActive,
    validate({ params: aiConversationParamsSchema }),
    async (req, res) => {
      const { conversationId } = req.validated!.params as { conversationId: string };
      sendSuccess(res, await service.getConversation(userId(req), conversationId));
    },
  );

  router.delete(
    '/conversations/:conversationId',
    requireAuth,
    requireActive,
    validate({ params: aiConversationParamsSchema }),
    async (req, res) => {
      const { conversationId } = req.validated!.params as { conversationId: string };
      sendSuccess(res, await service.deleteConversation(userId(req), conversationId));
    },
  );

  router.get(
    '/usage',
    requireAuth,
    requireActive,
    validate({ query: aiUsageQuerySchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.query as { workspaceId?: string };
      sendSuccess(res, await service.usage(userId(req), workspaceId));
    },
  );

  // -------------------------------------------------------------------------
  // Nexus Write (Phase 22)
  // -------------------------------------------------------------------------

  router.post(
    '/writing/analyze',
    requireAuth,
    requireActive,
    validate({ body: aiWritingAnalyzeSchema }),
    async (req, res) => {
      const body = req.validated!.body as AiWritingAnalyzeBody;
      sendSuccess(res, await writingService.analyze({ userId: userId(req), ...body }));
    },
  );

  router.post(
    '/writing/rewrite',
    requireAuth,
    requireActive,
    validate({ body: aiWritingRewriteSchema }),
    async (req, res) => {
      const body = req.validated!.body as AiWritingRewriteBody;
      sendSuccess(res, await writingService.rewrite({ userId: userId(req), ...body }));
    },
  );

  router.post(
    '/writing/summarize',
    requireAuth,
    requireActive,
    validate({ body: aiWritingRewriteSchema }),
    async (req, res) => {
      const body = req.validated!.body as AiWritingRewriteBody;
      sendSuccess(
        res,
        await writingService.rewrite({
          userId: userId(req),
          ...body,
          instruction: `Summarise the text. ${body.instruction}`,
          operation: 'writing_summarize',
        }),
      );
    },
  );

  router.post(
    '/writing/translate',
    requireAuth,
    requireActive,
    validate({ body: aiWritingRewriteSchema }),
    async (req, res) => {
      const body = req.validated!.body as AiWritingRewriteBody;
      sendSuccess(
        res,
        await writingService.rewrite({
          userId: userId(req),
          ...body,
          instruction: `Translate the text. ${body.instruction}`,
          operation: 'writing_translate',
        }),
      );
    },
  );

  router.post(
    '/writing/sessions/:sessionId/accept',
    requireAuth,
    requireActive,
    validate({ params: aiWritingSessionParamsSchema, body: aiWritingAcceptSchema }),
    async (req, res) => {
      const { sessionId } = req.validated!.params as { sessionId: string };
      const { suggestionIds } = req.validated!.body as { suggestionIds: string[] };
      sendSuccess(
        res,
        await writingService.acceptSuggestion(userId(req), sessionId, suggestionIds),
      );
    },
  );

  router.post(
    '/writing/sessions/:sessionId/dismiss',
    requireAuth,
    requireActive,
    validate({ params: aiWritingSessionParamsSchema }),
    async (req, res) => {
      const { sessionId } = req.validated!.params as { sessionId: string };
      sendSuccess(res, await writingService.dismissSession(userId(req), sessionId));
    },
  );

  // -------------------------------------------------------------------------
  // AI action approval and execution (Phase 23)
  // -------------------------------------------------------------------------

  router.post(
    '/actions/proposals',
    requireAuth,
    requireActive,
    validate({ body: aiActionProposalSchema }),
    async (req, res) => {
      const body = req.validated!.body as Parameters<typeof actionService.propose>[1];
      sendSuccess(res, await actionService.propose(userId(req), body, requestMeta(req)), 201);
    },
  );

  router.get(
    '/actions/proposals',
    requireAuth,
    requireActive,
    validate({ query: aiActionListQuerySchema }),
    async (req, res) => {
      const query = req.validated!.query as {
        workspaceId: string;
        status?:
          | 'PROPOSED'
          | 'APPROVED'
          | 'REJECTED'
          | 'EXECUTING'
          | 'EXECUTED'
          | 'FAILED'
          | 'CANCELLED'
          | 'EXPIRED';
        cursor?: string;
        limit: number;
      };
      sendSuccess(
        res,
        await actionService.list(userId(req), {
          workspaceId: query.workspaceId,
          ...(query.status ? { status: query.status } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
          limit: query.limit,
        }),
      );
    },
  );

  router.get(
    '/actions/proposals/:proposalId',
    requireAuth,
    requireActive,
    validate({ params: aiActionParamsSchema }),
    async (req, res) => {
      const { proposalId } = req.validated!.params as { proposalId: string };
      sendSuccess(res, await actionService.get(userId(req), proposalId));
    },
  );

  router.post(
    '/actions/proposals/:proposalId/approve',
    requireAuth,
    requireActive,
    validate({ params: aiActionParamsSchema, body: aiActionDecisionSchema }),
    async (req, res) => {
      const { proposalId } = req.validated!.params as { proposalId: string };
      const { note } = req.validated!.body as { note?: string };
      sendSuccess(
        res,
        await actionService.approve(userId(req), proposalId, note, requestMeta(req)),
      );
    },
  );

  router.post(
    '/actions/proposals/:proposalId/reject',
    requireAuth,
    requireActive,
    validate({ params: aiActionParamsSchema, body: aiActionDecisionSchema }),
    async (req, res) => {
      const { proposalId } = req.validated!.params as { proposalId: string };
      const { note } = req.validated!.body as { note?: string };
      sendSuccess(res, await actionService.reject(userId(req), proposalId, note, requestMeta(req)));
    },
  );

  router.post(
    '/actions/proposals/:proposalId/cancel',
    requireAuth,
    requireActive,
    validate({ params: aiActionParamsSchema }),
    async (req, res) => {
      const { proposalId } = req.validated!.params as { proposalId: string };
      sendSuccess(res, await actionService.cancel(userId(req), proposalId, requestMeta(req)));
    },
  );

  router.post(
    '/actions/proposals/:proposalId/execute',
    requireAuth,
    requireActive,
    validate({ params: aiActionParamsSchema }),
    async (req, res) => {
      const { proposalId } = req.validated!.params as { proposalId: string };
      sendSuccess(res, await actionService.execute(userId(req), proposalId, requestMeta(req)));
    },
  );

  return router;
}
