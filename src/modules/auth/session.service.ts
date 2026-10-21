import type { PrismaClient, Session } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { generateSecureToken, hashSecret } from '../../utils/crypto';

/**
 * Browser sessions.
 *
 * A session is a row in PostgreSQL that holds the hash of the current refresh
 * token. The refresh token itself is an opaque random value handed to the
 * client in an httpOnly cookie; only its digest is stored.
 *
 * Refresh tokens rotate on every use. The digest of the previous token is
 * kept for one rotation so that a replayed token can be recognised and the
 * whole session family can be revoked.
 */

export interface IssuedSession {
  session: Session;
  refreshToken: string;
}

export async function createSession(
  prisma: PrismaClient,
  input: {
    userId: string;
    ttlSeconds: number;
    userAgent?: string | undefined;
    ip?: string | undefined;
  },
): Promise<IssuedSession> {
  const refreshToken = generateSecureToken();
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1_000);

  const session = await prisma.session.create({
    data: {
      userId: input.userId,
      refreshTokenHash: hashSecret(refreshToken),
      expiresAt,
      lastUsedAt: new Date(),
      ...(input.userAgent ? { userAgent: input.userAgent.slice(0, 512) } : {}),
      ...(input.ip ? { ip: input.ip.slice(0, 128) } : {}),
    },
  });

  return { session, refreshToken };
}

export type RotationOutcome =
  | { kind: 'rotated'; session: Session; refreshToken: string }
  | { kind: 'reused'; session: Session };

/**
 * Rotates the refresh token of an active session.
 *
 * Presenting a token that was already rotated is treated as a compromise:
 * every session belonging to the user is revoked.
 */
export async function rotateSession(
  prisma: PrismaClient,
  input: {
    refreshToken: string;
    userAgent?: string | undefined;
    ip?: string | undefined;
  },
): Promise<RotationOutcome> {
  const tokenHash = hashSecret(input.refreshToken);

  const current = await prisma.session.findUnique({
    where: { refreshTokenHash: tokenHash },
  });

  if (!current) {
    const previous = await prisma.session.findUnique({
      where: { previousRefreshTokenHash: tokenHash },
    });

    if (previous) {
      return { kind: 'reused', session: previous };
    }

    throw new AppError(401, 'REFRESH_TOKEN_INVALID', 'Your session is no longer valid');
  }

  if (current.revokedAt) {
    return { kind: 'reused', session: current };
  }

  if (current.expiresAt.getTime() <= Date.now()) {
    throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
  }

  const nextRefreshToken = generateSecureToken();

  const session = await prisma.session.update({
    where: { id: current.id },
    data: {
      refreshTokenHash: hashSecret(nextRefreshToken),
      previousRefreshTokenHash: tokenHash,
      lastUsedAt: new Date(),
      ...(input.userAgent ? { userAgent: input.userAgent.slice(0, 512) } : {}),
      ...(input.ip ? { ip: input.ip.slice(0, 128) } : {}),
    },
  });

  return { kind: 'rotated', session, refreshToken: nextRefreshToken };
}

export async function revokeSession(
  prisma: PrismaClient,
  sessionId: string,
  reason: string,
): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

export async function revokeAllSessions(
  prisma: PrismaClient,
  input: { userId: string; reason: string; exceptSessionId?: string | undefined },
): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      userId: input.userId,
      revokedAt: null,
      ...(input.exceptSessionId ? { id: { not: input.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: input.reason },
  });

  return result.count;
}

export async function listActiveSessions(
  prisma: PrismaClient,
  input: { userId: string; currentSessionId?: string | undefined },
): Promise<Session[]> {
  return prisma.session.findMany({
    where: {
      userId: input.userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function findActiveSession(
  prisma: PrismaClient,
  sessionId: string,
): Promise<Session | null> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
  });

  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return session;
}

/**
 * Finds the session that a refresh token belongs to, whether or not it is
 * still active.
 *
 * Used to resolve the session for CSRF validation and for logout, where a
 * revoked session still has to be identifiable.
 */
export async function findSessionByRefreshToken(
  prisma: PrismaClient,
  refreshToken: string,
): Promise<Session | null> {
  const tokenHash = hashSecret(refreshToken);

  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: tokenHash },
  });

  if (session) {
    return session;
  }

  return prisma.session.findUnique({
    where: { previousRefreshTokenHash: tokenHash },
  });
}
