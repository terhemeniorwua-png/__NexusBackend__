import { createLoggingEmailSender } from './logging-email-sender';
import type { EmailDeliveryResult, EmailMessage, EmailSender } from './types';

export * from './types';
export { createLoggingEmailSender } from './logging-email-sender';

let sender: EmailSender = createLoggingEmailSender();

/**
 * Installs the email sender used by the application.
 *
 * Phase 4 replaces the default logging sender with the transactional provider
 * adapter. Tests install a capturing sender to assert on message content.
 */
export function setEmailSender(next: EmailSender): void {
  sender = next;
}

export function getEmailSender(): EmailSender {
  return sender;
}

export function resetEmailSender(): void {
  sender = createLoggingEmailSender();
}

/**
 * Sends an email without letting a delivery failure break the surrounding
 * business transaction.
 *
 * The email seam is intentionally non-fatal: a failed verification email must
 * not roll back a successful registration, and the user can always request a
 * new link. The result is reported so the caller can surface a retry hint.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailDeliveryResult> {
  try {
    return await sender.send(message);
  } catch (error) {
    return {
      accepted: false,
      error: error instanceof Error ? error.message : 'Unknown email delivery failure',
    };
  }
}
