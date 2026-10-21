/**
 * Email provider adapter contract.
 *
 * The application never talks to a provider SDK directly. It builds an
 * `EmailTransportRequest` and hands it to the installed transport, which
 * turns it into a provider specific call.
 *
 * A transport must never throw for an expected delivery failure. It returns a
 * result that says whether the failure is worth retrying, so the delivery
 * worker can decide between a backoff and a permanent failure.
 */

export interface EmailTransportRequest {
  /** Internal delivery id. Sent as a header so provider webhooks can be correlated. */
  deliveryId: string;
  to: string;
  from: string;
  replyTo?: string | undefined;
  subject: string;
  text: string;
  html?: string | undefined;
  headers?: Record<string, string> | undefined;
}

export interface EmailTransportResult {
  /** True when the provider accepted the message for delivery. */
  accepted: boolean;
  /** Provider assigned message id, used to correlate webhooks. */
  providerMessageId?: string | undefined;
  /** Short, stable error code, safe to store. */
  errorCode?: string | undefined;
  /** Human readable error, safe to store. Never contains a message body. */
  error?: string | undefined;
  /** True when the failure is transient and the delivery should be retried. */
  retryable: boolean;
}

export interface EmailTransport {
  /** Stable provider name recorded on every delivery. */
  readonly provider: string;
  send(request: EmailTransportRequest): Promise<EmailTransportResult>;
  /** Checks that the provider is reachable and the credentials work. */
  verify(): Promise<void>;
  /** Releases provider resources. */
  close(): Promise<void>;
}
