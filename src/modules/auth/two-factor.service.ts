import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Prisma, PrismaClient, User } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { getRedisClient } from '../../db/redis';
import { buildEmailBrand, buildSecurityNotificationEmail, sendEmail } from '../../services/email';
import { hashSecret } from '../../utils/crypto';
import { AppError } from '../../utils/errors';
import { recordSecurityEvent, SecurityAction } from './security-events';
import { verifyPassword } from '../../services/password';
import {
  createRecoveryCode,
  createTotpUri,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  normalizeRecoveryCode,
  verifyTotp,
} from './totp';
import type { AuthenticationResult, RequestContext } from './auth.types';

const CHALLENGE_TTL_SECONDS = 300;
const FAILURE_TTL_SECONDS = 900;
const MAX_FAILURES = 5;

export interface TwoFactorService {
  issueChallenge(
    user: User,
  ): Promise<{ twoFactorRequired: true; challengeToken: string; expiresIn: number }>;
  revokeChallenges(userId: string): Promise<void>;
  beginSetup(
    userId: string,
    ctx: RequestContext,
  ): Promise<{ otpauthUrl: string; expiresIn: number }>;
  confirmSetup(
    userId: string,
    code: string,
    ctx: RequestContext,
  ): Promise<{ recoveryCodes: string[] }>;
  completeLogin(
    input: { challengeToken: string; code?: string; recoveryCode?: string },
    ctx: RequestContext,
  ): Promise<AuthenticationResult>;
  disable(
    input: { userId: string; currentPassword: string; code?: string; recoveryCode?: string },
    ctx: RequestContext,
  ): Promise<void>;
  regenerateRecoveryCodes(
    input: { userId: string; currentPassword?: string; code?: string; recoveryCode?: string },
    ctx: RequestContext,
  ): Promise<{ recoveryCodes: string[] }>;
}

export function createTwoFactorService(
  config: AppConfig,
  prisma: PrismaClient,
  finishLogin: (user: User, ctx: RequestContext) => Promise<AuthenticationResult>,
): TwoFactorService {
  const brand = buildEmailBrand(config);

  function redis() {
    const client = getRedisClient(config.redisUrl);
    if (!client.isReady)
      throw new AppError(
        503,
        'MFA_UNAVAILABLE',
        'Two-factor verification is temporarily unavailable',
      );
    return client;
  }

  function failureKeys(userId: string, ctx: RequestContext): [string, string] {
    const address = hashSecret(ctx.ip ?? 'unknown');
    return [
      `${config.rateLimitNamespace}:mfa:fail:user:${userId}`,
      `${config.rateLimitNamespace}:mfa:fail:ip:${address}`,
    ];
  }

  async function assertNotLocked(userId: string, ctx: RequestContext): Promise<void> {
    const client = redis();
    const counts = await client.mGet(failureKeys(userId, ctx));
    if (counts.some((count) => Number(count ?? 0) >= MAX_FAILURES)) {
      throw new AppError(429, 'MFA_LOCKED', 'Too many verification failures. Try again later.');
    }
  }

  async function recordFailure(userId: string, ctx: RequestContext): Promise<void> {
    const client = redis();
    for (const key of failureKeys(userId, ctx)) {
      const value = await client.incr(key);
      if (value === 1) await client.expire(key, FAILURE_TTL_SECONDS);
    }
    await recordSecurityEvent(prisma, {
      action: SecurityAction.TwoFactorFailed,
      targetType: 'User',
      targetId: userId,
      actorId: userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  async function clearFailures(userId: string, ctx: RequestContext): Promise<void> {
    await redis().del(failureKeys(userId, ctx));
  }

  async function verifyCode(
    user: User,
    input: { code?: string; recoveryCode?: string },
    ctx: RequestContext,
    allowPending = false,
  ): Promise<void> {
    await assertNotLocked(user.id, ctx);
    const encrypted = user.twoFactorSecretEncrypted;
    if (!encrypted)
      throw new AppError(
        409,
        'TWO_FACTOR_NOT_CONFIGURED',
        'Two-factor authentication is not configured',
      );
    const secret = decryptTotpSecret(encrypted, config.totpEncryptionKey);
    let valid = false;

    if (input.code) {
      const counter = verifyTotp(secret, input.code);
      if (counter !== null) {
        if (allowPending) valid = true;
        else {
          const set = await redis().set(
            `${config.rateLimitNamespace}:mfa:totp:${user.id}:${counter}`,
            '1',
            { EX: 120, NX: true },
          );
          valid = set === 'OK';
        }
      }
    } else if (input.recoveryCode) {
      const digest = hashSecret(normalizeRecoveryCode(input.recoveryCode));
      const result = await prisma.$transaction(async (tx) => {
        const record = await tx.twoFactorRecoveryCode.findFirst({
          where: { userId: user.id, codeHash: digest, usedAt: null },
          select: { id: true },
        });
        if (!record) return false;
        const updated = await tx.twoFactorRecoveryCode.updateMany({
          where: { id: record.id, userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        });
        return updated.count === 1;
      });
      valid = result;
    }

    if (!valid) {
      await recordFailure(user.id, ctx);
      throw new AppError(
        401,
        'MFA_CODE_INVALID',
        'The verification code is invalid or has already been used',
      );
    }
    await clearFailures(user.id, ctx);
  }

  async function newRecoveryCodes(userId: string, tx: Prisma.TransactionClient): Promise<string[]> {
    const codes = Array.from({ length: 10 }, createRecoveryCode);
    await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
    await tx.twoFactorRecoveryCode.createMany({
      data: codes.map((code) => ({ userId, codeHash: hashSecret(normalizeRecoveryCode(code)) })),
    });
    return codes;
  }

  async function notify(user: User, enabled: boolean): Promise<void> {
    await sendEmail(
      buildSecurityNotificationEmail({
        to: user.email,
        name: user.name,
        brand,
        subject: `Two-factor authentication ${enabled ? 'enabled' : 'disabled'}`,
        detail: `Two-factor authentication was ${enabled ? 'enabled' : 'disabled'} for your ${brand.appName} account. If this was not you, reset your password and contact support.`,
        actionUrl: `${config.frontendUrl.replace(/\/+$/, '')}/settings/security`,
        actionLabel: 'Review security settings',
        idempotencyKey: `auth:two_factor:${enabled ? 'enabled' : 'disabled'}:${user.id}:${Date.now()}`,
      }),
    );
  }

  return {
    async issueChallenge(user) {
      const client = redis();
      const tokenId = randomUUID();
      const challengeToken = jwt.sign(
        { sub: user.id, typ: 'mfa_challenge', jti: tokenId },
        config.jwtAccessSecret,
        {
          algorithm: 'HS256',
          expiresIn: CHALLENGE_TTL_SECONDS,
          issuer: 'nexus-backend',
          audience: 'nexus-mfa',
        },
      );
      const saved = await client.set(
        `${config.rateLimitNamespace}:mfa:challenge:${tokenId}`,
        user.id,
        {
          EX: CHALLENGE_TTL_SECONDS,
          NX: true,
        },
      );
      if (saved !== 'OK')
        throw new AppError(
          503,
          'MFA_UNAVAILABLE',
          'Two-factor verification is temporarily unavailable',
        );
      await client.sAdd(`${config.rateLimitNamespace}:mfa:challenges:${user.id}`, tokenId);
      await client.expire(
        `${config.rateLimitNamespace}:mfa:challenges:${user.id}`,
        CHALLENGE_TTL_SECONDS,
      );
      await recordSecurityEvent(prisma, {
        action: SecurityAction.TwoFactorChallengeIssued,
        targetType: 'User',
        targetId: user.id,
        actorId: user.id,
      });
      return { twoFactorRequired: true, challengeToken, expiresIn: CHALLENGE_TTL_SECONDS };
    },

    async revokeChallenges(userId) {
      const client = redis();
      const setKey = `${config.rateLimitNamespace}:mfa:challenges:${userId}`;
      const tokenIds = await client.sMembers(setKey);
      if (tokenIds.length)
        await client.del(
          tokenIds.map((tokenId) => `${config.rateLimitNamespace}:mfa:challenge:${tokenId}`),
        );
      await client.del(setKey);
    },

    async beginSetup(userId, _ctx) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || user.deletedAt)
        throw new AppError(404, 'USER_NOT_FOUND', 'The requested account was not found');
      if (user.twoFactorEnabled)
        throw new AppError(
          409,
          'TWO_FACTOR_ALREADY_ENABLED',
          'Disable two-factor authentication before setting it up again',
        );
      const secret = generateTotpSecret();
      await prisma.user.update({
        where: { id: user.id },
        data: {
          twoFactorSecretEncrypted: encryptTotpSecret(secret, config.totpEncryptionKey),
          twoFactorVerifiedAt: null,
          twoFactorSetupExpiresAt: new Date(Date.now() + 600_000),
        },
      });
      return {
        otpauthUrl: createTotpUri({ secret, account: user.email, issuer: config.appName }),
        expiresIn: 600,
      };
    },

    async confirmSetup(userId, code, ctx) {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || user.deletedAt)
        throw new AppError(404, 'USER_NOT_FOUND', 'The requested account was not found');
      if (user.twoFactorEnabled)
        throw new AppError(
          409,
          'TWO_FACTOR_ALREADY_ENABLED',
          'Two-factor authentication is already enabled',
        );
      if (
        !user.twoFactorSecretEncrypted ||
        !user.twoFactorSetupExpiresAt ||
        user.twoFactorSetupExpiresAt <= new Date()
      )
        throw new AppError(409, 'TWO_FACTOR_SETUP_REQUIRED', 'Start two-factor setup first');
      await assertNotLocked(userId, ctx);
      const secret = decryptTotpSecret(user.twoFactorSecretEncrypted, config.totpEncryptionKey);
      if (verifyTotp(secret, code) === null) {
        await recordFailure(userId, ctx);
        throw new AppError(401, 'MFA_CODE_INVALID', 'The verification code is invalid');
      }
      const verifiedAt = new Date();
      const codes = await prisma.$transaction(async (tx) => {
        const result = await tx.user.updateMany({
          where: {
            id: userId,
            twoFactorEnabled: false,
            twoFactorSecretEncrypted: user.twoFactorSecretEncrypted,
          },
          data: {
            twoFactorEnabled: true,
            twoFactorVerifiedAt: verifiedAt,
            twoFactorSetupExpiresAt: null,
          },
        });
        if (result.count !== 1)
          throw new AppError(
            409,
            'TWO_FACTOR_SETUP_CHANGED',
            'Two-factor setup changed; begin again',
          );
        return newRecoveryCodes(userId, tx);
      });
      await recordSecurityEvent(prisma, {
        action: SecurityAction.TwoFactorEnabled,
        targetType: 'User',
        targetId: userId,
        actorId: userId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      await clearFailures(userId, ctx);
      await notify(user, true);
      return { recoveryCodes: codes };
    },

    async completeLogin(input, ctx) {
      let claims: { sub: string; typ: string; jti: string };
      try {
        const decoded = jwt.verify(input.challengeToken, config.jwtAccessSecret, {
          algorithms: ['HS256'],
          issuer: 'nexus-backend',
          audience: 'nexus-mfa',
        });
        if (
          typeof decoded !== 'object' ||
          decoded.typ !== 'mfa_challenge' ||
          typeof decoded.sub !== 'string' ||
          typeof decoded.jti !== 'string'
        )
          throw new Error('invalid challenge claims');
        claims = decoded as typeof claims;
      } catch {
        throw new AppError(
          401,
          'MFA_CHALLENGE_INVALID',
          'The verification challenge is invalid or expired',
        );
      }
      const challengeKey = `${config.rateLimitNamespace}:mfa:challenge:${claims.jti}`;
      const userId = await redis().get(challengeKey);
      if (!userId || userId !== claims.sub)
        throw new AppError(
          401,
          'MFA_CHALLENGE_INVALID',
          'The verification challenge is invalid or expired',
        );
      const user = await prisma.user.findUnique({ where: { id: claims.sub } });
      if (!user || !user.twoFactorEnabled || user.deletedAt || user.status !== 'ACTIVE')
        throw new AppError(
          401,
          'MFA_CHALLENGE_INVALID',
          'The verification challenge is invalid or expired',
        );
      await verifyCode(user, input, ctx);
      const consumed = await redis().getDel(challengeKey);
      if (consumed !== user.id)
        throw new AppError(
          401,
          'MFA_CHALLENGE_INVALID',
          'The verification challenge is invalid or expired',
        );
      await redis().sRem(`${config.rateLimitNamespace}:mfa:challenges:${user.id}`, claims.jti);
      return finishLogin(user, ctx);
    },

    async disable(input, ctx) {
      const user = await prisma.user.findUnique({ where: { id: input.userId } });
      if (!user || user.deletedAt)
        throw new AppError(404, 'USER_NOT_FOUND', 'The requested account was not found');
      if (!user.twoFactorEnabled)
        throw new AppError(
          409,
          'TWO_FACTOR_NOT_ENABLED',
          'Two-factor authentication is not enabled',
        );
      if (!(await verifyPassword(input.currentPassword, user.passwordHash)))
        throw new AppError(401, 'INVALID_CREDENTIALS', 'The current password is incorrect');
      await verifyCode(user, input, ctx);
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            twoFactorEnabled: false,
            twoFactorSecretEncrypted: null,
            twoFactorVerifiedAt: null,
            twoFactorSetupExpiresAt: null,
          },
        });
        await tx.twoFactorRecoveryCode.deleteMany({ where: { userId: user.id } });
      });
      await recordSecurityEvent(prisma, {
        action: SecurityAction.TwoFactorDisabled,
        targetType: 'User',
        targetId: user.id,
        actorId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      await notify(user, false);
    },

    async regenerateRecoveryCodes(input, ctx) {
      const user = await prisma.user.findUnique({ where: { id: input.userId } });
      if (!user || user.deletedAt)
        throw new AppError(404, 'USER_NOT_FOUND', 'The requested account was not found');
      if (!user.twoFactorEnabled)
        throw new AppError(
          409,
          'TWO_FACTOR_NOT_ENABLED',
          'Two-factor authentication is not enabled',
        );
      if (input.currentPassword) {
        if (!(await verifyPassword(input.currentPassword, user.passwordHash)))
          throw new AppError(401, 'INVALID_CREDENTIALS', 'The current password is incorrect');
      } else {
        await verifyCode(user, input, ctx);
      }
      const codes = await prisma.$transaction((tx) => newRecoveryCodes(user.id, tx));
      await recordSecurityEvent(prisma, {
        action: SecurityAction.TwoFactorRecoveryCodesRegenerated,
        targetType: 'User',
        targetId: user.id,
        actorId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { recoveryCodes: codes };
    },
  };
}
