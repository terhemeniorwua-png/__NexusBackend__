/**
 * Email delivery seam.
 *
 * The application decides *what* to send and builds a message. The delivery
 * service decides *how* and *when* to send it: it stores the message in the
 * outbox, hands it to the provider adapter and retries transient failures.
 *
 * Message bodies, single use links, verification tokens and recipient email
 * addresses are never written to the log. Only non-recipient delivery
 * metadata is recorded.
 */

export type EmailTemplate =
  | 'account_verification'
  | 'password_reset'
  | 'password_changed'
  | 'email_change_verification'
  | 'account_deletion_scheduled'
  | 'security_notification'
  | 'workspace_invitation'
  | 'team_invitation'
  | 'project_invitation'
  | 'task_assignment'
  | 'task_submitted'
  | 'mention'
  | 'meeting_invitation'
  | 'join_request_approved'
  | 'join_request_rejected'
  | 'billing_receipt'
  | 'billing_payment_failed'
  | 'billing_subscription_cancelled'
  | 'billing_subscription_not_renewing';

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
