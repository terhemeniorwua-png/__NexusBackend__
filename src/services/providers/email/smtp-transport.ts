import nodemailer, { type Transporter } from 'nodemailer';
import type { AppConfig } from '../../../config/env';
import { classifyTransportError } from './error-classification';
import { buildMessageId, normalizeMessageId } from './message-id';
import type { EmailTransport, EmailTransportRequest, EmailTransportResult } from './types';

/**
 * SMTP transport.
 *
 * Brevo, Resend and Amazon SES all expose an SMTP endpoint, so a single
 * adapter covers all three providers and only the connection details change.
 * Provider specific webhooks are handled by the webhook service, which maps
 * their events onto the stored deliveries.
 *
 * The application builds the message id itself. A provider that reports the
 * message id in its events, Brevo among them, can then be matched to the
 * stored delivery without a provider specific identifier.
 */
export function createSmtpTransport(config: AppConfig): EmailTransport {
  const transporter: Transporter = nodemailer.createTransport({
    host: config.emailSmtpHost,
    port: config.emailSmtpPort,
    secure: config.emailSmtpSecure,
    auth: config.emailSmtpUser
      ? { user: config.emailSmtpUser, pass: config.emailSmtpPassword }
      : undefined,
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    connectionTimeout: config.emailRequestTimeoutMs,
    greetingTimeout: config.emailRequestTimeoutMs,
    socketTimeout: config.emailRequestTimeoutMs,
    tls: {
      rejectUnauthorized: config.emailSmtpTlsRejectUnauthorized,
    },
  });

  return {
    provider: 'smtp',

    async send(request: EmailTransportRequest): Promise<EmailTransportResult> {
      try {
        const info = await transporter.sendMail({
          from: request.from,
          to: request.to,
          ...(request.replyTo ? { replyTo: request.replyTo } : {}),
          subject: request.subject,
          text: request.text,
          ...(request.html ? { html: request.html } : {}),
          messageId: buildMessageId(request.deliveryId, request.from),
          headers: {
            ...(request.headers ?? {}),
            'X-Nexus-Delivery-Id': request.deliveryId,
          },
        });

        const rejected = Array.isArray(info.rejected) ? info.rejected : [];

        if (rejected.length > 0) {
          return {
            accepted: false,
            errorCode: 'EENVELOPE',
            error: 'The provider rejected the recipient address',
            retryable: false,
          };
        }

        return {
          accepted: true,
          providerMessageId: normalizeMessageId(info.messageId) ?? request.deliveryId,
          retryable: false,
        };
      } catch (error) {
        const classified = classifyTransportError(error);

        return {
          accepted: false,
          errorCode: classified.code,
          error: classified.message,
          retryable: classified.retryable,
        };
      }
    },

    async verify(): Promise<void> {
      await transporter.verify();
    },

    async close(): Promise<void> {
      transporter.close();
    },
  };
}
