import { Router } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import {
  accountKeyGenerator,
  createRateLimiter,
  emailKeyGenerator,
} from '../../middleware/rate-limit';
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
  twoFactorChallengeSchema,
  twoFactorConfirmSchema,
  twoFactorDisableSchema,
  recoveryCodeRegenerateSchema,
  googleExchangeSchema,
} from './auth.schemas';
import { createAuthController, type AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import { AppError } from '../../utils/errors';

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
  const requireActive = createRequireActiveAccount();

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

  const verificationEmailLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:verification:email`,
    windowMs,
    limit: 5,
    keyGenerator: emailKeyGenerator,
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

  const passwordEmailLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:password:email`,
    windowMs,
    limit: 5,
    keyGenerator: emailKeyGenerator,
    code: 'RATE_LIMITED',
    message: 'Too many password requests for this email address. Please try again later.',
  });

  const accountDeletionLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:account-deletion`,
    windowMs,
    limit: 3,
    keyGenerator: (req) =>
      `${ipKeyGenerator(req.ip ?? 'unknown')}:${req.auth?.userId ?? 'unknown'}`,
    code: 'RATE_LIMITED',
    message: 'Too many account deletion requests. Please try again later.',
  });

  const twoFactorChallengeLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:2fa:challenge:ip`,
    windowMs,
    limit: config.authLoginRateLimitMax,
    code: 'MFA_RATE_LIMITED',
    message: 'Too many two-factor verification attempts. Please try again later.',
  });

  const googleOAuthLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:auth:google:ip`,
    windowMs,
    limit: config.authLoginRateLimitMax,
    code: 'LOGIN_RATE_LIMITED',
    message: 'Too many Google sign-in attempts. Please try again later.',
  });

  router.get('/google', googleOAuthLimit, controller.googleStart);
  router.get('/google/callback', googleOAuthLimit, controller.googleCallback);
  router.post(
    '/google/exchange',
    googleOAuthLimit,
    validateBody(googleExchangeSchema),
    controller.googleExchange,
  );

  router.post(
    '/register',
    registerIpLimit,
    registerAccountLimit,
    validateBody(registerSchema),
    controller.register,
  );
  router.post('/verify-email', (_req, _res, next) =>
    next(
      new AppError(
        410,
        'LINK_TOKEN_DEPRECATED',
        'Email verification links are no longer supported. Request a verification code.',
      ),
    ),
  );
  router.post(
    '/email/verify',
    verificationIpLimit,
    verificationEmailLimit,
    validateBody(verifyEmailSchema),
    controller.verifyEmail,
  );
  router.post(
    '/email/resend',
    verificationIpLimit,
    verificationEmailLimit,
    validateBody(emailOnlySchema),
    controller.resendVerification,
  );
  router.post('/resend-verification', (_req, _res, next) =>
    next(
      new AppError(
        410,
        'LINK_TOKEN_DEPRECATED',
        'Use POST /auth/email/resend to request a verification code.',
      ),
    ),
  );

  router.post(
    '/login',
    loginIpLimit,
    loginAccountLimit,
    validateBody(loginSchema),
    controller.login,
  );
  router.post(
    '/2fa/challenge',
    twoFactorChallengeLimit,
    validateBody(twoFactorChallengeSchema),
    controller.twoFactorChallenge,
  );
  router.post('/2fa/setup', requireAuth, requireActive, controller.beginTwoFactorSetup);
  router.post(
    '/2fa/confirm',
    requireAuth,
    requireActive,
    validateBody(twoFactorConfirmSchema),
    controller.confirmTwoFactorSetup,
  );
  router.post(
    '/2fa/disable',
    requireAuth,
    requireActive,
    validateBody(twoFactorDisableSchema),
    controller.disableTwoFactor,
  );
  router.post(
    '/2fa/recovery-codes',
    requireAuth,
    requireActive,
    validateBody(recoveryCodeRegenerateSchema),
    controller.regenerateRecoveryCodes,
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
    passwordEmailLimit,
    validateBody(passwordResetRequestSchema),
    controller.requestPasswordReset,
  );
  router.post(
    '/password/reset',
    passwordIpLimit,
    passwordEmailLimit,
    (req, _res, next) => {
      if (typeof req.body?.token === 'string') {
        next(
          new AppError(
            410,
            'LINK_TOKEN_DEPRECATED',
            'Password reset links are no longer supported. Request a reset code.',
          ),
        );
        return;
      }
      next();
    },
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
