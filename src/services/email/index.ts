import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import { createEmailTransport, type EmailTransport } from '../providers/email';
import { createEmailDeliveryService, type EmailDeliveryService } from './delivery.service';
import { createLoggingEmailSender } from './logging-email-sender';
import type { EmailDeliveryResult, EmailMessage, EmailSender } from './types';

/**
 * Email delivery seam.
 *
 * The application decides *what* to send. This module decides *how* it is
 * sent: the message is written to the transactional outbox, the delivery
 * worker hands it to the provider adapter, and transient failures are retried
 * with a backoff.
 *
 * The seam stays non fatal. A delivery failure must never roll back the
 * business change that triggered the email, so `sendEmail` reports the
 * outcome instead of throwing.
 */

export * from './types';
export * from './templates';
export { createLoggingEmailSender } from './logging-email-sender';
export {
  createEmailDeliveryService,
  deriveIdempotencyKey,
  retryDelayMs,
  type DeliveryPassResult,
  type EmailDeliveryService,
} from './delivery.service';
export {
  isAddressSuppressed,
  normalizeAddress,
  releaseAddress,
  suppressAddress,
  type SuppressionReason,
} from './suppression.service';
export { createEmailWorker, type EmailWorker, type EmailWorkerDependencies } from './worker';
export {
  buildMessageId,
  deliveryIdFromMessageId,
  extractDomain,
  normalizeMessageId,
} from '../providers/email/message-id';
export {
  mapProviderEvent,
  normalizeEventType,
  processProviderWebhook,
  verifyWebhookSignature,
  verifyWebhookToken,
  type ProcessWebhookInput,
  type ProviderEmailEvent,
  type ProviderEventType,
  type WebhookOutcome,
} from './webhook.service';

let sender: EmailSender | null = null;
let defaultSender: EmailSender | null = null;
let deliveryService: EmailDeliveryService | null = null;
let transport: EmailTransport | null = null;

/**
 * Builds the provider adapter described by the configuration.
 */
export function getEmailTransport(config: AppConfig): EmailTransport {
  if (!transport) {
    transport = createEmailTransport(config);
  }

  return transport;
}

/**
 * Builds the delivery service that writes to the outbox.
 */
export function getEmailDeliveryService(config: AppConfig): EmailDeliveryService {
  if (!deliveryService) {
    deliveryService = createEmailDeliveryService({
      prisma: getPrismaClient(),
      transport: getEmailTransport(config),
      config,
    });
  }

  return deliveryService;
}

/**
 * Installs the email sender used by the application.
 *
 * Tests install a capturing sender to assert on message content. The server
 * installs the outbox backed sender, so every message is stored before it is
 * handed to the provider.
 */
export function setEmailSender(next: EmailSender): void {
  sender = next;
}

export function getEmailSender(): EmailSender {
  if (sender) {
    return sender;
  }

  if (!defaultSender) {
    defaultSender = createLoggingEmailSender();
  }

  return defaultSender;
}

/**
 * Restores the default sender.
 */
export function resetEmailSender(): void {
  sender = null;
}

/**
 * Releases the provider adapter and the delivery service.
 *
 * The server keeps them for the lifetime of the process. The tests use this
 * to close the provider connection between suites.
 */
export async function resetEmailServices(): Promise<void> {
  if (transport) {
    await transport.close();
  }

  transport = null;
  deliveryService = null;
  sender = null;
  defaultSender = null;
}

/**
 * Replaces the default sender with the outbox backed sender.
 *
 * This is what the server calls during start up. Messages are stored before
 * the provider is contacted, so a provider outage cannot lose a message and a
 * retried request cannot send one twice.
 */
export function installOutboxEmailSender(config: AppConfig, service?: EmailDeliveryService): void {
  const active = service ?? getEmailDeliveryService(config);

  defaultSender = {
    async send(message: EmailMessage): Promise<EmailDeliveryResult> {
      return active.enqueue(message);
    },
  };

  sender = null;
}

/**
 * Sends an email without letting a delivery failure break the surrounding
 * business transaction.
 *
 * The email seam is intentionally non-fatal: a failed verification email must
 * not roll back a successful registration, and the user can always request a
 * new link. The result is reported so the caller can surface a retry hint.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailDeliveryResult> {
  try {
    return await getEmailSender().send(message);
  } catch (error) {
    return {
      accepted: false,
      error: error instanceof Error ? error.message : 'Unknown email delivery failure',
    };
  }
}
