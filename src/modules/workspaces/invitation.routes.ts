import { Router } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { createRateLimiter } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validation';
import type { RequestContext } from '../auth/auth.types';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { createInvitationService, type InvitationService } from './invitation.service';
import { invitationTokenParamsSchema } from './workspace.schemas';

/**
 * Invitation routes.
 *
 * The token in the URL is the secret of the invitation, so the preview can be
 * read without a session. Accepting needs one: the invitation grants access
 * to a workspace, and only an account can hold that access.
 */

export interface InvitationRouterOptions {
  config: AppConfig;
  service?: InvitationService;
}

export function createInvitationRouter({
  config,
  service = createInvitationService(config),
}: InvitationRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  // Accepting an invitation grants access, so the account has to be usable.
  const requireActiveAccount = createRequireActiveAccount();

  const previewLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:invitations:preview`,
    windowMs: config.authRateLimitWindowMs,
    limit: 60,
    code: 'RATE_LIMITED',
    message: 'Too many requests. Please try again later.',
  });

  router.get('/', requireAuth, requireActiveAccount, async (req, res) => {
    const auth = req.auth;

    if (!auth) {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
    }

    const invitations = await service.listMine(auth.userId);

    sendSuccess(res, invitations);
  });

  router.get(
    '/:token',
    previewLimit,
    validate({ params: invitationTokenParamsSchema }),
    async (req, res) => {
      const { token } = req.validated?.params as { token: string };
      const preview = await service.preview(token);

      sendSuccess(res, preview);
    },
  );

  router.post(
    '/:token/accept',
    requireAuth,
    requireActiveAccount,
    validate({ params: invitationTokenParamsSchema }),
    async (req, res) => {
      const auth = req.auth;

      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      const { token } = req.validated?.params as { token: string };
      const ctx: RequestContext = {
        ip: req.ip,
        userAgent: req.header('user-agent'),
      };
      const invitation = await service.accept({ userId: auth.userId, token }, ctx);

      sendSuccess(res, invitation);
    },
  );

  return router;
}
