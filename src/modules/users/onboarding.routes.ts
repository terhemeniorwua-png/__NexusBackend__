import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validateBody } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  acceptLegalDocumentSchema,
  advanceOnboardingStepSchema,
  updateAiAccessSchema,
  type AcceptLegalDocumentInput,
  type AdvanceOnboardingStepInput,
  type UpdateAiAccessInput,
} from './onboarding.schemas';
import { createOnboardingService, type OnboardingService } from './onboarding.service';

export interface OnboardingRouterOptions {
  config: AppConfig;
  service?: OnboardingService;
}

export function createOnboardingRouter({
  config,
  service: injectedService,
}: OnboardingRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();
  const service = injectedService ?? createOnboardingService();

  router.get(
    '/status',
    requireAuth,
    requireActiveAccount,
    async (req: Request, res: Response) => {
      const auth = req.auth;
      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      const status = await service.getStatus(auth.userId);
      sendSuccess(res, status);
    },
  );

  router.post(
    '/accept',
    requireAuth,
    requireActiveAccount,
    validateBody(acceptLegalDocumentSchema),
    async (req: Request, res: Response) => {
      const auth = req.auth;
      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      const input = req.validated?.body as AcceptLegalDocumentInput;
      const status = await service.acceptLegalDocument(auth.userId, input, {
        ip: req.ip,
        userAgent: req.header('user-agent'),
      });
      sendSuccess(res, status);
    },
  );

  router.post(
    '/step',
    requireAuth,
    requireActiveAccount,
    validateBody(advanceOnboardingStepSchema),
    async (req: Request, res: Response) => {
      const auth = req.auth;
      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      const input = req.validated?.body as AdvanceOnboardingStepInput;
      const status = await service.advanceStep(auth.userId, input);
      sendSuccess(res, status);
    },
  );

  router.post(
    '/ai',
    requireAuth,
    requireActiveAccount,
    validateBody(updateAiAccessSchema),
    async (req: Request, res: Response) => {
      const auth = req.auth;
      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      const input = req.validated?.body as UpdateAiAccessInput;
      const result = await service.updateAiAccess(auth.userId, input.enabled, {
        ip: req.ip,
        userAgent: req.header('user-agent'),
      });
      sendSuccess(res, result);
    },
  );

  router.post(
    '/complete',
    requireAuth,
    requireActiveAccount,
    async (req: Request, res: Response) => {
      const auth = req.auth;
      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      const status = await service.complete(auth.userId);
      sendSuccess(res, status);
    },
  );

  return router;
}
