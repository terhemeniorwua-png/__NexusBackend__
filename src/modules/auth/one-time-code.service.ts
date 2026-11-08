import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { AuthOneTimeCodePurpose, PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { AppError } from '../../utils/errors';

const CODE_TTL_MS = 10 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
const MAX_ATTEMPTS = 5;

export function hashOneTimeCode(
  config: AppConfig,
  input: { code: string; userId: string; purpose: AuthOneTimeCodePurpose },
): string {
  return createHmac('sha256', config.otpHmacSecret)
    .update(input.code + input.userId + input.purpose)
    .digest('hex');
}

export async function issueOneTimeCode(
  prisma: PrismaClient,
  config: AppConfig,
  input: { userId: string; purpose: AuthOneTimeCodePurpose; force?: boolean },
): Promise<{ code: string; expiresAt: Date } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
    const previous = await tx.authOneTimeCode.findFirst({
      where: { userId: input.userId, purpose: input.purpose },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    if (
      !input.force &&
      previous &&
      now.getTime() - previous.lastSentAt.getTime() < RESEND_COOLDOWN_MS
    ) {
      return null;
    }
    await tx.authOneTimeCode.updateMany({
      where: { userId: input.userId, purpose: input.purpose, consumedAt: null },
      data: { consumedAt: now },
    });
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
    await tx.authOneTimeCode.create({
      data: {
        userId: input.userId,
        purpose: input.purpose,
        codeHash: hashOneTimeCode(config, { code, userId: input.userId, purpose: input.purpose }),
        expiresAt,
        lastSentAt: now,
      },
    });
    return { code, expiresAt };
  });
}

export async function consumeOneTimeCode(
  prisma: PrismaClient,
  config: AppConfig,
  input: { email: string; code: string; purpose: AuthOneTimeCodePurpose },
): Promise<{ userId: string }> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const record = user
    ? await prisma.authOneTimeCode.findFirst({
        where: { userId: user.id, purpose: input.purpose, consumedAt: null },
        orderBy: { createdAt: 'desc' },
      })
    : null;
  if (!user || !record || record.expiresAt.getTime() <= Date.now()) {
    if (record)
      await prisma.authOneTimeCode.updateMany({
        where: { id: record.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
    throw new AppError(400, 'INVALID_OR_EXPIRED_CODE', 'The code is invalid or has expired.');
  }
  const expected = Buffer.from(
    hashOneTimeCode(config, { code: input.code, userId: user.id, purpose: input.purpose }),
    'hex',
  );
  const actual = Buffer.from(record.codeHash, 'hex');
  const matches = actual.length === expected.length && timingSafeEqual(actual, expected);
  if (!matches) {
    const attempts = record.attempts + 1;
    await prisma.authOneTimeCode.updateMany({
      where: { id: record.id, consumedAt: null, attempts: record.attempts },
      data: { attempts, ...(attempts >= MAX_ATTEMPTS ? { consumedAt: new Date() } : {}) },
    });
    if (attempts >= MAX_ATTEMPTS)
      throw new AppError(400, 'TOO_MANY_ATTEMPTS', 'Too many incorrect codes. Request a new code.');
    throw new AppError(400, 'INVALID_OR_EXPIRED_CODE', 'The code is invalid or has expired.');
  }
  const consumed = await prisma.authOneTimeCode.updateMany({
    where: {
      id: record.id,
      consumedAt: null,
      attempts: record.attempts,
      expiresAt: { gt: new Date() },
    },
    data: { consumedAt: new Date() },
  });
  if (!consumed.count)
    throw new AppError(400, 'INVALID_OR_EXPIRED_CODE', 'The code is invalid or has expired.');
  return { userId: user.id };
}
