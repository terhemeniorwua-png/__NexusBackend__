/**
 * Email delivery seam.
 *
 * The application decides *what* to send and builds a message. The delivery
 * service decides *how* and *when* to send it: it stores the message in the
 * outbox, hands it to the provider adapter and retries transient failures.
 *
 * Message bodies, single use links and verification tokens are never written
 * to the log. Only delivery metadata is recorded.
 */

export type EmailTemplate =
  | 'account_verification'
  | 'password_reset'
  | 'password_changed'
  | 'email_change_verification'
  | 'security_notification'
  | 'workspace_invitation'
  | 'team_invitation'
  | 'project_invitation'
  | 'task_assignment'
  | 'mention'
  | 'meeting_invitation';

export interface EmailMessage {
  to: string;
  subject: string;
  template: EmailTemplate;
  text: string;
  html?: string;
  replyTo?: string;
  /**
   * Stable key that makes the send idempotent.
   *
   * Two requests that carry the same key enqueue one email, so a retry can
   * never deliver the same message twice. When it is missing, a key is
   * derived from the message itself.
   */
  idempotencyKey?: string;
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
