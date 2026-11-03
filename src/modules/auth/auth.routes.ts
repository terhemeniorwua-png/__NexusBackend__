import { Router } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireAuth } from '../../middleware/authenticate';
import { accountKeyGenerator, createRateLimiter } from '../../middleware/rate-limit';
import { validateBody } from '../../middleware/validation';
import {
  accountActionSchema,
  accountDeleteSchema,
  confirmEmailChangeSchema,
  emailChangeSchema,
  emailOnlySchema,
  loginSchema,
  passwordChangeSchema,
  passwordResetRequestSchema,
  passwordResetSchema,
  refreshSchema,
  registerSchema,
  verifyEmailSchema,
} from './auth.schemas';
import { createAuthController, type AuthController } from './auth.controller';
import type { AuthService } from './auth.service';

/**
 * Authentication routes.
 *
 * Sensitive endpoints have their own, tighter rate limits than the global
 * limiter. Every limiter has a per-IP bucket and, where an account can be
 * targeted, a per-account bucket.
 */

export interface AuthRouterOptions {
  config: AppConfig;
  service: AuthService;
  controller?: AuthController;
}

export function createAuthRouter({
  config,
  service,
  controller = createAuthController({ config, service }),
}: AuthRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);

  const windowMs = config.authRateLimitWindowMs;

  const registerIpLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:register:ip`,
    windowMs,
    limit: config.authRegisterRateLimitMax,
    code: 'RATE_LIMITED',
    message: 'Too many accounts created from this address. Please try again later.',
  });

  const registerAccountLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:register:account`,
    windowMs,
    limit: config.authRegisterRateLimitMax,
    keyGenerator: accountKeyGenerator,
    code: 'RATE_LIMITED',
    message: 'Too many accounts created for this email address. Please try again later.',
  });

  const loginIpLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:login:ip`,
    windowMs,
    limit: config.authLoginRateLimitMax,
    code: 'LOGIN_RATE_LIMITED',
    message: 'Too many sign-in attempts from this address. Please try again later.',
  });

  const loginAccountLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:login:account`,
    windowMs,
    limit: config.authLoginRateLimitMax,
    keyGenerator: accountKeyGenerator,
    code: 'LOGIN_RATE_LIMITED',
    message: 'Too many sign-in attempts for this account. Please try again later.',
  });

  const verificationIpLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:verification:ip`,
    windowMs,
    limit: config.authVerificationRateLimitMax,
    code: 'RATE_LIMITED',
    message: 'Too many verification requests. Please try again later.',
  });

  const verificationAccountLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:verification:account`,
    windowMs,
    limit: config.authVerificationRateLimitMax,
    keyGenerator: accountKeyGenerator,
    code: 'RATE_LIMITED',
    message: 'Too many verification requests for this email address. Please try again later.',
  });

  const passwordIpLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:password:ip`,
    windowMs,
    limit: config.authPasswordRateLimitMax,
    code: 'RATE_LIMITED',
    message: 'Too many password requests. Please try again later.',
  });

  const passwordAccountLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:password:account`,
    windowMs,
    limit: config.authPasswordRateLimitMax,
    keyGenerator: accountKeyGenerator,
    code: 'RATE_LIMITED',
    message: 'Too many password requests for this account. Please try again later.',
  });

  const accountDeletionLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:account-deletion`,
    windowMs,
    limit: 3,
    keyGenerator: (req) => `${req.ip ?? 'unknown'}:${req.auth?.userId ?? 'unknown'}`,
    code: 'RATE_LIMITED',
    message: 'Too many account deletion requests. Please try again later.',
  });

  router.post(
    '/register',
    registerIpLimit,
    registerAccountLimit,
    validateBody(registerSchema),
    controller.register,
  );
  router.post(
    '/verify-email',
    verificationIpLimit,
    validateBody(verifyEmailSchema),
    controller.verifyEmail,
  );
  router.post(
    '/resend-verification',
    verificationIpLimit,
    verificationAccountLimit,
    validateBody(emailOnlySchema),
    controller.resendVerification,
  );

  router.post(
    '/login',
    loginIpLimit,
    loginAccountLimit,
    validateBody(loginSchema),
    controller.login,
  );
  router.post(
    '/reactivate',
    loginIpLimit,
    loginAccountLimit,
    validateBody(loginSchema),
    controller.reactivate,
  );
  router.post('/refresh', validateBody(refreshSchema), controller.refresh);
  router.post('/logout', validateBody(refreshSchema), controller.logout);

  router.post('/logout-all', requireAuth, controller.logoutAll);
  router.get('/sessions', requireAuth, controller.sessions);
  router.get('/me', requireAuth, controller.me);

  router.post(
    '/password/forgot',
    passwordIpLimit,
    passwordAccountLimit,
    validateBody(passwordResetRequestSchema),
    controller.requestPasswordReset,
  );
  router.post(
    '/password/reset',
    passwordIpLimit,
    validateBody(passwordResetSchema),
    controller.resetPassword,
  );
  router.post(
    '/password/change',
    requireAuth,
    validateBody(passwordChangeSchema),
    controller.changePassword,
  );

  router.post(
    '/email/change',
    requireAuth,
    validateBody(emailChangeSchema),
    controller.requestEmailChange,
  );
  router.post(
    '/email/change/confirm',
    verificationIpLimit,
    validateBody(confirmEmailChangeSchema),
    controller.confirmEmailChange,
  );

  router.post('/deactivate', requireAuth, validateBody(accountActionSchema), controller.deactivate);
  router.post(
    '/delete',
    requireAuth,
    accountDeletionLimit,
    validateBody(accountDeleteSchema),
    controller.remove,
  );

  return router;
}
