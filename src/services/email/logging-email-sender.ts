import { logger } from '../../utils/logger';
import type { EmailDeliveryResult, EmailMessage, EmailSender } from './types';

/**
 * Development and test email sender.
 *
 * It records only delivery metadata (recipient, template, subject). Message
 * bodies are never logged because they contain single-use verification and
 * password-reset links.
 */
export function createLoggingEmailSender(): EmailSender {
  return {
    async send(message: EmailMessage): Promise<EmailDeliveryResult> {
      logger.info('email_queued', {
        to: message.to,
        template: message.template,
        subject: message.subject,
        provider: 'logging',
      });

      return { accepted: true, providerMessageId: `local-${Date.now()}` };
    },
  };
}
