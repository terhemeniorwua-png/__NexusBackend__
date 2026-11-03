import { Router, type Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { createRateLimiter } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validation';
import type { RequestContext } from '../auth/auth.types';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { createJoinRequestService, type JoinRequestService } from './join-request.service';
import {
  approveJoinRequestSchema,
  createJoinRequestSchema,
  discoverWorkspacesQuerySchema,
  joinByCodeSchema,
  joinRequestIdParamsSchema,
  joinRequestParamsSchema,
  listJoinRequestsQuerySchema,
  rejectJoinRequestSchema,
  workspaceIdParamsSchema,
  type ApproveJoinRequestInput,
  type CreateJoinRequestInput,
  type DiscoverWorkspacesQuery,
  type JoinByCodeInput,
  type ListJoinRequestsQuery,
  type RejectJoinRequestInput,
} from './workspace.schemas';

/**
 * Organisation discovery and join-request routes.
 *
 * The router is mounted under `/workspaces` before the workspace router, so
 * `/workspaces/discover` and `/workspaces/join` are resolved here instead of
 * being treated as a workspace identifier.
 */

export interface JoinRequestRouterOptions {
  config: AppConfig;
  service?: JoinRequestService;
}

function context(req: Request): RequestContext {
  return {
    ip: req.ip,
    userAgent: req.header('user-agent'),
  };
}

function requireUser(req: Request): string {
  const auth = req.auth;

  if (!auth) {
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  }

  return auth.userId;
}

export function createJoinRequestRouter({
  config,
  service = createJoinRequestService(config),
}: JoinRequestRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();

  // A join request is a cheap write, but it notifies every administrator. The
  // limit keeps one account from turning it into a notification flood.
  const requestLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:workspaces:join-requests`,
    windowMs: 60 * 60 * 1_000,
    limit: 20,
    code: 'RATE_LIMITED',
    message: 'Too many join requests. Please try again later.',
    keyGenerator: (req) => req.auth?.userId ?? `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
  });

  router.get(
    '/discover',
    requireAuth,
    requireActiveAccount,
    validate({ query: discoverWorkspacesQuerySchema }),
    async (req, res) => {
      const query = req.validated?.query as DiscoverWorkspacesQuery;
      const workspaces = await service.discover(query);

      sendSuccess(res, workspaces);
    },
  );

  router.post(
    '/join',
    requireAuth,
    requireActiveAccount,
    requestLimit,
    validate({ body: joinByCodeSchema }),
    async (req, res) => {
      const input = req.validated?.body as JoinByCodeInput;
      const request = await service.createByCode(
        { userId: requireUser(req), ...input },
        context(req),
      );

      sendSuccess(res, request, 201);
    },
  );

  router.get('/join-requests/mine', requireAuth, requireActiveAccount, async (req, res) => {
    const requests = await service.listMine(requireUser(req));

    sendSuccess(res, requests);
  });

  router.post(
    '/:workspaceId/join-requests',
    requireAuth,
    requireActiveAccount,
    requestLimit,
    validate({ params: workspaceIdParamsSchema, body: createJoinRequestSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const input = req.validated?.body as CreateJoinRequestInput;
      const request = await service.create(
        { userId: requireUser(req), workspaceId, ...input },
        context(req),
      );

      sendSuccess(res, request, 201);
    },
  );

  router.get(
    '/:workspaceId/join-requests',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema, query: listJoinRequestsQuerySchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const query = req.validated?.query as ListJoinRequestsQuery;
      const requests = await service.listForWorkspace({
        userId: requireUser(req),
        workspaceId,
        status: query.status,
      });

      sendSuccess(res, requests);
    },
  );

  router.post(
    '/:workspaceId/join-requests/:requestId/approve',
    requireAuth,
    requireActiveAccount,
    validate({ params: joinRequestParamsSchema, body: approveJoinRequestSchema }),
    async (req, res) => {
      const { workspaceId, requestId } = req.validated?.params as {
        workspaceId: string;
        requestId: string;
      };
      const input = req.validated?.body as ApproveJoinRequestInput;
      const request = await service.approve(
        { userId: requireUser(req), workspaceId, requestId, ...input },
        context(req),
      );

      sendSuccess(res, request);
    },
  );

  router.post(
    '/:workspaceId/join-requests/:requestId/reject',
    requireAuth,
    requireActiveAccount,
    validate({ params: joinRequestParamsSchema, body: rejectJoinRequestSchema }),
    async (req, res) => {
      const { workspaceId, requestId } = req.validated?.params as {
        workspaceId: string;
        requestId: string;
      };
      const input = req.validated?.body as RejectJoinRequestInput;
      const request = await service.reject(
        { userId: requireUser(req), workspaceId, requestId, ...input },
        context(req),
      );

      sendSuccess(res, request);
    },
  );

  router.delete(
    '/join-requests/:requestId',
    requireAuth,
    requireActiveAccount,
    validate({ params: joinRequestIdParamsSchema }),
    async (req, res) => {
      const { requestId } = req.validated?.params as { requestId: string };
      const request = await service.withdraw({ userId: requireUser(req), requestId }, context(req));

      sendSuccess(res, request);
    },
  );

  router.post(
    '/:workspaceId/join-code',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const code = await service.rotateCode(
        { userId: requireUser(req), workspaceId },
        context(req),
      );

      sendSuccess(res, code, 201);
    },
  );

  router.delete(
    '/:workspaceId/join-code',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const result = await service.disableCode(
        { userId: requireUser(req), workspaceId },
        context(req),
      );

      sendSuccess(res, result);
    },
  );

  return router;
}
