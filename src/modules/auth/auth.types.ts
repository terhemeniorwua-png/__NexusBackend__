import type { UserStatus } from '@prisma/client';

/**
 * Shared shapes for the authentication module.
 */

/** User representation that is safe to return over HTTP. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

/** Details about the caller that are recorded with security events. */
export interface RequestContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/** A browser session backed by a row in the `Session` table. */
export interface SessionSummary {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  current: boolean;
}

/** The result of a successful authentication. */
export interface AuthenticationResult {
  user: PublicUser;
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  csrfToken: string;
  /** Opaque refresh token. The controller stores it in an httpOnly cookie. */
  refreshToken: string;
  session: {
    id: string;
    expiresAt: Date;
  };
}
