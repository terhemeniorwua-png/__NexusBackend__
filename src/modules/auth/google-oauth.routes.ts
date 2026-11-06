import { Router } from 'express';
import type { AppConfig } from '../../config/env';
import { createRateLimiter } from '../../middleware/rate-limit';
import { createAuthController } from './auth.controller';
import { createAuthService } from './auth.service';

/** Mounts the callback at the exact path already registered in redirect_URL. */
export function createGoogleOAuthCallbackRouter(config: AppConfig): Router {
  const router = Router();
  const service = createAuthService(config);
  const controller = createAuthController({ config, service });
  const limiter = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:google:callback`,
    windowMs: config.authRateLimitWindowMs,
    limit: config.authLoginRateLimitMax,
    code: 'LOGIN_RATE_LIMITED',
    message: 'Too many Google sign-in attempts. Please try again later.',
  });
  router.get('/', limiter, controller.googleCallback);
  return router;
}
