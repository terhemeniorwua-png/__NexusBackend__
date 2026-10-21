import type { AuthToken, AuthTokenPurpose, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { generateSecureToken, hashSecret } from '../../utils/crypto';

/**
 * Single-use, expiring tokens for email verification, password resets and
 * email address changes.
 *
 * Only the SHA-256 digest of a token is stored, so a database leak does not
 * expose usable credentials. A token is valid exactly once: consuming it
 * stamps `usedAt`, and issuing a new token of the same purpose removes any
 * older unused tokens for that user.
 */

export interface IssuedAuthToken {
  id: string;
  token: string;
  expiresAt: Date;
}

export async function issueAuthToken(
  prisma: PrismaClient,
  input: {
    userId: string;
    purpose: AuthTokenPurpose;
    ttlSeconds: number;
    targetEmail?: string | undefined;
  },
): Promise<IssuedAuthToken> {
  const token = generateSecureToken();
  const tokenHash = hashSecret(token);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1_000);

  const created = await prisma.$transaction(async (tx) => {
    // Only the newest token of a purpose may be used.
    await tx.authToken.deleteMany({
      where: {
        userId: input.userId,
        purpose: input.purpose,
        usedAt: null,
      },
    });

    return tx.authToken.create({
      data: {
        userId: input.userId,
        purpose: input.purpose,
        tokenHash,
        expiresAt,
        ...(input.targetEmail ? { targetEmail: input.targetEmail } : {}),
      },
    });
  });

  return { id: created.id, token, expiresAt };
}

/**
 * Validates a one-time token and marks it as used.
 *
 * Expired and already-used tokens are rejected with distinct error codes so
 * the frontend can explain what happened.
 */
export async function consumeAuthToken(
  prisma: PrismaClient,
  input: { token: string; purpose: AuthTokenPurpose },
): Promise<AuthToken> {
  const tokenHash = hashSecret(input.token);

  const record = await prisma.authToken.findUnique({
    where: { tokenHash },
  });

  if (!record || record.purpose !== input.purpose) {
    throw new AppError(400, 'TOKEN_INVALID', 'This link is invalid or has already been used');
  }

  if (record.usedAt) {
    throw new AppError(400, 'TOKEN_ALREADY_USED', 'This link has already been used');
  }

  if (record.expiresAt.getTime() <= Date.now()) {
    throw new AppError(400, 'TOKEN_EXPIRED', 'This link has expired. Please request a new one.');
  }

  const updated = await prisma.authToken.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  if (updated.count === 0) {
    throw new AppError(400, 'TOKEN_ALREADY_USED', 'This link has already been used');
  }

  return { ...record, usedAt: new Date() };
}

export async function invalidateAuthTokens(
  prisma: PrismaClient,
  input: { userId: string; purpose: AuthTokenPurpose },
): Promise<void> {
  await prisma.authToken.updateMany({
    where: {
      userId: input.userId,
      purpose: input.purpose,
      usedAt: null,
    },
    data: { usedAt: new Date() },
  });
}
