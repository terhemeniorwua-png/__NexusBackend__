import type { EmailMessage } from '../../services/email';

/**
 * Transactional email content for the account lifecycle.
 *
 * Phase 4 replaces these plain templates with the branded HTML layout. They
 * are intentionally simple and safe: every interpolated value is escaped, and
 * the single-use link is only ever present in the message body.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(options: {
  heading: string;
  body: string;
  action?: { label: string; url: string };
}): string {
  const action = options.action
    ? `<p><a href="${escapeHtml(options.action.url)}" style="display:inline-block;padding:12px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(options.action.label)}</a></p>
       <p style="font-size:12px;color:#6b7280;word-break:break-all;">If the button does not work, copy this link into your browser:<br />${escapeHtml(options.action.url)}</p>`
    : '';

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f3f4f6;font-family:Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;padding:32px;">
      <h1 style="margin:0 0 16px;font-size:20px;">${escapeHtml(options.heading)}</h1>
      ${options.body}
      ${action}
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
      <p style="font-size:12px;color:#6b7280;margin:0;">This is an automated message from Nexus. If you did not expect it, you can safely ignore this email.</p>
    </div>
  </body>
</html>`;
}

export function buildVerificationEmail(input: {
  to: string;
  name: string;
  verificationUrl: string;
  expiresAt: Date;
}): EmailMessage {
  const expiryMinutes = Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 60_000));
  const greeting = escapeHtml(input.name);

  return {
    to: input.to,
    subject: 'Verify your Nexus account',
    template: 'account_verification',
    text: [
      `Hi ${input.name},`,
      '',
      'Confirm your email address to activate your Nexus account.',
      '',
      `Verify your email: ${input.verificationUrl}`,
      '',
      `This link expires in ${expiryMinutes} minutes and can only be used once.`,
      '',
      'If you did not create a Nexus account, you can ignore this email.',
    ].join('\n'),
    html: layout({
      heading: 'Verify your email address',
      body: `<p style="font-size:15px;line-height:1.6;">Hi ${greeting},</p>
             <p style="font-size:15px;line-height:1.6;">Confirm your email address to activate your Nexus account. This link expires in ${expiryMinutes} minutes and can only be used once.</p>`,
      action: { label: 'Verify email address', url: input.verificationUrl },
    }),
    metadata: { expiresAt: input.expiresAt.toISOString() },
  };
}

export function buildPasswordResetEmail(input: {
  to: string;
  name: string;
  resetUrl: string;
  expiresAt: Date;
}): EmailMessage {
  const expiryMinutes = Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 60_000));
  const greeting = escapeHtml(input.name);

  return {
    to: input.to,
    subject: 'Reset your Nexus password',
    template: 'password_reset',
    text: [
      `Hi ${input.name},`,
      '',
      'We received a request to reset your Nexus password.',
      '',
      `Reset your password: ${input.resetUrl}`,
      '',
      `This link expires in ${expiryMinutes} minutes and can only be used once.`,
      '',
      'If you did not request a password reset, no action is needed and your password will stay unchanged.',
    ].join('\n'),
    html: layout({
      heading: 'Reset your password',
      body: `<p style="font-size:15px;line-height:1.6;">Hi ${greeting},</p>
             <p style="font-size:15px;line-height:1.6;">We received a request to reset your Nexus password. This link expires in ${expiryMinutes} minutes and can only be used once.</p>
             <p style="font-size:15px;line-height:1.6;">If you did not request this, no action is needed and your password will stay unchanged.</p>`,
      action: { label: 'Reset password', url: input.resetUrl },
    }),
    metadata: { expiresAt: input.expiresAt.toISOString() },
  };
}

export function buildEmailChangeEmail(input: {
  to: string;
  name: string;
  verificationUrl: string;
  expiresAt: Date;
}): EmailMessage {
  const expiryMinutes = Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 60_000));
  const greeting = escapeHtml(input.name);

  return {
    to: input.to,
    subject: 'Confirm your new Nexus email address',
    template: 'email_change_verification',
    text: [
      `Hi ${input.name},`,
      '',
      'Confirm this address to finish changing the email address on your Nexus account.',
      '',
      `Confirm your new email address: ${input.verificationUrl}`,
      '',
      `This link expires in ${expiryMinutes} minutes and can only be used once.`,
      '',
      'If you did not request this change, ignore this email and your current address will stay active.',
    ].join('\n'),
    html: layout({
      heading: 'Confirm your new email address',
      body: `<p style="font-size:15px;line-height:1.6;">Hi ${greeting},</p>
             <p style="font-size:15px;line-height:1.6;">Confirm this address to finish changing the email address on your Nexus account. This link expires in ${expiryMinutes} minutes and can only be used once.</p>
             <p style="font-size:15px;line-height:1.6;">If you did not request this change, ignore this email and your current address will stay active.</p>`,
      action: { label: 'Confirm new email address', url: input.verificationUrl },
    }),
    metadata: { expiresAt: input.expiresAt.toISOString() },
  };
}

export function buildSecurityNotificationEmail(input: {
  to: string;
  name: string;
  subject: string;
  detail: string;
}): EmailMessage {
  const greeting = escapeHtml(input.name);
  const detail = escapeHtml(input.detail);

  return {
    to: input.to,
    subject: input.subject,
    template: 'security_notification',
    text: [
      `Hi ${input.name},`,
      '',
      input.detail,
      '',
      'If this was not you, contact your workspace administrator immediately.',
    ].join('\n'),
    html: layout({
      heading: input.subject,
      body: `<p style="font-size:15px;line-height:1.6;">Hi ${greeting},</p>
             <p style="font-size:15px;line-height:1.6;">${detail}</p>
             <p style="font-size:15px;line-height:1.6;">If this was not you, contact your workspace administrator immediately.</p>`,
    }),
  };
}
