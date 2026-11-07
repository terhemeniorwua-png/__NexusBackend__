import { logger } from '../../../utils/logger';
import type { AppConfig } from '../../../config/env';
import { redactEmailAddresses } from '../../email/log-privacy';
import { createConsoleTransport } from './console-transport';
import { createSmtpTransport } from './smtp-transport';
import { createBrevoApiTransport } from './brevo-api-transport';
import type { EmailTransport, EmailTransportRequest, EmailTransportResult } from './types';

/**
 * Disabled transport.
 *
 * It is used when a deployment does not want transactional email at all. The
 * message is accepted so the business flow is not blocked, but nothing is
 * sent.
 */
export function createDisabledTransport(): EmailTransport {
  return {
    provider: 'disabled',

    async send(request: EmailTransportRequest): Promise<EmailTransportResult> {
      logger.warn('email_delivery_disabled', {
        deliveryId: request.deliveryId,
        subject: redactEmailAddresses(request.subject),
      });

      return {
        accepted: true,
        providerMessageId: `disabled-${request.deliveryId}`,
        retryable: false,
      };
    },

    async verify(): Promise<void> {
      // Nothing to verify.
    },

    async close(): Promise<void> {
      // Nothing to close.
    },
  };
}

/**
 * Builds the transport described by the configuration.
 */
export function createEmailTransport(config: AppConfig): EmailTransport {
  if (config.emailProvider === 'smtp') return createSmtpTransport(config);
  if (config.emailProvider === 'brevo-api') return createBrevoApiTransport(config);
  if (config.emailProvider === 'disabled') return createDisabledTransport();
  return createConsoleTransport();
}


export * from './types';
export { classifyTransportError, type ClassifiedTransportError } from './error-classification';
export { createConsoleTransport } from './console-transport';
export { createSmtpTransport } from './smtp-transport';
export { createBrevoApiTransport } from './brevo-api-transport';