import type { EmailMessage } from '../types';
import { renderEmailDocument, type EmailBrand } from './layout';

/**
 * Account lifecycle templates.
 *
 * These cover the events that only touch a single user: verifying an address,
 * resetting a password, confirming a password change, confirming an email
 * change and reporting a security relevant action.
 *
 * A single use link is only ever placed in the message body. It is never part
 * of a subject line, a header or a log line.
 */

export interface AccountEmailInput {
  to: string;
  name: string;
  brand: EmailBrand;
  /**
   * Stable key that makes the send idempotent. Two requests that carry the
   * same key enqueue one email.
   */
  idempotencyKey?: string | undefined;
}

export interface VerificationEmailInput extends AccountEmailInput {
  verificationUrl: string;
  expiresAt: Date;
}

export interface PasswordResetEmailInput extends AccountEmailInput {
  resetUrl: string;
  expiresAt: Date;
}

export interface PasswordChangedEmailInput extends AccountEmailInput {
  changedAt: Date;
  resetUrl: string;
}

export interface EmailChangeEmailInput extends AccountEmailInput {
  verificationUrl: string;
  expiresAt: Date;
  newEmail: string;
}

export interface AccountDeletionScheduledEmailInput extends AccountEmailInput {
  scheduledDeletionAt: Date;
}

export interface SecurityNotificationEmailInput extends AccountEmailInput {
  subject: string;
  detail: string;
  actionUrl?: string | undefined;
  actionLabel?: string | undefined;
}

function expiryMinutes(expiresAt: Date): number {
  return Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000));
}

export function buildVerificationEmail(input: VerificationEmailInput): EmailMessage {
  const minutes = expiryMinutes(input.expiresAt);
  const { html, text } = renderEmailDocument(
    {
      heading: 'Verify your email address',
      preheader: `Confirm your email address to activate your ${input.brand.appName} account.`,
      paragraphs: [
        `Hi ${input.name},`,
        `Confirm your email address to activate your ${input.brand.appName} account. This link expires in ${minutes} minutes and can only be used once.`,
      ],
      action: { label: 'Verify email address', url: input.verificationUrl },
      note: 'If you did not create an account, you can safely ignore this email.',
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `Verify your ${input.brand.appName} email address`,
    template: 'account_verification',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { expiresAt: input.expiresAt.toISOString() },
  };
}

export function buildPasswordResetEmail(input: PasswordResetEmailInput): EmailMessage {
  const minutes = expiryMinutes(input.expiresAt);
  const { html, text } = renderEmailDocument(
    {
      heading: 'Reset your password',
      preheader: 'A password reset was requested for your account.',
      paragraphs: [
        `Hi ${input.name},`,
        'We received a request to reset the password on your account. This link expires in ' +
          `${minutes} minutes and can only be used once.`,
        'If you did not request a password reset, no action is needed and your password will stay unchanged.',
      ],
      action: { label: 'Reset password', url: input.resetUrl },
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `Reset your ${input.brand.appName} password`,
    template: 'password_reset',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { expiresAt: input.expiresAt.toISOString() },
  };
}

export function buildPasswordChangedEmail(input: PasswordChangedEmailInput): EmailMessage {
  const { html, text } = renderEmailDocument(
    {
      heading: 'Your password was changed',
      preheader: 'The password on your account was changed.',
      paragraphs: [
        `Hi ${input.name},`,
        `The password on your ${input.brand.appName} account was changed on ${input.changedAt.toUTCString()}.`,
        'If this was not you, reset your password immediately and contact your workspace administrator.',
      ],
      action: { label: 'Reset your password', url: input.resetUrl },
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `Your ${input.brand.appName} password was changed`,
    template: 'password_changed',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { changedAt: input.changedAt.toISOString() },
  };
}

export function buildEmailChangeEmail(input: EmailChangeEmailInput): EmailMessage {
  const minutes = expiryMinutes(input.expiresAt);
  const { html, text } = renderEmailDocument(
    {
      heading: 'Confirm your new email address',
      preheader: 'Confirm the new email address for your account.',
      paragraphs: [
        `Hi ${input.name},`,
        `Confirm this address to finish changing the email address on your ${input.brand.appName} account to ${input.newEmail}. This link expires in ${minutes} minutes and can only be used once.`,
        'If you did not request this change, ignore this email and your current address will stay active.',
      ],
      action: { label: 'Confirm new email address', url: input.verificationUrl },
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `Confirm your new ${input.brand.appName} email address`,
    template: 'email_change_verification',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { expiresAt: input.expiresAt.toISOString(), newEmail: input.newEmail },
  };
}

export function buildAccountDeletionScheduledEmail(
  input: AccountDeletionScheduledEmailInput,
): EmailMessage {
  const deletionDate = input.scheduledDeletionAt.toUTCString();
  const { html, text } = renderEmailDocument(
    {
      heading: 'Your account is scheduled for deletion',
      preheader: `Your account is scheduled for permanent deletion on ${deletionDate}.`,
      paragraphs: [
        `Hi ${input.name},`,
        `Your ${input.brand.appName} account is now pending deletion. Your account and personal workspace will remain intact until ${deletionDate}.`,
        'Permanent deletion is scheduled after a 30-day recovery period.',
        'To cancel the deletion, use the account recovery option and sign in with your email address and password before that date. Recovery will not restore sessions that were signed out.',
        'Organization workspaces and shared content are retained. If you did not request this, recover your account immediately.',
      ],
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: `Your ${input.brand.appName} account is scheduled for deletion`,
    template: 'account_deletion_scheduled',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    metadata: { scheduledDeletionAt: input.scheduledDeletionAt.toISOString() },
  };
}

export function buildSecurityNotificationEmail(
  input: SecurityNotificationEmailInput,
): EmailMessage {
  const { html, text } = renderEmailDocument(
    {
      heading: input.subject,
      preheader: input.detail,
      paragraphs: [
        `Hi ${input.name},`,
        input.detail,
        'If this was not you, contact your workspace administrator immediately.',
      ],
      ...(input.actionUrl && input.actionLabel
        ? { action: { label: input.actionLabel, url: input.actionUrl } }
        : {}),
      footerNote: 'This is an automated message. Please do not reply to it.',
    },
    input.brand,
  );

  return {
    to: input.to,
    subject: input.subject,
    template: 'security_notification',
    text,
    html,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  };
}
