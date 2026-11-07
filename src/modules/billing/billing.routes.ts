import { ipKeyGenerator } from 'express-rate-limit';
import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { createRateLimiter } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { createBillingService, type BillingService } from './billing.service';
import {
  billingTargetSchema,
  verifyCheckoutSchema,
  workspaceBillingParamsSchema,
} from './billing.schemas';

export interface BillingRouterOptions {
  config: AppConfig;
  service?: BillingService;
}

function user(req: Request) {
  if (!req.auth)
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  return { userId: req.auth.userId, email: req.auth.email };
}

export function createBillingRouter({
  config,
  service = createBillingService(config),
}: BillingRouterOptions): Router {
  const router = Router();
  const auth = createRequireAuth(config);
  const active = createRequireActiveAccount();
  const mutationLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:billing`,
    windowMs: config.authRateLimitWindowMs,
    limit: 20,
    code: 'BILLING_RATE_LIMITED',
    message: 'Too many billing requests. Try again shortly.',
    keyGenerator: (req) => req.auth?.userId ?? `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
  });

  router.get('/plans', (_req, res) => sendSuccess(res, service.listPlans()));
  router.get(
    '/workspaces/:workspaceId',
    auth,
    active,
    validate({ params: workspaceBillingParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      sendSuccess(res, await service.getWorkspace({ actor: user(req), workspaceId }));
    },
  );
  router.get(
    '/workspaces/:workspaceId/payments',
    auth,
    active,
    validate({ params: workspaceBillingParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      sendSuccess(res, await service.listPayments({ actor: user(req), workspaceId }));
    },
  );
  router.post(
    '/workspaces/:workspaceId/checkout',
    auth,
    active,
    mutationLimit,
    validate({ params: workspaceBillingParamsSchema, body: billingTargetSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const target = req.validated?.body as {
        plan: 'PRO' | 'BUSINESS';
        interval: 'MONTHLY' | 'ANNUAL';
        billableSeats?: number;
      };
      sendSuccess(
        res,
        await service.createCheckout({ actor: user(req), workspaceId, ...target }),
        201,
      );
    },
  );
  router.post(
    '/workspaces/:workspaceId/verify',
    auth,
    active,
    mutationLimit,
    validate({ params: workspaceBillingParamsSchema, body: verifyCheckoutSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const { reference } = req.validated?.body as { reference: string };
      sendSuccess(res, await service.verifyCheckout({ actor: user(req), workspaceId, reference }));
    },
  );
  router.post(
    '/workspaces/:workspaceId/change',
    auth,
    active,
    mutationLimit,
    validate({ params: workspaceBillingParamsSchema, body: billingTargetSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const target = req.validated?.body as {
        plan: 'PRO' | 'BUSINESS';
        interval: 'MONTHLY' | 'ANNUAL';
        billableSeats?: number;
      };
      sendSuccess(res, await service.scheduleChange({ actor: user(req), workspaceId, ...target }));
    },
  );
  router.post(
    '/workspaces/:workspaceId/cancel',
    auth,
    active,
    mutationLimit,
    validate({ params: workspaceBillingParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      sendSuccess(res, await service.cancel({ actor: user(req), workspaceId }));
    },
  );
  return router;
}
