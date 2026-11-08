import { Prisma, type PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { hashSecret } from '../../utils/crypto';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import type {
  EmailTransport,
  EmailTransportRequest,
  EmailTransportResult,
} from '../providers/email';
import { redactEmailAddresses, summarizeErrorForLog } from './log-privacy';
import { isAddressSuppressed } from './suppression.service';
import type { EmailDeliveryResult, EmailMessage } from './types';
import { decryptOtpBody, encryptOtpBody } from './otp-body-encryption';

/**
 * Transactional email outbox.
 *
 * The delivery row is written before the provider is contacted. That gives
 * three properties the application depends on:
 *
 * 1. A message is never lost because the provider was briefly unavailable.
 * 2. A retried request cannot deliver the same message twice, because the
 *    idempotency key is unique.
 * 3. The status of a message survives a restart, so the provider webhook can
 *    be correlated with the delivery later on.
 *
 * The worker claims rows with `FOR UPDATE SKIP LOCKED`, so several instances
 * can run the same worker without sending the same message twice.
 */

export interface EmailDeliveryDependencies {
  prisma: PrismaClient;
  transport: EmailTransport;
  config: AppConfig;
  logger?: Logger;
}

export interface DeliveryPassResult {
  claimed: number;
  sent: number;
  failed: number;
  retried: number;
  suppressed: number;
}

const SENDING_INTERRUPTED_ERROR =
  'The delivery worker stopped before the provider outcome was recorded';
const SENDING_INTERRUPTED_CODE = 'SENDING_INTERRUPTED';
const MAX_ATTEMPTS_EXHAUSTED_ERROR = 'Retry limit reached before delivery';
const MAX_ATTEMPTS_EXHAUSTED_CODE = 'MAX_ATTEMPTS_EXHAUSTED';
const PROVIDER_TIMEOUT_CODE = 'PROVIDER_TIMEOUT';

/**
 * Raised when the provider does not answer within the configured request
 * timeout. It is treated as a transient failure, so it uses the same bounded
 * retry policy as any other provider error.
 */
class EmailRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The email provider did not respond within ${timeoutMs} ms`);
    this.name = 'EmailRequestTimeoutError';
  }
}

interface ClaimedDelivery {
  id: string;
  toAddress: string;
  fromAddress: string;
  template: string;
  subject: string;
  textBody: string;
  htmlBody: string | null;
  headers: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
  status: string;
  provider: string;
  providerMessageId: string | null;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  lastErrorCode: string | null;
  nextAttemptAt: Date;
  acceptedAt: Date | null;
  deliveredAt: Date | null;
  bouncedAt: Date | null;
  complainedAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function isOtpTemplate(template: string): boolean {
  return template === 'account_verification' || template === 'password_reset';
}

/**
 * Builds a deterministic idempotency key for a message that did not carry
 * one. Two identical messages collapse into a single delivery.
 */
export function deriveIdempotencyKey(message: EmailMessage): string {
  // The parts are serialized as an array, so no separator can be confused
  // with the content of a part.
  const fingerprint = hashSecret(
    JSON.stringify([message.template, message.to, message.subject, message.metadata ?? {}]),
  );

  return `auto:${message.template}:${message.to}:${fingerprint}`;
}

function toHeaderRecord(value: Prisma.JsonValue | null): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const headers: Record<string, string> = {};

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      headers[key] = item;
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Exponential backoff with a full jitter component, capped by the configured
 * maximum delay.
 */
export function retryDelayMs(attempt: number, config: AppConfig): number {
  const exponential = config.emailRetryBaseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, config.emailRetryMaxDelayMs);
  const jitter = Math.floor(Math.random() * Math.max(1, capped * 0.2));

  return capped - Math.floor(capped * 0.1) + jitter;
}

export function createEmailDeliveryService(deps: EmailDeliveryDependencies) {
  const client = deps.prisma;
  const log = deps.logger ?? defaultLogger;
  const transport = deps.transport;

  /**
   * Stores a message in the outbox. The row is the durable record of the
   * intent to send, so the provider is only contacted by the worker.
   */
  async function enqueue(message: EmailMessage): Promise<EmailDeliveryResult> {
    const idempotencyKey = message.idempotencyKey || deriveIdempotencyKey(message);
    const fromAddress = formatFromAddress(deps.config);
    const deliveryId = createDeliveryId();

    try {
      await client.emailDelivery.create({
        data: {
          id: deliveryId,
          toAddress: message.to,
          fromAddress,
          template: message.template,
          subject: message.subject,
          textBody: isOtpTemplate(message.template)
            ? encryptOtpBody(message.text, deps.config.otpHmacSecret)
            : message.text,
          htmlBody: message.html
            ? isOtpTemplate(message.template)
              ? encryptOtpBody(message.html, deps.config.otpHmacSecret)
              : message.html
            : null,
          headers: { 'X-Nexus-Delivery-Id': deliveryId },
          ...(message.metadata ? { metadata: message.metadata as Prisma.InputJsonValue } : {}),
          provider: transport.provider,
          idempotencyKey,
          maxAttempts: deps.config.emailMaxAttempts,
          status: 'QUEUED',
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The same message was already enqueued. Reuse it instead of sending
        // a second copy.
        const existing = await client.emailDelivery.findUnique({
          where: { idempotencyKey },
          select: { id: true, status: true },
        });

        log.info('email_delivery_deduplicated', {
          deliveryId: existing?.id,
          template: message.template,
        });

        return { accepted: true, providerMessageId: existing?.id ?? idempotencyKey };
      }

      throw error;
    }

    log.info('email_delivery_queued', {
      deliveryId,
      template: message.template,
    });

    return { accepted: true, providerMessageId: deliveryId };
  }

  /**
   * Claims queued deliveries that are due. The claim is atomic, so two
   * workers never pick up the same row.
   */
  async function claimDue(limit: number): Promise<ClaimedDelivery[]> {
    const rows = await client.$queryRaw<ClaimedDelivery[]>`
      UPDATE "EmailDelivery" AS d
      SET "status" = 'SENDING', "attempts" = d."attempts" + 1, "updatedAt" = NOW()
      WHERE d."id" IN (
        SELECT "id"
        FROM "EmailDelivery"
        WHERE "status" = 'QUEUED'
          AND "nextAttemptAt" <= NOW()
          AND "attempts" < "maxAttempts"
        ORDER BY "nextAttemptAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING d."id", d."toAddress", d."fromAddress", d."template", d."subject",
                d."textBody", d."htmlBody", d."headers", d."metadata", d."status",
                d."provider", d."providerMessageId", d."idempotencyKey", d."attempts",
                d."maxAttempts", d."lastError", d."lastErrorCode", d."nextAttemptAt",
                d."acceptedAt", d."deliveredAt", d."bouncedAt", d."complainedAt",
                d."failedAt", d."createdAt", d."updatedAt"
    `;

    return rows;
  }

  /**
   * Moves rows that already used every attempt out of the queue before the
   * claim runs. Older code could leave an exhausted row in `QUEUED`, and a
   * row in that state must never be handed to the provider again.
   */
  async function failExhaustedQueued(): Promise<number> {
    return client.$executeRaw`
      UPDATE "EmailDelivery"
      SET "status" = 'FAILED',
          "lastError" = COALESCE("lastError", ${MAX_ATTEMPTS_EXHAUSTED_ERROR}),
          "lastErrorCode" = COALESCE("lastErrorCode", ${MAX_ATTEMPTS_EXHAUSTED_CODE}),
          "failedAt" = COALESCE("failedAt", NOW()),
          "updatedAt" = NOW()
      WHERE "status" = 'QUEUED' AND "attempts" >= "maxAttempts"
    `;
  }

  /**
   * Recovers rows that were claimed by a worker that stopped before it could
   * record the outcome. Without this repair a hard crash leaves the row in
   * `SENDING` forever, even though the attempts counter already counts that
   * interrupted attempt.
   *
   * The update is conditional on the row still being stale and still being in
   * `SENDING`, so two workers cannot both recover it. An interrupted attempt
   * that already reached the limit becomes terminal; every other row returns
   * to the queue with the normal backoff and its attempt counter intact.
   */
  async function recoverStaleSending(limit: number): Promise<{ requeued: number; failed: number }> {
    const staleBefore = new Date(Date.now() - deps.config.emailSendingStaleMs);
    const rows = await client.emailDelivery.findMany({
      where: { status: 'SENDING', updatedAt: { lt: staleBefore } },
      select: { id: true, template: true, attempts: true, maxAttempts: true },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    const recovered = { requeued: 0, failed: 0 };

    for (const row of rows) {
      if (row.attempts >= row.maxAttempts) {
        const updated = await client.emailDelivery.updateMany({
          where: { id: row.id, status: 'SENDING', updatedAt: { lt: staleBefore } },
          data: {
            status: 'FAILED',
            lastError: MAX_ATTEMPTS_EXHAUSTED_ERROR,
            lastErrorCode: MAX_ATTEMPTS_EXHAUSTED_CODE,
            failedAt: new Date(),
          },
        });

        if (updated.count === 0) {
          continue;
        }

        recovered.failed += 1;
        log.error('email_delivery_failed', {
          deliveryId: row.id,
          template: row.template,
          attempt: row.attempts,
          maxAttempts: row.maxAttempts,
          errorCode: MAX_ATTEMPTS_EXHAUSTED_CODE,
        });
        continue;
      }

      const delay = retryDelayMs(row.attempts, deps.config);
      const updated = await client.emailDelivery.updateMany({
        where: { id: row.id, status: 'SENDING', updatedAt: { lt: staleBefore } },
        data: {
          status: 'QUEUED',
          lastError: SENDING_INTERRUPTED_ERROR,
          lastErrorCode: SENDING_INTERRUPTED_CODE,
          nextAttemptAt: new Date(Date.now() + delay),
        },
      });

      if (updated.count === 0) {
        continue;
      }

      recovered.requeued += 1;
      log.warn('email_delivery_recovered', {
        deliveryId: row.id,
        template: row.template,
        attempt: row.attempts,
        maxAttempts: row.maxAttempts,
        retryInMs: delay,
        errorCode: SENDING_INTERRUPTED_CODE,
      });
    }

    return recovered;
  }

  async function markSuppressed(delivery: ClaimedDelivery): Promise<void> {
    await client.emailDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SUPPRESSED', lastError: 'Recipient is on the suppression list' },
    });
  }

  async function markAccepted(delivery: ClaimedDelivery, providerMessageId: string): Promise<void> {
    await client.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'ACCEPTED',
        providerMessageId,
        acceptedAt: new Date(),
        lastError: null,
        lastErrorCode: null,
      },
    });
  }

  async function markFailed(
    delivery: ClaimedDelivery,
    error: string,
    errorCode: string,
  ): Promise<void> {
    await client.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'FAILED',
        lastError: error,
        lastErrorCode: errorCode,
        failedAt: new Date(),
      },
    });
  }

  async function markRetry(
    delivery: ClaimedDelivery,
    error: string,
    errorCode: string,
    delayMs: number,
  ): Promise<void> {
    await client.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'QUEUED',
        lastError: error,
        lastErrorCode: errorCode,
        nextAttemptAt: new Date(Date.now() + delayMs),
      },
    });
  }

  /**
   * Bounds a provider call. The SMTP transport already has its own socket
   * timeouts, but the delivery worker must not depend on a provider adapter
   * honouring them. A provider that never answers would otherwise hold the
   * worker open and leave the row in `SENDING` indefinitely.
   */
  async function sendWithTimeout(request: EmailTransportRequest): Promise<EmailTransportResult> {
    const timeoutMs = deps.config.emailRequestTimeoutMs;
    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new EmailRequestTimeoutError(timeoutMs)), timeoutMs);
    });

    try {
      return await Promise.race([transport.send(request), timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Applies the single retry decision used by every failure path.
   *
   * The attempt counter is incremented atomically when the row is claimed, so
   * this function never resets it. It schedules a backoff only while attempts
   * remain and otherwise moves the row to the terminal `FAILED` state.
   */
  async function retryOrFail(
    delivery: ClaimedDelivery,
    error: string,
    errorCode: string,
  ): Promise<'retried' | 'failed'> {
    if (delivery.attempts >= delivery.maxAttempts) {
      await markFailed(delivery, error, errorCode);

      log.error('email_delivery_failed', {
        deliveryId: delivery.id,
        template: delivery.template,
        attempt: delivery.attempts,
        maxAttempts: delivery.maxAttempts,
        errorCode: redactEmailAddresses(errorCode),
      });

      return 'failed';
    }

    const delay = retryDelayMs(delivery.attempts, deps.config);
    await markRetry(delivery, error, errorCode, delay);

    log.warn('email_delivery_retry_scheduled', {
      deliveryId: delivery.id,
      template: delivery.template,
      attempt: delivery.attempts,
      maxAttempts: delivery.maxAttempts,
      retryInMs: delay,
      errorCode: redactEmailAddresses(errorCode),
    });

    return 'retried';
  }

  /**
   * Sends one claimed delivery and records the outcome.
   */
  async function deliver(
    delivery: ClaimedDelivery,
  ): Promise<'sent' | 'failed' | 'retried' | 'suppressed'> {
    if (await isAddressSuppressed(client, delivery.toAddress)) {
      await markSuppressed(delivery);
      log.warn('email_delivery_suppressed', {
        deliveryId: delivery.id,
        template: delivery.template,
      });

      return 'suppressed';
    }

    let result: EmailTransportResult;

    try {
      result = await sendWithTimeout({
        deliveryId: delivery.id,
        to: delivery.toAddress,
        from: delivery.fromAddress,
        replyTo: deps.config.emailReplyToAddress || undefined,
        subject: delivery.subject,
        text: isOtpTemplate(delivery.template)
        ? decryptOtpBody(delivery.textBody, deps.config.otpHmacSecret)
        : delivery.textBody,
        html: delivery.htmlBody
        ? isOtpTemplate(delivery.template)
          ? decryptOtpBody(delivery.htmlBody, deps.config.otpHmacSecret)
          : delivery.htmlBody
        : undefined,
        headers: toHeaderRecord(delivery.headers),
      });
    } catch (error) {
      if (error instanceof EmailRequestTimeoutError) {
        log.warn('email_delivery_timeout', {
          deliveryId: delivery.id,
          template: delivery.template,
          timeoutMs: deps.config.emailRequestTimeoutMs,
        });

        return retryOrFail(delivery, error.message, PROVIDER_TIMEOUT_CODE);
      }

      throw error;
    }

    if (result.accepted) {
      await markAccepted(delivery, result.providerMessageId ?? delivery.id);
      log.info('email_delivery_sent', {
        deliveryId: delivery.id,
        template: delivery.template,
        provider: transport.provider,
      });

      return 'sent';
    }

    const error = result.error ?? 'Unknown email delivery failure';
    const errorCode = result.errorCode ?? 'UNKNOWN';

    if (result.retryable) {
      return retryOrFail(delivery, error, errorCode);
    }

    await markFailed(delivery, error, errorCode);

    log.error('email_delivery_failed', {
      deliveryId: delivery.id,
      template: delivery.template,
      attempt: delivery.attempts,
      errorCode: redactEmailAddresses(errorCode),
    });

    return 'failed';
  }

  /**
   * Runs one pass of the worker: claim, send, record.
   */
  async function processPending(limit: number): Promise<DeliveryPassResult> {
    const recovered = await recoverStaleSending(limit);
    const exhausted = await failExhaustedQueued();
    const claimed = await claimDue(limit);
    const result: DeliveryPassResult = {
      claimed: claimed.length,
      sent: 0,
      failed: exhausted + recovered.failed,
      retried: recovered.requeued,
      suppressed: 0,
    };

    if (exhausted > 0) {
      log.error('email_delivery_attempts_exhausted', { count: exhausted });
    }

    if (recovered.requeued > 0 || recovered.failed > 0) {
      log.warn('email_delivery_stale_sending_recovered', {
        requeued: recovered.requeued,
        failed: recovered.failed,
      });
    }

    for (const delivery of claimed) {
      try {
        const outcome = await deliver(delivery);

        if (outcome === 'sent') {
          result.sent += 1;
        } else if (outcome === 'failed') {
          result.failed += 1;
        } else if (outcome === 'retried') {
          result.retried += 1;
        } else {
          result.suppressed += 1;
        }
      } catch (error) {
        // An unexpected error must not stop the pass. It is retried under the
        // same bounded policy as a transient provider failure.
        log.error('email_delivery_unexpected_error', {
          deliveryId: delivery.id,
          error: summarizeErrorForLog(error),
        });

        const message =
          error instanceof Error ? error.message.slice(0, 500) : 'Unexpected delivery error';

        try {
          const outcome = await retryOrFail(delivery, message, 'UNEXPECTED');

          if (outcome === 'retried') {
            result.retried += 1;
          } else {
            result.failed += 1;
          }
        } catch (persistenceError) {
          // The row stays in SENDING, so it is never retried an unbounded
          // number of times. The next pass reports the persistence failure.
          log.error('email_delivery_retry_persistence_failed', {
            deliveryId: delivery.id,
            error: summarizeErrorForLog(persistenceError),
          });
        }
      }
    }

    return result;
  }

  return {
    enqueue,
    processPending,
  };
}

export type EmailDeliveryService = ReturnType<typeof createEmailDeliveryService>;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function createDeliveryId(): string {
  return `eml_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function formatFromAddress(config: AppConfig): string {
  return `${config.emailFromName} <${config.emailFromAddress}>`;
}
