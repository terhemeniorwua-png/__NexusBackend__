/**
 * Password hashing utility.
 *
 * This module is a thin wrapper kept for historical compatibility.
 * New code should import `hashPassword` and `verifyPassword` directly from
 * `./services/password`, which is used throughout the Nexus auth modules.
 *
 * Uses bcrypt (configured via BCRYPT_SALT_ROUNDS in the environment) to
 * produce a secure one-way hash of a plaintext password.
 */

import bcrypt from 'bcrypt';

/**
 * Hash a plaintext password.
 *
 * @param pass - The plaintext password to hash.
 * @returns A promise that resolves to the bcrypt hash string.
 */
const hashedPassword = (pass: string): Promise<string> => {
  const saltRounds = Number(process.env.BCRYPT_SALT_ROUNDS) || 12;
  return bcrypt.hash(pass, saltRounds);
};

export default hashedPassword;
export { hashedPassword };
