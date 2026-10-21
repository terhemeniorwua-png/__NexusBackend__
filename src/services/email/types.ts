/**
 * Email delivery seam.
 *
 * Phase 3 owns the *decision* of which email to send and the secure token
 * lifecycle around it. Phase 4 owns the transactional provider adapter, which
 * will implement the `EmailSender` interface defined here and be installed
 * with `setEmailSender()`.
 *
 * Until Phase 4 lands, the default sender only records delivery metadata.
 * It never logs message bodies, links or tokens.
 */

export type EmailTemplate =
  'account_verification' | 'password_reset' | 'email_change_verification' | 'security_notification';

export interface EmailMessage {
  to: string;
  subject: string;
  template: EmailTemplate;
  text: string;
  html?: string;
  metadata?: Record<string, unknown>;
}

export interface EmailDeliveryResult {
  accepted: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}
