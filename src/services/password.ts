import * as bcrypt from 'bcrypt';
import { ValidationError } from '../utils/errors';

/**
 * Password hashing and verification.
 *
 * bcrypt is used with a configurable cost factor. bcrypt only considers the
 * first 72 bytes of a password, so the maximum password length is validated
 * explicitly instead of silently truncating user input.
 */

/** Maximum password length in bytes, limited by bcrypt's 72-byte input. */
export const PASSWORD_MAX_BYTES = 72;

/** Maximum password length in characters, to keep request bodies bounded. */
export const PASSWORD_MAX_LENGTH = 128;

export async function hashPassword(password: string, saltRounds: number): Promise<string> {
  return bcrypt.hash(password, saltRounds);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  if (!passwordHash) {
    return false;
  }

  try {
    return await bcrypt.compare(password, passwordHash);
  } catch {
    // A malformed hash must never surface as a 500 to the caller.
    return false;
  }
}

export function assertPasswordLength(password: string): void {
  const byteLength = Buffer.byteLength(password, 'utf8');

  if (byteLength > PASSWORD_MAX_BYTES) {
    throw new ValidationError('The request contains invalid data', [
      {
        field: 'body.password',
        message: `Password must not exceed ${PASSWORD_MAX_BYTES} bytes`,
      },
    ]);
  }
}
