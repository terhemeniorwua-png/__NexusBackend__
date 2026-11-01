import type { AuthTokenPurpose, PrismaClient, User } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import {
  buildEmailBrand,
  buildEmailChangeEmail,
  buildPasswordChangedEmail,
  buildPasswordResetEmail,
  buildSecurityNotificationEmail,
  buildVerificationEmail,
  sendEmail,
} from '../../services/email';
import { assertPasswordLength, hashPassword, verifyPassword } from '../../services/password';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import { deriveKey, hashSecret, signValue } from '../../utils/crypto';
import { signAccessToken } from './access-token.service';
import { issueAuthToken, consumeAuthToken, invalidateAuthTokens } from './auth-token.service';
import {
  createSession,
  listActiveSessions,
  revokeAllSessions,
  revokeSession,
  rotateSession,
} from './session.service';
import { recordSecurityEvent, SecurityAction } from './security-events';
import type {
  AuthenticationResult,
  PublicUser,
  RequestContext,
  SessionSummary,
} from './auth.types';
import type {
  AccountDeleteInput,
  EmailChangeInput,
  LoginInput,
  PasswordChangeInput,
  PasswordResetInput,
  RegisterInput,
} from './auth.schemas';

/**
 * The Nexus account lifecycle.
 *
 * This service owns every decision about authentication state. Route handlers
 * only translate HTTP into service calls and back again.
 */

/**
 * A bcrypt hash of a random value. Comparing against it when an account does
 * not exist keeps the response time of a login attempt roughly constant, so
 * the endpoint cannot be used to enumerate registered addresses.
 */
const TIMING_EQUALIZER_HASH = '$2b$12$tQY.tSa8/ditlR/rZHqNUedooDRDLtvP5jx1YF0oCDy5Z2ojEpL1S';

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
  };
}

export interface AuthService {
  register(input: RegisterInput, ctx: RequestContext): Promise<{ user: PublicUser }>;
  verifyEmail(input: { token: string }, ctx: RequestContext): Promise<{ user: PublicUser }>;
  resendVerification(input: { email: string }, ctx: RequestContext): Promise<void>;
  login(input: LoginInput, ctx: RequestContext): Promise<AuthenticationResult>;
  refresh(input: { refreshToken: string }, ctx: RequestContext): Promise<AuthenticationResult>;
  logout(input: { sessionId: string }, ctx: RequestContext): Promise<void>;
  logoutAll(input: { userId: string }, ctx: RequestContext): Promise<number>;
  listSessions(input: { userId: string; currentSessionId: string }): Promise<SessionSummary[]>;
  requestPasswordReset(input: { email: string }, ctx: RequestContext): Promise<void>;
  resetPassword(input: PasswordResetInput, ctx: RequestContext): Promise<void>;
  changePassword(
    input: PasswordChangeInput & { userId: string; sessionId: string },
    ctx: RequestContext,
  ): Promise<void>;
  requestEmailChange(
    input: EmailChangeInput & { userId: string },
    ctx: RequestContext,
  ): Promise<void>;
  confirmEmailChange(input: { token: string }, ctx: RequestContext): Promise<{ user: PublicUser }>;
  deactivateAccount(
    input: { userId: string; currentPassword: string },
    ctx: RequestContext,
  ): Promise<void>;
  reactivateAccount(input: LoginInput, ctx: RequestContext): Promise<{ user: PublicUser }>;
  deleteAccount(input: AccountDeleteInput & { userId: string }, ctx: RequestContext): Promise<void>;
}

export function createAuthService(config: AppConfig, prisma?: PrismaClient): AuthService {
  const client = prisma ?? getPrismaClient();
  const csrfKey = deriveKey(config.jwtAccessSecret, 'csrf');
  const brand = buildEmailBrand(config);

  function csrfTokenFor(sessionId: string): string {
    return signValue(csrfKey, sessionId);
  }

  function buildLink(path: string, token: string): string {
    const base = config.frontendUrl.replace(/\/+$/, '');
    return `${base}${path}?token=${encodeURIComponent(token)}`;
  }

  function buildPathLink(path: string): string {
    const base = config.frontendUrl.replace(/\/+$/, '');
    return `${base}${path}`;
  }

  async function findUserByEmail(email: string): Promise<User | null> {
    return client.user.findUnique({ where: { email } });
  }

  async function issueAndSend(
    input: {
      user: User;
      purpose: AuthTokenPurpose;
      ttlSeconds: number;
      targetEmail?: string | undefined;
    },
    buildMessage: (
      token: string,
      expiresAt: Date,
      tokenId: string,
    ) => Parameters<typeof sendEmail>[0],
  ): Promise<void> {
    const issued = await issueAuthToken(client, {
      userId: input.user.id,
      purpose: input.purpose,
      ttlSeconds: input.ttlSeconds,
      targetEmail: input.targetEmail,
    });

    const message = buildMessage(issued.token, issued.expiresAt, issued.id);

    // A delivery failure must not undo the account change that triggered it.
    const result = await sendEmail(message);

    if (!result.accepted) {
      // The token stays valid so the user can request a new link.
      await invalidateAuthTokens(client, {
        userId: input.user.id,
        purpose: input.purpose,
      });
    }
  }

  async function authenticateSession(
    session: { id: string; userId: string; expiresAt: Date },
    user: User,
    refreshToken: string,
  ): Promise<AuthenticationResult> {
    const { token: accessToken, expiresIn } = signAccessToken(config, {
      userId: session.userId,
      sessionId: session.id,
    });

    return {
      user: toPublicUser(user),
      accessToken,
      tokenType: 'Bearer',
      expiresIn,
      csrfToken: csrfTokenFor(session.id),
      refreshToken,
      session: {
        id: session.id,
        expiresAt: session.expiresAt,
      },
    };
  }

  function assertUsableAccount(user: User): void {
    if (user.deletedAt) {
      throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deleted');
    }

    if (user.status === 'SUSPENDED') {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended');
    }

    if (user.status === 'DEACTIVATED') {
      throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated');
    }
  }

  async function requirePassword(user: User, password: string): Promise<void> {
    const matches = await verifyPassword(password, user.passwordHash);

    if (!matches) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'The email address or password is incorrect');
    }
  }

  return {
    async register(input: RegisterInput, ctx: RequestContext): Promise<{ user: PublicUser }> {
      const existing = await findUserByEmail(input.email);

      if (existing) {
        throw new AppError(
          409,
          'EMAIL_ALREADY_REGISTERED',
          'An account with this email address already exists',
        );
      }

      assertPasswordLength(input.password);

      const passwordHash = await hashPassword(input.password, config.bcryptSaltRounds);

      const user = await client.user.create({
        data: {
          email: input.email,
          name: input.name,
          passwordHash,
          status: 'PENDING_VERIFICATION',
          profile: {
            create: {
              timeZone: 'UTC',
              locale: 'en',
            },
          },
        },
      });

      await issueAndSend(
        {
          user,
          purpose: 'EMAIL_VERIFICATION',
          ttlSeconds: config.verificationTokenTtlSeconds,
        },
        (token, expiresAt, tokenId) =>
          buildVerificationEmail({
            to: user.email,
            name: user.name,
            brand,
            verificationUrl: buildLink(config.authVerificationLinkPath, token),
            expiresAt,
            idempotencyKey: `auth:email_verification:${tokenId}`,
          }),
      );

      // An invitation that was sent before the account existed is bound to
      // it now, so the same link lets the new account join the workspace.
      await client.invitation.updateMany({
        where: { email: user.email, status: 'PENDING', forUserId: null },
        data: { forUserId: user.id },
      });

      await recordSecurityEvent(client, {
        action: SecurityAction.AccountRegistered,
        targetType: 'User',
        targetId: user.id,
        actorId: user.id,
        metadata: { status: user.status },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      return { user: toPublicUser(user) };
    },

    async verifyEmail(
      input: { token: string },
      ctx: RequestContext,
    ): Promise<{ user: PublicUser }> {
      const record = await consumeAuthToken(client, {
        token: input.token,
        purpose: 'EMAIL_VERIFICATION',
      });

      const verified = await client.user.updateMany({
        where: {
          id: record.userId,
          deletedAt: null,
          status: { in: ['PENDING_VERIFICATION', 'ACTIVE'] },
        },
        data: {
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
        },
      });

      if (verified.count === 0) {
        const current = await client.user.findUnique({ where: { id: record.userId } });

        if (!current || current.deletedAt) {
          throw new AppError(400, 'TOKEN_INVALID', 'This link is invalid or has already been used');
        }

        if (current.status === 'SUSPENDED') {
          throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended');
        }

        if (current.status === 'DEACTIVATED') {
          throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated');
        }

        throw new AppError(409, 'ACCOUNT_NOT_VERIFIABLE', 'This account cannot be verified');
      }

      const user = await client.user.findUniqueOrThrow({ where: { id: record.userId } });

      await recordSecurityEvent(client, {
        action: SecurityAction.EmailVerified,
        targetType: 'User',
        targetId: user.id,
        actorId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      return { user: toPublicUser(user) };
    },

    async resendVerification(input: { email: string }, ctx: RequestContext): Promise<void> {
      const user = await findUserByEmail(input.email);

      // The response never reveals whether the address is registered.
      if (!user || user.status !== 'PENDING_VERIFICATION' || user.deletedAt) {
        return;
      }

      await issueAndSend(
        {
          user,
          purpose: 'EMAIL_VERIFICATION',
          ttlSeconds: config.verificationTokenTtlSeconds,
        },
        (token, expiresAt, tokenId) =>
          buildVerificationEmail({
            to: user.email,
            name: user.name,
            brand,
            verificationUrl: buildLink(config.authVerificationLinkPath, token),
            expiresAt,
            idempotencyKey: `auth:email_verification:${tokenId}`,
          }),
      );

      await recordSecurityEvent(client, {
        action: SecurityAction.EmailVerificationRequested,
        targetType: 'User',
        targetId: user.id,
        actorId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    },

    async login(input: LoginInput, ctx: RequestContext): Promise<AuthenticationResult> {
      const user = await findUserByEmail(input.email);

      if (!user) {
        await verifyPassword(input.password, TIMING_EQUALIZER_HASH);

        await recordSecurityEvent(client, {
          action: SecurityAction.LoginFailed,
          targetType: 'User',
          targetId: 'unknown',
          metadata: { emailHash: hashSecret(input.email) },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        throw new AppError(
          401,
          'INVALID_CREDENTIALS',
          'The email address or password is incorrect',
        );
      }

      const matches = await verifyPassword(input.password, user.passwordHash);

      if (!matches) {
        await recordSecurityEvent(client, {
          action: SecurityAction.LoginFailed,
          targetType: 'User',
          targetId: user.id,
          actorId: user.id,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        throw new AppError(
          401,
          'INVALID_CREDENTIALS',
          'The email address or password is incorrect',
        );
      }

      assertUsableAccount(user);

      const { session, refreshToken } = await createSession(client, {
        userId: user.id,
        ttlSeconds: config.refreshTokenTtlSeconds,
        userAgent: ctx.userAgent,
        ip: ctx.ip,
      });

      await client.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      await recordSecurityEvent(client, {
        action: SecurityAction.LoginSucceeded,
        targetType: 'Session',
        targetId: session.id,
        actorId: user.id,
        metadata: { userId: user.id, status: user.status },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      const result = await authenticateSession(session, user, refreshToken);

      return result;
    },

    async refresh(
      input: { refreshToken: string },
      ctx: RequestContext,
    ): Promise<AuthenticationResult> {
      const outcome = await rotateSession(client, {
        refreshToken: input.refreshToken,
        userAgent: ctx.userAgent,
        ip: ctx.ip,
      });

      if (outcome.kind === 'reused') {
        const revoked = await revokeAllSessions(client, {
          userId: outcome.session.userId,
          reason: 'REFRESH_TOKEN_REUSE',
        });

        await recordSecurityEvent(client, {
          action: SecurityAction.SessionReuseDetected,
          targetType: 'Session',
          targetId: outcome.session.id,
          actorId: outcome.session.userId,
          metadata: { revokedSessions: revoked },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        throw new AppError(
          401,
          'SESSION_REUSE_DETECTED',
          'Your session was ended for security reasons. Please sign in again.',
        );
      }

      const user = await client.user.findUnique({ where: { id: outcome.session.userId } });

      if (!user) {
        throw new AppError(401, 'REFRESH_TOKEN_INVALID', 'Your session is no longer valid');
      }

      assertUsableAccount(user);

      await recordSecurityEvent(client, {
        action: SecurityAction.SessionRefreshed,
        targetType: 'Session',
        targetId: outcome.session.id,
        actorId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      const result = await authenticateSession(outcome.session, user, outcome.refreshToken);

      return result;
    },

    async logout(input: { sessionId: string }, ctx: RequestContext): Promise<void> {
      await revokeSession(client, input.sessionId, 'LOGOUT');

      await recordSecurityEvent(client, {
        action: SecurityAction.LoggedOut,
        targetType: 'Session',
        targetId: input.sessionId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    },

    async logoutAll(input: { userId: string }, ctx: RequestContext): Promise<number> {
      const revoked = await revokeAllSessions(client, {
        userId: input.userId,
        reason: 'LOGOUT_ALL',
      });

      await recordSecurityEvent(client, {
        action: SecurityAction.LoggedOutAll,
        targetType: 'User',
        targetId: input.userId,
        actorId: input.userId,
        metadata: { revokedSessions: revoked },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      return revoked;
    },

    async listSessions(input: {
      userId: string;
      currentSessionId: string;
    }): Promise<SessionSummary[]> {
      const sessions = await listActiveSessions(client, {
        userId: input.userId,
        currentSessionId: input.currentSessionId,
      });

      return sessions.map((session) => ({
        id: session.id,
        userAgent: session.userAgent,
        ip: session.ip,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        expiresAt: session.expiresAt,
        current: session.id === input.currentSessionId,
      }));
    },

    async requestPasswordReset(input: { email: string }, ctx: RequestContext): Promise<void> {
      const user = await findUserByEmail(input.email);

      // The response never reveals whether the address is registered.
      if (!user || user.deletedAt || user.status === 'DEACTIVATED') {
        return;
      }

      await issueAndSend(
        {
          user,
          purpose: 'PASSWORD_RESET',
          ttlSeconds: config.passwordResetTokenTtlSeconds,
        },
        (token, expiresAt, tokenId) =>
          buildPasswordResetEmail({
            to: user.email,
            name: user.name,
            brand,
            resetUrl: buildLink(config.authPasswordResetLinkPath, token),
            expiresAt,
            idempotencyKey: `auth:password_reset:${tokenId}`,
          }),
      );

      await recordSecurityEvent(client, {
        action: SecurityAction.PasswordResetRequested,
        targetType: 'User',
        targetId: user.id,
        actorId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    },

    async resetPassword(input: PasswordResetInput, ctx: RequestContext): Promise<void> {
      const record = await consumeAuthToken(client, {
        token: input.token,
        purpose: 'PASSWORD_RESET',
      });

      assertPasswordLength(input.password);

      const passwordHash = await hashPassword(input.password, config.bcryptSaltRounds);

      await client.user.update({
        where: { id: record.userId },
        data: { passwordHash },
      });

      // A reset invalidates every existing session.
      const revoked = await revokeAllSessions(client, {
        userId: record.userId,
        reason: 'PASSWORD_RESET',
      });

      await invalidateAuthTokens(client, {
        userId: record.userId,
        purpose: 'PASSWORD_RESET',
      });

      await recordSecurityEvent(client, {
        action: SecurityAction.PasswordReset,
        targetType: 'User',
        targetId: record.userId,
        actorId: record.userId,
        metadata: { revokedSessions: revoked },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    },

    async changePassword(
      input: PasswordChangeInput & { userId: string; sessionId: string },
      ctx: RequestContext,
    ): Promise<void> {
      const user = await client.user.findUnique({ where: { id: input.userId } });

      if (!user) {
        throw new AppError(404, 'USER_NOT_FOUND', 'The requested account was not found');
      }

      await requirePassword(user, input.currentPassword);

      if (await verifyPassword(input.newPassword, user.passwordHash)) {
        throw new AppError(
          400,
          'PASSWORD_UNCHANGED',
          'The new password must be different from the current password',
        );
      }

      assertPasswordLength(input.newPassword);

      const passwordHash = await hashPassword(input.newPassword, config.bcryptSaltRounds);

      await client.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });

      // Every other device is signed out. The current session stays active.
      const revoked = await revokeAllSessions(client, {
        userId: user.id,
        reason: 'PASSWORD_CHANGED',
        exceptSessionId: input.sessionId,
      });

      const changedAt = new Date();

      await sendEmail(
        buildPasswordChangedEmail({
          to: user.email,
          name: user.name,
          brand,
          changedAt,
          resetUrl: buildPathLink(config.authPasswordResetLinkPath),
          idempotencyKey: `auth:password_changed:${user.id}:${changedAt.getTime()}`,
        }),
      );

      await recordSecurityEvent(client, {
        action: SecurityAction.PasswordChanged,
        targetType: 'User',
        targetId: user.id,
        actorId: user.id,
        metadata: { revokedSessions: revoked },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    },

    async requestEmailChange(
      input: EmailChangeInput & { userId: string },
      ctx: RequestContext,
    ): Promise<void> {
      const user = await client.user.findUnique({ where: { id: input.userId } });

      if (!user) {
        throw new AppError(404, 'USER_NOT_FOUND', 'The requested account was not found');
      }

      await requirePassword(user, input.currentPassword);

      if (input.email === user.email) {
        throw new AppError(
          400,
          'EMAIL_UNCHANGED',
          'The new email address must be different from the current one',
        );
      }

      const existing = await findUserByEmail(input.email);

      if (existing) {
        throw new AppError(
          409,
          'EMAIL_ALREADY_REGISTERED',
          'An account with this email address already exists',
        );
      }

      await issueAndSend(
        {
          user,
          purpose: 'EMAIL_CHANGE',
          ttlSeconds: config.emailChangeTokenTtlSeconds,
          targetEmail: input.email,
        },
        (token, expiresAt, tokenId) =>
          buildEmailChangeEmail({
            to: input.email,
            name: user.name,
            brand,
            verificationUrl: buildLink(config.authEmailChangeLinkPath, token),
            expiresAt,
            newEmail: input.email,
            idempotencyKey: `auth:email_change:${tokenId}`,
          }),
      );

      // The current address is notified so the change is not a surprise.
      await sendEmail(
        buildSecurityNotificationEmail({
          to: user.email,
          name: user.name,
          brand,
          subject: `A ${brand.appName} email address change was requested`,
          detail: `A request was made to change the email address on your ${brand.appName} account to ${input.email}. If this was not you, change your password immediately.`,
          actionUrl: buildPathLink(config.authPasswordResetLinkPath),
          actionLabel: 'Reset your password',
          idempotencyKey: `auth:email_change_notice:${user.id}:${hashSecret(input.email)}`,
        }),
      );

      await recordSecurityEvent(client, {
        action: SecurityAction.EmailChangeRequested,
        targetType: 'User',
        targetId: user.id,
        actorId: user.id,
        metadata: { targetEmailHash: hashSecret(input.email) },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    },

    async confirmEmailChange(
      input: { token: string },
      ctx: RequestContext,
    ): Promise<{ user: PublicUser }> {
      const record = await consumeAuthToken(client, {
        token: input.token,
        purpose: 'EMAIL_CHANGE',
      });

      if (!record.targetEmail) {
        throw new AppError(400, 'TOKEN_INVALID', 'This link is invalid or has already been used');
      }

      const current = await client.user.findUnique({ where: { id: record.userId } });

      if (!current || current.deletedAt) {
        throw new AppError(400, 'TOKEN_INVALID', 'This link is invalid or has already been used');
      }

      if (current.status === 'SUSPENDED') {
        throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended');
      }

      if (current.status === 'DEACTIVATED') {
        throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated');
      }

      const existing = await findUserByEmail(record.targetEmail);

      if (existing && existing.id !== record.userId) {
        throw new AppError(
          409,
          'EMAIL_ALREADY_REGISTERED',
          'An account with this email address already exists',
        );
      }

      const changed = await client.user.updateMany({
        where: {
          id: record.userId,
          deletedAt: null,
          status: { in: ['PENDING_VERIFICATION', 'ACTIVE'] },
        },
        data: {
          email: record.targetEmail,
          emailVerifiedAt: new Date(),
          status: 'ACTIVE',
        },
      });

      if (changed.count === 0) {
        const latest = await client.user.findUnique({ where: { id: record.userId } });

        if (!latest || latest.deletedAt) {
          throw new AppError(400, 'TOKEN_INVALID', 'This link is invalid or has already been used');
        }

        if (latest.status === 'SUSPENDED') {
          throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended');
        }

        if (latest.status === 'DEACTIVATED') {
          throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated');
        }

        throw new AppError(409, 'ACCOUNT_NOT_CHANGEABLE', 'This account cannot be changed');
      }

      const user = await client.user.findUniqueOrThrow({ where: { id: record.userId } });

      await recordSecurityEvent(client, {
        action: SecurityAction.EmailChanged,
        targetType: 'User',
        targetId: user.id,
        actorId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      return { user: toPublicUser(user) };
    },

    async deactivateAccount(
      input: { userId: string; currentPassword: string },
      ctx: RequestContext,
    ): Promise<void> {
      const user = await client.user.findUnique({ where: { id: input.userId } });

      if (!user) {
        throw new AppError(404, 'USER_NOT_FOUND', 'The requested account was not found');
      }

      await requirePassword(user, input.currentPassword);

      const deactivatedAt = new Date();

      await client.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { status: 'DEACTIVATED' },
        });

        await tx.session.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: deactivatedAt, revokedReason: 'ACCOUNT_DEACTIVATED' },
        });

        await tx.authToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: deactivatedAt },
        });
      });

      await recordSecurityEvent(client, {
        action: SecurityAction.AccountDeactivated,
        targetType: 'User',
        targetId: user.id,
        actorId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    },

    async reactivateAccount(input: LoginInput, ctx: RequestContext): Promise<{ user: PublicUser }> {
      const user = await findUserByEmail(input.email);

      async function recordReactivationFailure(userId: string, reason: string): Promise<void> {
        await recordSecurityEvent(client, {
          action: SecurityAction.AccountReactivationFailed,
          targetType: 'User',
          targetId: userId,
          actorId: userId,
          metadata: { reason },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }

      if (!user || user.deletedAt) {
        await verifyPassword(input.password, TIMING_EQUALIZER_HASH);

        await recordSecurityEvent(client, {
          action: SecurityAction.AccountReactivationFailed,
          targetType: 'User',
          targetId: user?.id ?? 'unknown',
          ...(user ? { actorId: user.id } : {}),
          metadata: { emailHash: hashSecret(input.email), reason: 'INVALID_CREDENTIALS' },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        throw new AppError(
          401,
          'INVALID_CREDENTIALS',
          'The email address or password is incorrect',
        );
      }

      const matches = await verifyPassword(input.password, user.passwordHash);

      if (!matches) {
        await recordSecurityEvent(client, {
          action: SecurityAction.AccountReactivationFailed,
          targetType: 'User',
          targetId: user.id,
          actorId: user.id,
          metadata: { reason: 'INVALID_CREDENTIALS' },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        throw new AppError(
          401,
          'INVALID_CREDENTIALS',
          'The email address or password is incorrect',
        );
      }

      if (user.status === 'SUSPENDED') {
        await recordReactivationFailure(user.id, 'ACCOUNT_SUSPENDED');
        throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended');
      }

      if (user.status === 'ACTIVE') {
        await recordReactivationFailure(user.id, 'ACCOUNT_ALREADY_ACTIVE');
        throw new AppError(409, 'ACCOUNT_ALREADY_ACTIVE', 'This account is already active');
      }

      if (user.status !== 'DEACTIVATED') {
        await recordReactivationFailure(user.id, 'ACCOUNT_NOT_DEACTIVATED');
        throw new AppError(409, 'ACCOUNT_NOT_DEACTIVATED', 'This account is not deactivated');
      }

      const nextStatus = user.emailVerifiedAt ? 'ACTIVE' : 'PENDING_VERIFICATION';

      const reactivated = await client.$transaction(async (tx) => {
        const updated = await tx.user.updateMany({
          where: { id: user.id, status: 'DEACTIVATED', deletedAt: null },
          data: { status: nextStatus },
        });

        if (updated.count === 0) {
          await recordReactivationFailure(user.id, 'ACCOUNT_NOT_REACTIVATABLE');
          throw new AppError(
            409,
            'ACCOUNT_NOT_REACTIVATABLE',
            'This account can no longer be reactivated',
          );
        }

        await tx.session.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'ACCOUNT_REACTIVATED' },
        });

        await tx.authToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        });

        return tx.user.findUniqueOrThrow({ where: { id: user.id } });
      });

      if (reactivated.status === 'PENDING_VERIFICATION') {
        await issueAndSend(
          {
            user: reactivated,
            purpose: 'EMAIL_VERIFICATION',
            ttlSeconds: config.verificationTokenTtlSeconds,
          },
          (token, expiresAt, tokenId) =>
            buildVerificationEmail({
              to: reactivated.email,
              name: reactivated.name,
              brand,
              verificationUrl: buildLink(config.authVerificationLinkPath, token),
              expiresAt,
              idempotencyKey: `auth:email_verification:${tokenId}`,
            }),
        );
      }

      await recordSecurityEvent(client, {
        action: SecurityAction.AccountReactivated,
        targetType: 'User',
        targetId: reactivated.id,
        actorId: reactivated.id,
        metadata: {
          status: reactivated.status,
          verificationRequired: reactivated.status === 'PENDING_VERIFICATION',
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      return { user: toPublicUser(reactivated) };
    },

    async deleteAccount(
      input: AccountDeleteInput & { userId: string },
      ctx: RequestContext,
    ): Promise<void> {
      const user = await client.user.findUnique({ where: { id: input.userId } });

      if (!user) {
        throw new AppError(404, 'USER_NOT_FOUND', 'The requested account was not found');
      }

      await requirePassword(user, input.currentPassword);

      if (input.confirmation.toLowerCase() !== user.email.toLowerCase()) {
        throw new AppError(
          400,
          'CONFIRMATION_MISMATCH',
          'Type your email address exactly to confirm the deletion',
        );
      }

      const ownedWorkspaces = await client.workspace.count({
        where: {
          ownerId: user.id,
          deletedAt: null,
          status: 'ACTIVE',
        },
      });

      if (ownedWorkspaces > 0) {
        throw new AppError(
          409,
          'WORKSPACE_OWNERSHIP_TRANSFER_REQUIRED',
          'Transfer ownership of your workspaces before deleting your account',
        );
      }

      await revokeAllSessions(client, {
        userId: user.id,
        reason: 'ACCOUNT_DELETED',
      });

      await client.$transaction(async (tx) => {
        await tx.authToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        });

        await tx.userProfile.updateMany({
          where: { userId: user.id },
          data: { bio: null, jobTitle: null, avatarUrl: null },
        });

        await tx.user.update({
          where: { id: user.id },
          data: {
            // The address is released so the person can register again.
            email: `deleted+${user.id}@nexus.invalid`,
            name: 'Deleted user',
            // The password can never be matched again.
            passwordHash: TIMING_EQUALIZER_HASH,
            status: 'DEACTIVATED',
            deletedAt: new Date(),
          },
        });
      });

      await recordSecurityEvent(client, {
        action: SecurityAction.AccountDeleted,
        targetType: 'User',
        targetId: user.id,
        actorId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      //       console.log('register: hashing');
      // // ...
      // console.log('register: creating user');
      // // ...
      // console.log('register: queueing email');
    },
  };
}

export type { AuthenticationResult };
