import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Cryptographic helpers for authentication tokens, CSRF tokens and
 * non-reversible identifiers.
 *
 * Rules enforced here:
 * - Tokens are generated with a CSPRNG (`randomBytes`).
 * - Only hashes of secret tokens are ever persisted.
 * - Comparisons of secret values are constant time.
 */

/** Number of random bytes used for opaque session and one-time tokens. */
export const TOKEN_BYTES = 32;

/**
 * Generates a cryptographically secure, URL-safe opaque token.
 */
export function generateSecureToken(byteLength: number = TOKEN_BYTES): string {
  return randomBytes(byteLength).toString('base64url');
}

/**
 * Produces the SHA-256 hex digest of a secret value.
 *
 * Used to store one-time tokens and refresh tokens without keeping the
 * plaintext secret in the database.
 */
export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Derives a purpose-specific key from a master secret.
 *
 * Prevents key reuse across unrelated purposes (for example CSRF signing and
 * access-token signing).
 */
export function deriveKey(secret: string, purpose: string): string {
  return createHmac('sha256', secret).update(`nexus:${purpose}:v1`).digest('base64url');
}

/**
 * Signs a value with a derived key. The result is deterministic, which lets a
 * stateless CSRF token be recomputed and compared on the server.
 */
export function signValue(key: string, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('base64url');
}

/**
 * Compares two strings without leaking their contents through timing.
 */
export function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    // Perform a comparison anyway so the failure path costs roughly the same
    // as the success path.
    timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
