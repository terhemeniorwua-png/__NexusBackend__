import { Router, type Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { createRateLimiter } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { createPrivacyService, type PrivacyService } from './privacy.service';
import {
  createPrivacyRequestSchema,
  privacyCompletionSchema,
  privacyDecisionSchema,
  privacyRedactionSchema,
  privacyRequestListQuerySchema,
  privacyRequestParamsSchema,
} from './privacy.schemas';

export interface PrivacyRouterOptions {
  config: AppConfig;
  service?: PrivacyService;
}

function userId(req: Request): string {
  if (!req.auth)
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  return req.auth.userId;
}

export function createPrivacyRouter({
  config,
  service = createPrivacyService(),
}: PrivacyRouterOptions): Router {
  const router = Router();
  const auth = createRequireAuth(config);
  const active = createRequireActiveAccount();
  const mutationLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:privacy`,
    windowMs: config.authRateLimitWindowMs,
    limit: 10,
    code: 'PRIVACY_REQUEST_RATE_LIMITED',
    message: 'Too many privacy request operations. Try again later.',
    keyGenerator: (req) => req.auth?.userId ?? `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
  });

  router.post(
    '/',
    auth,
    active,
    mutationLimit,
    validate({ body: createPrivacyRequestSchema }),
    async (req, res) => {
      const request = req.validated?.body as Parameters<PrivacyService['create']>[0]['request'];
      sendSuccess(res, await service.create({ userId: userId(req), request }), 201);
    },
  );
  router.get(
    '/mine',
    auth,
    active,
    validate({ query: privacyRequestListQuerySchema }),
    async (req, res) => {
      const query = req.validated?.query as Parameters<PrivacyService['listMine']>[0]['query'];
      sendSuccess(res, await service.listMine({ userId: userId(req), query }));
    },
  );
  router.get(
    '/mine/:requestId',
    auth,
    active,
    validate({ params: privacyRequestParamsSchema }),
    async (req, res) => {
      const { requestId } = req.validated?.params as { requestId: string };
      sendSuccess(res, await service.getMine({ userId: userId(req), requestId }));
    },
  );
  router.get(
    '/review',
    auth,
    active,
    validate({ query: privacyRequestListQuerySchema }),
    async (req, res) => {
      const query = req.validated?.query as Parameters<PrivacyService['listForReview']>[0]['query'];
      sendSuccess(res, await service.listForReview({ actorId: userId(req), query }));
    },
  );
  router.post(
    '/:requestId/review',
    auth,
    active,
    mutationLimit,
    validate({ params: privacyRequestParamsSchema }),
    async (req, res) => {
      const { requestId } = req.validated?.params as { requestId: string };
      sendSuccess(res, await service.beginReview({ actorId: userId(req), requestId }));
    },
  );
  router.post(
    '/:requestId/decision',
    auth,
    active,
    mutationLimit,
    validate({ params: privacyRequestParamsSchema, body: privacyDecisionSchema }),
    async (req, res) => {
      const { requestId } = req.validated?.params as { requestId: string };
      const decision = req.validated?.body as { decision: 'APPROVE' | 'REJECT'; note?: string };
      sendSuccess(res, await service.decide({ actorId: userId(req), requestId, ...decision }));
    },
  );
  router.post(
    '/:requestId/complete',
    auth,
    active,
    mutationLimit,
    validate({ params: privacyRequestParamsSchema, body: privacyCompletionSchema }),
    async (req, res) => {
      const { requestId } = req.validated?.params as { requestId: string };
      const { outcome } = req.validated?.body as { outcome: string };
      sendSuccess(res, await service.complete({ actorId: userId(req), requestId, outcome }));
    },
  );
  router.post(
    '/:requestId/redactions',
    auth,
    active,
    mutationLimit,
    validate({ params: privacyRequestParamsSchema, body: privacyRedactionSchema }),
    async (req, res) => {
      const { requestId } = req.validated?.params as { requestId: string };
      const { matchText, replacementText } = req.validated?.body as {
        matchText: string;
        replacementText: string;
      };
      sendSuccess(
        res,
        await service.redactComment({
          actorId: userId(req),
          requestId,
          matchText,
          replacementText,
        }),
      );
    },
  );
  return router;
}
