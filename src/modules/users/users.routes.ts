import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validateBody } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { updateProfileSchema, type UpdateProfileInput } from './users.schemas';
import { createUsersService, type UsersService } from './users.service';

/**
 * Profile routes.
 *
 * A profile belongs to an activated account, so the routes sit behind both the
 * session guard and the activation guard.
 */

export interface UsersRouterOptions {
  config: AppConfig;
  service?: UsersService;
}

export function createUsersRouter({
  config,
  service = createUsersService(),
}: UsersRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();

  router.get('/me', requireAuth, requireActiveAccount, async (req: Request, res: Response) => {
    const auth = req.auth;

    if (!auth) {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
    }

    const profile = await service.getProfile(auth.userId);

    sendSuccess(res, profile);
  });

  router.patch(
    '/me',
    requireAuth,
    requireActiveAccount,
    validateBody(updateProfileSchema),
    async (req: Request, res: Response) => {
      const auth = req.auth;

      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      const input = req.validated?.body as UpdateProfileInput;
      const profile = await service.updateProfile(auth.userId, input);

      sendSuccess(res, profile);
    },
  );

  return router;
}
