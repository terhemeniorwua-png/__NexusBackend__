import type { AppConfig } from '../../../config/env';
import { normalizeMessageId } from './message-id';
import type { EmailTransport, EmailTransportRequest, EmailTransportResult } from './types';

function parseFrom(from: string): { name?: string; email: string } {
  const match = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!match) return { email: from.trim() };
  const name = match[1]?.replace(/^"|"$/g, '').trim();
  const email = match[2]!.trim();
  return name ? { name, email } : { email };
}

export function createBrevoApiTransport(config: AppConfig): EmailTransport {
  const baseUrl = config.emailApiUrl;
  const authHeaders = { 'api-key': config.emailApiKey, accept: 'application/json' };

  return {
    provider: 'brevo-api',

    async send(request: EmailTransportRequest): Promise<EmailTransportResult> {
      const body = {
        sender: parseFrom(request.from),
        to: [{ email: request.to }],
        ...(request.replyTo ? { replyTo: { email: request.replyTo } } : {}),
        subject: request.subject,
        textContent: request.text,
        ...(request.html ? { htmlContent: request.html } : {}),
        headers: {
          ...(request.headers ?? {}),
          'X-Nexus-Delivery-Id': request.deliveryId,
        },
      };

      try {
        const response = await fetch(`${baseUrl}/v3/smtp/email`, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.emailRequestTimeoutMs),
        });

        if (response.ok) {
          const data = (await response.json().catch(() => ({}))) as { messageId?: string };
          return {
            accepted: true,
            providerMessageId: normalizeMessageId(data.messageId) ?? request.deliveryId,
            retryable: false,
          };
        }

        // Brevo error bodies are { code, message }. They do not contain the message body.
        const detail = (await response.text().catch(() => '')).slice(0, 300);

        return {
          accepted: false,
          errorCode: `BREVO_HTTP_${response.status}`,
          error: `Brevo API responded ${response.status}: ${detail}`,
          // 429 and 5xx are transient. 400/401/403 mean a bad key, sender or payload.
          retryable: response.status === 429 || response.status >= 500,
        };
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        return {
          accepted: false,
          errorCode: timedOut ? 'ETIMEDOUT' : 'NETWORK_ERROR',
          error: timedOut ? 'Brevo API request timed out' : 'Brevo API request failed',
          retryable: true,
        };
      }
    },

    async verify(): Promise<void> {
      const response = await fetch(`${baseUrl}/v3/account`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(config.emailRequestTimeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Brevo API credentials check failed with status ${response.status}`);
      }
    },

    async close(): Promise<void> {
      // Nothing to close.
    },
  };
}