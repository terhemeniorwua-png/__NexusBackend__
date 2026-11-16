import type { Request, Response } from 'express';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import { clearCookie, readCookie, setCookie } from '../../utils/cookies';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  REFRESH_COOKIE_NAME,
  createCsrfValidator,
  type CsrfValidator,
} from './csrf';
import { findSessionByRefreshToken } from './session.service';
import type { AuthService } from './auth.service';
import type {
  AccountDeleteInput,
  EmailChangeInput,
  LoginInput,
  PasswordChangeInput,
  PasswordResetInput,
  RegisterInput,
} from './auth.schemas';
import type { RequestContext } from './auth.types';
import {
  createGoogleOAuthService,
  GOOGLE_OAUTH_STATE_COOKIE,
  type GoogleOAuthService,
} from './google-oauth.service';

/**
 * HTTP layer for the authentication module.
 *
 * The controller translates between HTTP and the auth service. It owns the
 * cookie handling and the CSRF check for cookie-authenticated requests, and
 * nothing else: all account rules live in the service.
 */

export interface AuthControllerOptions {
  config: AppConfig;
  service: AuthService;
  csrf?: CsrfValidator;
  googleOAuth?: GoogleOAuthService;
}

const GENERIC_EMAIL_RESPONSE =
  'If the address can be used, a message with the next step has been sent.';

export function createAuthController({
  config,
  service,
  csrf = createCsrfValidator(config),
  googleOAuth = createGoogleOAuthService(config, service),
}: AuthControllerOptions) {
  function context(req: Request): RequestContext {
    return {
      ip: req.ip,
      userAgent: req.header('user-agent'),
    };
  }

  function cookieOptions() {
    return {
      secure: config.cookieSecure,
      sameSite: config.cookieSameSite,
      ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
    };
  }

  function setSessionCookies(res: Response, refreshToken: string, csrfToken: string): void {
    setCookie(res, REFRESH_COOKIE_NAME, refreshToken, {
      ...cookieOptions(),
      httpOnly: true,
      maxAge: config.refreshTokenTtlSeconds * 1_000,
    });

    // Readable by the frontend so it can echo the value back in a header.
    setCookie(res, CSRF_COOKIE_NAME, csrfToken, {
      ...cookieOptions(),
      httpOnly: false,
      maxAge: config.refreshTokenTtlSeconds * 1_000,
    });
  }

  function clearSessionCookies(res: Response): void {
    clearCookie(res, REFRESH_COOKIE_NAME, { ...cookieOptions(), httpOnly: true });
    clearCookie(res, CSRF_COOKIE_NAME, { ...cookieOptions(), httpOnly: false });
  }

  function readRefreshToken(
    req: Request,
    bodyToken: string | undefined,
  ): {
    token: string;
    fromCookie: boolean;
  } {
    const cookieToken = readCookie(req, REFRESH_COOKIE_NAME);

    if (bodyToken) {
      return { token: bodyToken, fromCookie: false };
    }

    if (cookieToken) {
      return { token: cookieToken, fromCookie: true };
    }

    throw new AppError(401, 'REFRESH_TOKEN_MISSING', 'No active session was found');
  }

  /**
   * Validates the CSRF token of a cookie-authenticated request.
   *
   * Requests that present the refresh token in the request body are not
   * cookie-authenticated and are not vulnerable to cross-site submission.
   *
   * The token must arrive in the `x-csrf-token` header. It is deliberately
   * *not* accepted from the `nexus_csrf` cookie: a browser attaches cookies
   * to cross-site requests automatically, so accepting the cookie would make
   * the check pass for exactly the requests it has to reject. The cookie only
   * gives the frontend a way to obtain the value.
   */
  async function assertCsrf(
    req: Request,
    refreshToken: string,
    fromCookie: boolean,
  ): Promise<void> {
    if (!fromCookie) {
      return;
    }

    const session = await findSessionByRefreshToken(getPrismaClient(), refreshToken);

    if (!session) {
      // The token is unknown; the request will fail with an invalid token.
      return;
    }

    const provided = req.header(CSRF_HEADER_NAME);

    if (!csrf.verify(session.id, provided)) {
      throw new AppError(
        403,
        'CSRF_TOKEN_INVALID',
        'The request could not be verified. Refresh the page and try again.',
      );
    }
  }

  return {
    async googleStart(_req: Request, res: Response): Promise<void> {
      const { authorizationUrl, browserBinding } = await googleOAuth.initiate();
      setCookie(res, GOOGLE_OAUTH_STATE_COOKIE, browserBinding, {
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: 'lax',
        maxAge: 10 * 60_000,
      });
      res.redirect(302, authorizationUrl);
    },

    async googleCallback(req: Request, res: Response): Promise<void> {
      const code = typeof req.query.code === 'string' ? req.query.code : undefined;
      const state = typeof req.query.state === 'string' ? req.query.state : undefined;
      const error = typeof req.query.error === 'string' ? req.query.error : undefined;
      const redirect = await googleOAuth.callback({
        code,
        state,
        error,
        browserBinding: readCookie(req, GOOGLE_OAUTH_STATE_COOKIE),
      });
      clearCookie(res, GOOGLE_OAUTH_STATE_COOKIE, {
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: 'lax',
      });
      res.redirect(302, redirect);
    },

    async googleExchange(req: Request, res: Response): Promise<void> {
      const body = req.validated?.body as { code: string };
      const result = await googleOAuth.exchange(body.code, context(req));
      if ('twoFactorRequired' in result) {
        sendSuccess(res, result);
        return;
      }
      setSessionCookies(res, result.refreshToken, result.csrfToken);
      sendSuccess(res, {
        user: result.user,
        accessToken: result.accessToken,
        tokenType: result.tokenType,
        expiresIn: result.expiresIn,
        csrfToken: result.csrfToken,
        session: result.session,
      });
    },

    async register(req: Request, res: Response): Promise<void> {
      const body = req.validated?.body as RegisterInput;
      const result = await service.register(body, context(req));

      sendSuccess(res, { user: result.user, verificationRequired: true }, 201);
    },

    async verifyEmail(req: Request, res: Response): Promise<void> {
      const body = req.validated?.body as { email: string; code: string };
      const result = await service.verifyEmail(body, context(req));

      sendSuccess(res, { user: result.user });
    },

    async resendVerification(req: Request, res: Response): Promise<void> {
      const body = req.validated?.body as { email: string };

      await service.resendVerification({ email: body.email }, context(req));

      sendSuccess(res, { message: GENERIC_EMAIL_RESPONSE });
    },

    async login(req: Request, res: Response): Promise<void> {
      const body = req.validated?.body as LoginInput;
      const result = await service.login(body, context(req));

      if ('twoFactorRequired' in result) {
        sendSuccess(res, result);
        return;
      }

      setSessionCookies(res, result.refreshToken, result.csrfToken);

      sendSuccess(res, {
        user: result.user,
        accessToken: result.accessToken,
        tokenType: result.tokenType,
        expiresIn: result.expiresIn,
        csrfToken: result.csrfToken,
        session: result.session,
      });
    },

    async twoFactorChallenge(req: Request, res: Response): Promise<void> {
      const body = req.validated?.body as {
        challengeToken: string;
        code?: string;
        recoveryCode?: string;
      };
      const result = await service.twoFactor.completeLogin(body, context(req));
      setSessionCookies(res, result.refreshToken, result.csrfToken);
      sendSuccess(res, {
        user: result.user,
        accessToken: result.accessToken,
        tokenType: result.tokenType,
        expiresIn: result.expiresIn,
        csrfToken: result.csrfToken,
        session: result.session,
      });
    },

    async beginTwoFactorSetup(req: Request, res: Response): Promise<void> {
      const userId = req.auth?.userId;
      if (!userId)
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      sendSuccess(res, await service.twoFactor.beginSetup(userId, context(req)));
    },

    async confirmTwoFactorSetup(req: Request, res: Response): Promise<void> {
      const userId = req.auth?.userId;
      if (!userId)
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      const body = req.validated?.body as { code: string };
      sendSuccess(res, await service.twoFactor.confirmSetup(userId, body.code, context(req)));
    },

    async disableTwoFactor(req: Request, res: Response): Promise<void> {
      const userId = req.auth?.userId;
      if (!userId)
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      const body = req.validated?.body as {
        currentPassword: string;
        code?: string;
        recoveryCode?: string;
      };
      await service.twoFactor.disable({ ...body, userId }, context(req));
      sendSuccess(res, { twoFactorEnabled: false });
    },

    async regenerateRecoveryCodes(req: Request, res: Response): Promise<void> {
      const userId = req.auth?.userId;
      if (!userId)
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      const body = req.validated?.body as {
        currentPassword?: string;
        code?: string;
        recoveryCode?: string;
      };
      sendSuccess(
        res,
        await service.twoFactor.regenerateRecoveryCodes({ ...body, userId }, context(req)),
      );
    },

    async refresh(req: Request, res: Response): Promise<void> {
      const body = req.validated?.body as { refreshToken?: string };
      const { token, fromCookie } = readRefreshToken(req, body.refreshToken);

      await assertCsrf(req, token, fromCookie);

      const result = await service.refresh({ refreshToken: token }, context(req));

      setSessionCookies(res, result.refreshToken, result.csrfToken);

      sendSuccess(res, {
        user: result.user,
        accessToken: result.accessToken,
        tokenType: result.tokenType,
        expiresIn: result.expiresIn,
        csrfToken: result.csrfToken,
        session: result.session,
      });
    },

    async logout(req: Request, res: Response): Promise<void> {
      const body = req.validated?.body as { refreshToken?: string } | undefined;

      try {
        const { token, fromCookie } = readRefreshToken(req, body?.refreshToken);

        await assertCsrf(req, token, fromCookie);

        const session = await findSessionByRefreshToken(getPrismaClient(), token);

        if (session) {
          await service.logout({ sessionId: session.id }, context(req));
        }
      } finally {
        clearSessionCookies(res);
      }

      res.status(204).end();
    },

    async logoutAll(req: Request, res: Response): Promise<void> {
      const auth = req.auth;

      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      await service.logoutAll({ userId: auth.userId }, context(req));

      clearSessionCookies(res);

      res.status(204).end();
    },

    async sessions(req: Request, res: Response): Promise<void> {
      const auth = req.auth;

      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      const sessions = await service.listSessions({
        userId: auth.userId,
        currentSessionId: auth.sessionId,
      });

      sendSuccess(res, { sessions });
    },

    async me(req: Request, res: Response): Promise<void> {
      const auth = req.auth;

      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      sendSuccess(res, {
        user: {
          id: auth.userId,
          email: auth.email,
          name: auth.name,
          status: auth.status,
          emailVerified: auth.status === 'ACTIVE',
        },
      });
    },

    async requestPasswordReset(req: Request, res: Response): Promise<void> {
      const body = req.validated?.body as { email: string };

      await service.requestPasswordReset({ email: body.email }, context(req));

      sendSuccess(res, { message: GENERIC_EMAIL_RESPONSE });
    },

    async resetPassword(req: Request, res: Response): Promise<void> {
      const body = req.validated?.body as PasswordResetInput;

      await service.resetPassword(body, context(req));

      clearSessionCookies(res);

      sendSuccess(res, { message: 'Your password has been reset. Please sign in again.' });
    },

    async changePassword(req: Request, res: Response): Promise<void> {
      const auth = req.auth;

      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      const body = req.validated?.body as PasswordChangeInput;

      await service.changePassword(
        { ...body, userId: auth.userId, sessionId: auth.sessionId },
        context(req),
      );

      sendSuccess(res, { message: 'Your password has been changed.' });
    },

    async requestEmailChange(req: Request, res: Response): Promise<void> {
      const auth = req.auth;

      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      const body = req.validated?.body as EmailChangeInput;

      await service.requestEmailChange({ ...body, userId: auth.userId }, context(req));

      sendSuccess(res, {
        message: 'A confirmation link has been sent to the new email address.',
      });
    },

    async confirmEmailChange(req: Request, res: Response): Promise<void> {
      const body = req.validated?.body as { token: string };
      const result = await service.confirmEmailChange({ token: body.token }, context(req));

      sendSuccess(res, { user: result.user });
    },

    async deactivate(req: Request, res: Response): Promise<void> {
      const auth = req.auth;

      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      const body = req.validated?.body as { currentPassword: string };

      await service.deactivateAccount(
        { userId: auth.userId, currentPassword: body.currentPassword },
        context(req),
      );

      clearSessionCookies(res);

      res.status(204).end();
    },

    async reactivate(req: Request, res: Response): Promise<void> {
      const body = req.validated?.body as LoginInput;
      const result = await service.reactivateAccount(body, context(req));

      clearSessionCookies(res);

      sendSuccess(res, { user: result.user });
    },

    async remove(req: Request, res: Response): Promise<void> {
      const auth = req.auth;

      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      const body = req.validated?.body as AccountDeleteInput;

      const result = await service.deleteAccount({ ...body, userId: auth.userId }, context(req));

      clearSessionCookies(res);

      sendSuccess(
        res,
        {
          status: 'PENDING_DELETION',
          scheduledDeletionAt: result.scheduledDeletionAt,
        },
        202,
      );
    },
  };
}

export type AuthController = ReturnType<typeof createAuthController>;
