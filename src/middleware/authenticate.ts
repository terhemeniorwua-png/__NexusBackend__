import type { RequestHandler } from 'express';
import type { AppConfig } from '../config/env';
import { getPrismaClient } from '../db/prisma';
import { AppError } from '../utils/errors';
import { verifyAccessToken } from '../modules/auth/access-token.service';
import { findActiveSession } from '../modules/auth/session.service';

/**
 * Request guards for authenticated routes.
 *
 * The access token is a short-lived JWT, but the referenced session is always
 * checked against PostgreSQL before a request is trusted. That makes logout,
 * "log out other devices", password resets and suspensions effective
 * immediately instead of waiting for the access token to expire.
 */

export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  name: string;
  status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' | 'PENDING_DELETION';
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  const [scheme, ...rest] = header.split(' ');

  if (!scheme || scheme.toLowerCase() !== 'bearer') {
    return null;
  }

  const token = rest.join(' ').trim();

  return token.length > 0 ? token : null;
}

export function createRequireAuth(config: AppConfig): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = extractBearerToken(req.header('authorization'));

      if (!token) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      const claims = verifyAccessToken(config, token);
      const session = await findActiveSession(getPrismaClient(), claims.sid);

      if (!session || session.userId !== claims.sub) {
        throw new AppError(
          401,
          'SESSION_REVOKED',
          'Your session is no longer valid. Please sign in again.',
        );
      }

      const user = await getPrismaClient().user.findUnique({
        where: { id: claims.sub },
        select: { id: true, email: true, name: true, status: true, deletedAt: true },
      });

      if (!user || user.deletedAt) {
        throw new AppError(401, 'SESSION_REVOKED', 'Your session is no longer valid.');
      }

      if (user.status === 'SUSPENDED') {
        throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended');
      }

      if (user.status === 'DEACTIVATED') {
        throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated');
      }

      if (user.status === 'PENDING_DELETION') {
        throw new AppError(
          403,
          'ACCOUNT_PENDING_DELETION',
          'This account is pending deletion. Recover it before continuing.',
        );
      }

      req.auth = {
        userId: user.id,
        sessionId: session.id,
        email: user.email,
        name: user.name,
        status: user.status,
      };

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Guard for endpoints that require a fully activated account.
 *
 * Accounts that are still `PENDING_VERIFICATION` may authenticate (so they can
 * read their own status and request a new verification link) but must not
 * reach protected business endpoints.
 */
export function requireActiveAccount(req: { auth?: AuthContext }): void {
  if (!req.auth) {
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  }

  if (req.auth.status === 'PENDING_VERIFICATION') {
    throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address to continue');
  }
}

/**
 * Guard for endpoints that require a fully activated account.
 */
export function createRequireActiveAccount(): RequestHandler {
  return (req, _res, next) => {
    try {
      requireActiveAccount(req);
      next();
    } catch (error) {
      next(error);
    }
  };
}
