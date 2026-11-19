import type { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '../../utils/logger';

/**
 * Security event recording.
 *
 * Account-level security events are written to the same `AuditLog` table that
 * later phases use for workspace audit trails. `workspaceId` is nullable so an
 * event can be recorded before the user belongs to any workspace.
 *
 * Events never contain passwords, raw tokens or verification links.
 */

export const SecurityAction = {
  AccountRegistered: 'auth.account_registered',
  EmailVerificationRequested: 'auth.email_verification_requested',
  EmailVerified: 'auth.email_verified',
  LoginSucceeded: 'auth.login_succeeded',
  LoginFailed: 'auth.login_failed',
  LoginBlocked: 'auth.login_blocked',
  SessionRefreshed: 'auth.session_refreshed',
  SessionReuseDetected: 'auth.session_reuse_detected',
  LoggedOut: 'auth.logged_out',
  LoggedOutAll: 'auth.logged_out_all',
  PasswordResetRequested: 'auth.password_reset_requested',
  PasswordReset: 'auth.password_reset',
  PasswordChanged: 'auth.password_changed',
  EmailChangeRequested: 'auth.email_change_requested',
  EmailChanged: 'auth.email_changed',
  AccountDeactivated: 'auth.account_deactivated',
  AccountReactivated: 'auth.account_reactivated',
  AccountReactivationFailed: 'auth.account_reactivation_failed',
  AccountDeletionRequested: 'auth.account_deletion_requested',
  AccountDeletionCancelled: 'auth.account_deletion_cancelled',
  AccountDeleted: 'auth.account_deleted',
  TwoFactorEnabled: 'auth.two_factor_enabled',
  TwoFactorDisabled: 'auth.two_factor_disabled',
  TwoFactorFailed: 'auth.two_factor_failed',
  TwoFactorRecoveryCodesRegenerated: 'auth.two_factor_recovery_codes_regenerated',
  TwoFactorChallengeIssued: 'auth.two_factor_challenge_issued',
  ProfileAvatarUploaded: 'auth.profile_avatar_uploaded',
  ProfileAvatarDeleted: 'auth.profile_avatar_deleted',
  AiAccessEnabled: 'auth.ai_access_enabled',
  AiAccessDisabled: 'auth.ai_access_disabled',
} as const;

export type SecurityActionValue = (typeof SecurityAction)[keyof typeof SecurityAction];

export interface SecurityEvent {
  action: SecurityActionValue;
  targetType: 'User' | 'Session';
  targetId: string;
  actorId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Writes a security event to the audit log.
 *
 * Audit failures must never break the request that triggered them, so errors
 * are logged and swallowed. PostgreSQL remains the audit source of truth;
 * Redis is never used for this.
 */
export async function recordSecurityEvent(
  prisma: PrismaClient,
  event: SecurityEvent,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        workspaceId: null,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        ...(event.actorId ? { actorId: event.actorId } : {}),
        ...(event.metadata ? { metadata: event.metadata as Prisma.InputJsonValue } : {}),
        ...(event.ip ? { ip: event.ip.slice(0, 128) } : {}),
        ...(event.userAgent ? { userAgent: event.userAgent.slice(0, 512) } : {}),
      },
    });
  } catch (error) {
    logger.error('security_event_write_failed', {
      error,
      action: event.action,
      targetType: event.targetType,
    });
  }
}
