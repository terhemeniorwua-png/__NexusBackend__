import jwt from 'jsonwebtoken';
import type { AppConfig } from '../../config/env';
import { AppError } from '../../utils/errors';

/**
 * Short-lived access tokens.
 *
 * Access tokens are JWTs so that ordinary API calls do not require a database
 * round trip for signature verification. Revocation is still authoritative:
 * the request guard verifies the referenced session against PostgreSQL before
 * trusting a token, so logging out or changing a password takes effect
 * immediately.
 */

export type SessionAuthMethodClaim = 'password' | 'social' | 'sso' | 'break_glass';

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Session id, used to enforce revocation. */
  sid: string;
  /** Authentication method for this session. */
  amr?: SessionAuthMethodClaim;
  /** Token type guard, so a refresh token can never be used as an access token. */
  typ: 'access';
}

export function signAccessToken(
  config: AppConfig,
  payload: { userId: string; sessionId: string; authMethod?: SessionAuthMethodClaim },
): { token: string; expiresIn: number } {
  const token = jwt.sign(
    {
      sub: payload.userId,
      sid: payload.sessionId,
      ...(payload.authMethod ? { amr: payload.authMethod } : {}),
      typ: 'access' as const,
    },
    config.jwtAccessSecret,
    {
      algorithm: 'HS256',
      expiresIn: config.jwtAccessTtlSeconds,
      issuer: 'nexus-backend',
      audience: 'nexus-api',
    },
  );

  return { token, expiresIn: config.jwtAccessTtlSeconds };
}

export function verifyAccessToken(config: AppConfig, token: string): AccessTokenClaims {
  let decoded: unknown;

  try {
    decoded = jwt.verify(token, config.jwtAccessSecret, {
      algorithms: ['HS256'],
      issuer: 'nexus-backend',
      audience: 'nexus-api',
    });
  } catch (error) {
    const expired = error instanceof jwt.TokenExpiredError;

    throw new AppError(
      401,
      expired ? 'ACCESS_TOKEN_EXPIRED' : 'ACCESS_TOKEN_INVALID',
      expired ? 'Your session has expired. Please sign in again.' : 'The access token is invalid',
    );
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw new AppError(401, 'ACCESS_TOKEN_INVALID', 'The access token is invalid');
  }

  const claims = decoded as Partial<AccessTokenClaims>;

  if (
    claims.typ !== 'access' ||
    typeof claims.sub !== 'string' ||
    typeof claims.sid !== 'string' ||
    claims.sub.length === 0 ||
    claims.sid.length === 0
  ) {
    throw new AppError(401, 'ACCESS_TOKEN_INVALID', 'The access token is invalid');
  }

  const amr = (claims as { amr?: unknown }).amr;
  return {
    sub: claims.sub,
    sid: claims.sid,
    ...(amr === 'password' || amr === 'social' || amr === 'sso' || amr === 'break_glass' ? { amr } : {}),
    typ: 'access',
  };
}
