import type { AppConfig } from '../../config/env';
import { deriveKey, safeCompare, signValue } from '../../utils/crypto';

/**
 * CSRF protection for cookie-authenticated requests.
 *
 * The refresh token lives in an httpOnly cookie, so a browser attaches it to
 * cross-site requests automatically. Every request that relies on that cookie
 * must therefore also prove that it originated from the application.
 *
 * The CSRF token is derived from the session id with a key that is separate
 * from the access-token signing key, so it cannot be forged and cannot be
 * replayed against a different session.
 */

export const REFRESH_COOKIE_NAME = 'nexus_rt';
export const CSRF_COOKIE_NAME = 'nexus_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

export interface CsrfValidator {
  tokenFor(sessionId: string): string;
  verify(sessionId: string, provided: string | undefined): boolean;
}

export function createCsrfValidator(config: AppConfig): CsrfValidator {
  const csrfKey = deriveKey(config.jwtAccessSecret, 'csrf');

  return {
    tokenFor(sessionId: string): string {
      return signValue(csrfKey, sessionId);
    },
    verify(sessionId: string, provided: string | undefined): boolean {
      if (!provided) {
        return false;
      }

      return safeCompare(signValue(csrfKey, sessionId), provided);
    },
  };
}
