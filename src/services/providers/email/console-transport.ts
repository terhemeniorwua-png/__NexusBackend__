import { logger } from '../../../utils/logger';
import type { EmailTransport, EmailTransportRequest, EmailTransportResult } from './types';

/**
 * Development transport.
 *
 * It records delivery metadata only. Message bodies, verification links and
 * single use tokens are never written to the log, because the log is shipped
 * to an aggregator that is not a secret store.
 */
export function createConsoleTransport(): EmailTransport {
  return {
    provider: 'console',

    async send(request: EmailTransportRequest): Promise<EmailTransportResult> {
      logger.info('email_delivery_console', {
        deliveryId: request.deliveryId,
        to: request.to,
        subject: request.subject,
      });

      return {
        accepted: true,
        providerMessageId: `console-${request.deliveryId}`,
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
