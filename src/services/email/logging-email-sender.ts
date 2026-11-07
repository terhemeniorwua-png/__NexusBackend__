import { logger } from '../../utils/logger';
import { redactEmailAddresses } from './log-privacy';
import type { EmailDeliveryResult, EmailMessage, EmailSender } from './types';

/**
 * Development and test email sender.
 *
 * It records only delivery metadata (template, subject and provider). The
 * recipient address is not logged, and message bodies are never logged
 * because they contain single-use verification and password-reset links.
 */
export function createLoggingEmailSender(): EmailSender {
  return {
    async send(message: EmailMessage): Promise<EmailDeliveryResult> {
      logger.info('email_queued', {
        template: message.template,
        subject: redactEmailAddresses(message.subject),
        provider: 'logging',
      });

      return { accepted: true, providerMessageId: `local-${Date.now()}` };
    },
  };
}
