import type { AuthTokenPurpose, PrismaClient, User } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import {
  buildEmailBrand,
  buildAccountDeletionScheduledEmail,
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
import { deriveKey, generateSecureToken, hashSecret, signValue } from '../../utils/crypto';
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
import { scheduledAccountDeletionAt } from './account-deletion.service';
import { ensurePersonalWorkspace } from '../workspaces/personal-workspace.service';
import { enqueueWorkspaceSeatReduction } from '../billing/membership-billing';
import type {
  AuthenticationResult,
  PublicUser,
  RequestContext,
  SessionSummary,
} from './auth.types';
import { createTwoFactorService, type TwoFactorService } from './two-factor.service';
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
  login(
    input: LoginInput,
    ctx: RequestContext,
  ): Promise<
    AuthenticationResult | { twoFactorRequired: true; challengeToken: string; expiresIn: number }
  >;
  ensureGoogleAccount(input: {
    subject: string;
    email: string;
    name: string;
  }): Promise<{ id: string }>;
  loginGoogleAccount(
    userId: string,
    ctx: RequestContext,
  ): Promise<
    AuthenticationResult | { twoFactorRequired: true; challengeToken: string; expiresIn: number }
  >;
  twoFactor: TwoFactorService;
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
  deleteAccount(
    input: AccountDeleteInput & { userId: string },
    ctx: RequestContext,
  ): Promise<{ scheduledDeletionAt: Date }>;
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

  async function finishTwoFactorLogin(
    user: User,
    ctx: RequestContext,
  ): Promise<AuthenticationResult> {
    const { session, refreshToken } = await createSession(client, {
      userId: user.id,
      ttlSeconds: config.refreshTokenTtlSeconds,
      userAgent: ctx.userAgent,
      ip: ctx.ip,
    });
    await client.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await recordSecurityEvent(client, {
      action: SecurityAction.LoginSucceeded,
      targetType: 'Session',
      targetId: session.id,
      actorId: user.id,
      metadata: { userId: user.id, status: user.status, twoFactor: true },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return authenticateSession(session, user, refreshToken);
  }

  const twoFactor = createTwoFactorService(config, client, finishTwoFactorLogin);

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

    if (user.status === 'PENDING_DELETION') {
      throw new AppError(
        403,
        'ACCOUNT_PENDING_DELETION',
        'This account is being deleted and can no longer sign in.',
      );
    }
  }

  async function requirePassword(user: User, password: string): Promise<void> {
    const matches = await verifyPassword(password, user.passwordHash);

    if (!matches) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'The email address or password is incorrect');
    }
  }

  return {
    twoFactor,
    async ensureGoogleAccount(input): Promise<{ id: string }> {
      const identity = await client.externalIdentity.findUnique({
        where: {
          provider_providerSubjectId: { provider: 'google', providerSubjectId: input.subject },
        },
        include: { user: true },
      });
      if (identity) {
        assertUsableAccount(identity.user);
        return { id: identity.user.id };
      }

      const email = input.email.trim().toLowerCase();
      const existing = await findUserByEmail(email);
      if (existing) {
        throw new AppError(
          409,
          'GOOGLE_ACCOUNT_LINK_REQUIRED',
          'This email already has a Nexus account. Sign in and link Google from account settings.',
        );
      }

      const passwordHash = await hashPassword(generateSecureToken(), config.bcryptSaltRounds);
      try {
        const user = await client.$transaction(async (tx) => {
          const created = await tx.user.create({
            data: {
              email,
              name: input.name.trim().slice(0, 100) || email,
              passwordHash,
              status: 'ACTIVE',
              emailVerifiedAt: new Date(),
              externalIdentities: {
                create: { provider: 'google', providerSubjectId: input.subject },
              },
            },
          });
          await ensurePersonalWorkspace(tx, created);
          return created;
        });
        return { id: user.id };
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'P2002'
        ) {
          const raced = await client.externalIdentity.findUnique({
            where: {
              provider_providerSubjectId: { provider: 'google', providerSubjectId: input.subject },
            },
            select: { userId: true },
          });
          if (raced) return { id: raced.userId };
          const emailOwner = await findUserByEmail(email);
          if (emailOwner) {
            throw new AppError(
              409,
              'GOOGLE_ACCOUNT_LINK_REQUIRED',
              'Sign in and link Google from account settings',
            );
          }
        }
        throw error;
      }
    },
    async loginGoogleAccount(userId, ctx) {
      const user = await client.user.findUnique({ where: { id: userId } });
      if (!user)
        throw new AppError(
          401,
          'GOOGLE_IDENTITY_INVALID',
          'Google identity is no longer available',
        );
      assertUsableAccount(user);
      if (user.twoFactorEnabled) return twoFactor.issueChallenge(user);

      const { session, refreshToken } = await createSession(client, {
        userId: user.id,
        ttlSeconds: config.refreshTokenTtlSeconds,
        userAgent: ctx.userAgent,
        ip: ctx.ip,
      });
      await client.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await recordSecurityEvent(client, {
        action: SecurityAction.LoginSucceeded,
        targetType: 'Session',
        targetId: session.id,
        actorId: user.id,
        metadata: { userId: user.id, status: user.status, provider: 'google' },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return authenticateSession(session, user, refreshToken);
    },
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
      const user = await client.$transaction(async (tx) => {
        const record = await consumeAuthToken(tx, {
          token: input.token,
          purpose: 'EMAIL_VERIFICATION',
        });

        const verified = await tx.user.updateMany({
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
          const current = await tx.user.findUnique({ where: { id: record.userId } });

          if (!current || current.deletedAt) {
            throw new AppError(
              400,
              'TOKEN_INVALID',
              'This link is invalid or has already been used',
            );
          }

          if (current.status === 'SUSPENDED') {
            throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended');
          }

          if (current.status === 'DEACTIVATED' || current.status === 'PENDING_DELETION') {
            throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account is not active');
          }

          throw new AppError(409, 'ACCOUNT_NOT_VERIFIABLE', 'This account cannot be verified');
        }

        const verifiedUser = await tx.user.findUniqueOrThrow({ where: { id: record.userId } });
        await ensurePersonalWorkspace(tx, verifiedUser);

        return verifiedUser;
      });

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

    async login(
      input: LoginInput,
      ctx: RequestContext,
    ): Promise<
      AuthenticationResult | { twoFactorRequired: true; challengeToken: string; expiresIn: number }
    > {
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

      if (user.twoFactorEnabled) {
        return twoFactor.issueChallenge(user);
      }

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
        await twoFactor.revokeChallenges(outcome.session.userId);

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
      await twoFactor.revokeChallenges(input.userId);
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
      if (
        !user ||
        user.deletedAt ||
        user.status === 'DEACTIVATED' ||
        user.status === 'PENDING_DELETION'
      ) {
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

      const account = await client.user.findUnique({ where: { id: record.userId } });

      if (!account || account.deletedAt) {
        throw new AppError(400, 'TOKEN_INVALID', 'This link is invalid or has already been used');
      }

      if (account.status === 'PENDING_DELETION') {
        throw new AppError(
          403,
          'ACCOUNT_PENDING_DELETION',
          'Recover the account before changing its password',
        );
      }

      if (account.status === 'DEACTIVATED') {
        throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account has been deactivated');
      }

      assertPasswordLength(input.password);

      await twoFactor.revokeChallenges(record.userId);

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

      await twoFactor.revokeChallenges(user.id);

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

      await twoFactor.revokeChallenges(user.id);

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

      if (current.status === 'DEACTIVATED' || current.status === 'PENDING_DELETION') {
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

        if (latest.status === 'DEACTIVATED' || latest.status === 'PENDING_DELETION') {
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

      await twoFactor.revokeChallenges(user.id);

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

      if (
        user.status === 'PENDING_DELETION' &&
        (!user.scheduledDeletionAt || user.scheduledDeletionAt <= new Date())
      ) {
        await recordReactivationFailure(user.id, 'DELETION_RECOVERY_PERIOD_EXPIRED');
        throw new AppError(
          409,
          'DELETION_RECOVERY_PERIOD_EXPIRED',
          'The account recovery period has expired',
        );
      }

      if (user.status === 'ACTIVE') {
        await recordReactivationFailure(user.id, 'ACCOUNT_ALREADY_ACTIVE');
        throw new AppError(409, 'ACCOUNT_ALREADY_ACTIVE', 'This account is already active');
      }

      if (user.status !== 'DEACTIVATED' && user.status !== 'PENDING_DELETION') {
        await recordReactivationFailure(user.id, 'ACCOUNT_NOT_DEACTIVATED');
        throw new AppError(409, 'ACCOUNT_NOT_DEACTIVATED', 'This account is not deactivated');
      }

      const nextStatus = user.emailVerifiedAt ? 'ACTIVE' : 'PENDING_VERIFICATION';

      const reactivated = await client.$transaction(async (tx) => {
        const updated = await tx.user.updateMany({
          where: {
            id: user.id,
            status: user.status,
            deletedAt: null,
            ...(user.status === 'PENDING_DELETION'
              ? { scheduledDeletionAt: { gt: new Date() } }
              : {}),
          },
          data: {
            status: nextStatus,
            deletionRequestedAt: null,
            scheduledDeletionAt: null,
          },
        });

        if (updated.count === 0) {
          return null;
        }

        await tx.session.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'ACCOUNT_REACTIVATED' },
        });

        await tx.authToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() },
        });

        const restored = await tx.user.findUniqueOrThrow({ where: { id: user.id } });

        if (restored.status === 'ACTIVE') {
          await ensurePersonalWorkspace(tx, restored);
          if (user.status === 'PENDING_DELETION') {
            await tx.workspace.updateMany({
              where: { ownerId: restored.id, deletionSuspendedAt: { not: null }, deletedAt: null },
              data: { status: 'ACTIVE', deletionSuspendedAt: null },
            });
            await tx.billingCancellation.updateMany({
              where: {
                workspace: { ownerId: restored.id },
                status: { in: ['PENDING', 'PROCESSING'] },
              },
              data: { status: 'CANCELLED', lastError: null },
            });
          }
          const memberships = await tx.workspaceMembership.findMany({
            where: { userId: restored.id, status: 'ACTIVE' },
            select: { workspaceId: true },
          });
          for (const workspaceId of new Set(memberships.map(({ workspaceId }) => workspaceId))) {
            await enqueueWorkspaceSeatReduction(tx, workspaceId);
          }
        }

        return restored;
      });

      if (!reactivated) {
        await recordReactivationFailure(user.id, 'ACCOUNT_NOT_REACTIVATABLE');
        throw new AppError(
          409,
          'ACCOUNT_NOT_REACTIVATABLE',
          'This account can no longer be reactivated',
        );
      }

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
      _ctx: RequestContext,
    ): Promise<{ scheduledDeletionAt: Date }> {
      const user = await client.user.findUnique({ where: { id: input.userId } });

      if (!user) {
        throw new AppError(404, 'USER_NOT_FOUND', 'The requested account was not found');
      }

      await requirePassword(user, input.currentPassword);

      await twoFactor.revokeChallenges(user.id);

      if (input.confirmation.toLowerCase() !== user.email.toLowerCase()) {
        throw new AppError(
          400,
          'CONFIRMATION_MISMATCH',
          'Type your email address exactly to confirm the deletion',
        );
      }

      const requestedAt = new Date();
      const scheduledDeletionAt = scheduledAccountDeletionAt(requestedAt);

      await client.$transaction(async (tx) => {
        const [lockedUser] = await tx.$queryRaw<
          Array<{ status: string; deletedAt: Date | null }>
        >`SELECT "status"::text AS "status", "deletedAt"
          FROM "User"
          WHERE "id" = ${user.id}
          FOR UPDATE`;

        if (!lockedUser) {
          throw new AppError(404, 'USER_NOT_FOUND', 'The requested account was not found');
        }

        if (lockedUser.deletedAt || lockedUser.status === 'DEACTIVATED') {
          throw new AppError(
            409,
            'ACCOUNT_ALREADY_DELETED',
            'This account has already been deleted or deactivated',
          );
        }

        if (lockedUser.status === 'PENDING_DELETION') {
          throw new AppError(
            409,
            'ACCOUNT_DELETION_ALREADY_REQUESTED',
            'This account is already scheduled for deletion',
          );
        }

        if (lockedUser.status === 'SUSPENDED') {
          throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended');
        }

        const administrativeRoles = [
          'COMPANY_OWNER',
          'COMPANY_ADMIN',
          'INSTITUTION_OWNER',
          'INSTITUTION_ADMIN',
        ] as const;
        const administrativeMemberships = await tx.workspaceMembership.findMany({
          where: {
            userId: user.id,
            status: 'ACTIVE',
            workspace: {
              type: { in: ['COMPANY', 'INSTITUTION'] },
              status: 'ACTIVE',
            },
          },
          select: {
            workspaceId: true,
            role: true,
            organizationRole: true,
            workspace: { select: { ownerId: true } },
          },
        });
        for (const membership of administrativeMemberships) {
          const isAdministrator =
            membership.role === 'PROJECT_MANAGER' ||
            membership.role === 'OWNER' ||
            administrativeRoles.includes(
              membership.organizationRole as (typeof administrativeRoles)[number],
            );
          // An owner may schedule deletion; the owned workspace is suspended
          // until a successor accepts the transfer. A non-owner administrator
          // cannot leave an active organization without another active owner
          // or administrator who can manage that suspended workspace.
          if (!isAdministrator || membership.workspace.ownerId === user.id) continue;

          const activeSuccessors = await tx.workspaceMembership.count({
            where: {
              workspaceId: membership.workspaceId,
              userId: { not: user.id },
              status: 'ACTIVE',
              user: { status: 'ACTIVE', deletedAt: null },
              OR: [
                { role: { in: ['OWNER', 'PROJECT_MANAGER'] } },
                { organizationRole: { in: [...administrativeRoles] } },
              ],
            },
          });
          if (activeSuccessors === 0) {
            throw new AppError(
              409,
              'LAST_ORGANIZATION_ADMIN',
              'Another active owner or administrator must remain in the organization',
            );
          }
        }

        await tx.session.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: requestedAt, revokedReason: 'ACCOUNT_PENDING_DELETION' },
        });
        await tx.authToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: requestedAt },
        });
        await tx.user.update({
          where: { id: user.id },
          data: {
            status: 'PENDING_DELETION',
            deletionRequestedAt: requestedAt,
            scheduledDeletionAt,
          },
        });

        const ownedWorkspaces = await tx.workspace.findMany({
          where: { ownerId: user.id, deletedAt: null, status: 'ACTIVE' },
          select: { id: true, subscription: { select: { id: true, status: true } } },
        });
        await tx.workspace.updateMany({
          where: { ownerId: user.id, deletedAt: null, status: 'ACTIVE' },
          data: { status: 'SUSPENDED', deletionSuspendedAt: requestedAt },
        });
        await tx.workspaceOwnershipTransfer.updateMany({
          where: { initiatedById: user.id, status: 'PENDING' },
          data: { expiresAt: scheduledDeletionAt },
        });
        for (const workspace of ownedWorkspaces) {
          if (!workspace.subscription || workspace.subscription.status === 'CANCELLED') continue;
          await tx.billingCancellation.upsert({
            where: { workspaceId: workspace.id },
            create: {
              workspaceId: workspace.id,
              status: 'PENDING',
              nextAttemptAt: scheduledDeletionAt,
            },
            update: {
              status: 'PENDING',
              attempts: 0,
              nextAttemptAt: scheduledDeletionAt,
              lastError: null,
            },
          });
        }
      });

      await recordSecurityEvent(client, {
        action: SecurityAction.AccountDeletionRequested,
        targetType: 'User',
        targetId: user.id,
        actorId: user.id,
        metadata: { scheduledDeletionAt: scheduledDeletionAt.toISOString() },
      });
      await sendEmail(
        buildAccountDeletionScheduledEmail({
          to: user.email,
          name: user.name,
          brand,
          scheduledDeletionAt,
          idempotencyKey: `auth:deletion_requested:${user.id}:${requestedAt.getTime()}`,
        }),
      );

      return { scheduledDeletionAt };
    },
  };
}

export type { AuthenticationResult };
