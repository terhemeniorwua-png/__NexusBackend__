import { createHmac } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import { hashSecret, safeCompare } from '../../utils/crypto';
import { deliveryIdFromMessageId, normalizeMessageId } from '../providers/email/message-id';
import { suppressAddress, type SuppressionReason } from './suppression.service';

/**
 * Provider webhook handling.
 *
 * A provider tells the application what happened to a message: it was
 * delivered, it bounced or the recipient complained. Those events update the
 * stored delivery and, for bounces and complaints, add the address to the
 * suppression list.
 *
 * The endpoint is public, so the payload is only trusted after the signature
 * has been verified against the raw request body. Every event id is stored
 * once, so a provider that retries a webhook cannot apply the same change
 * twice.
 */

export type ProviderEventType =
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'failed'
  | 'sent'
  | 'opened'
  | 'clicked'
  | 'delayed'
  | 'unknown';

export interface ProviderEmailEvent {
  eventId: string;
  rawType: string;
  type: ProviderEventType;
  providerMessageId?: string | undefined;
  deliveryId?: string | undefined;
  recipients: string[];
  reason?: string | undefined;
  eventTimestamp?: number | undefined;
}

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored' | 'unverified' | 'unmatched';

export interface ProcessWebhookInput {
  prisma: PrismaClient;
  provider: string;
  rawBody: Buffer;
  signature: string | undefined;
  secret: string;
  /**
   * Token from the webhook URL. Providers that do not sign their events, such
   * as Brevo, are authenticated with this token instead of a signature.
   */
  token?: string | undefined;
  expectedToken?: string | undefined;
  toleranceSeconds: number;
  logger?: Logger;
}

/**
 * Verifies a shared secret that was carried in the webhook URL.
 *
 * The comparison is constant time, so the token cannot be guessed by
 * measuring the response time.
 */
export function verifyWebhookToken(input: {
  token: string | undefined;
  expected: string | undefined;
}): boolean {
  if (!input.token || !input.expected) {
    return false;
  }

  return safeCompare(input.token, input.expected);
}

/**
 * Verifies an HMAC-SHA256 signature over the raw request body.
 *
 * Two header formats are accepted:
 *
 * - `sha256=<hex>` — the signature covers the raw body.
 * - `t=<unix seconds>,v1=<hex>` — the signature covers `<timestamp>.<body>`
 *   and the timestamp must be inside the tolerance window.
 */
export function verifyWebhookSignature(input: {
  rawBody: Buffer;
  signature: string | undefined;
  secret: string;
  toleranceSeconds: number;
  now?: number;
}): boolean {
  const { rawBody, signature, secret, toleranceSeconds } = input;

  if (!secret || !signature) {
    return false;
  }

  const parts = signature.split(',').map((part) => part.trim());
  const values = new Map<string, string>();

  for (const part of parts) {
    const separator = part.indexOf('=');

    if (separator > 0) {
      values.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
    }
  }

  const timestamp = values.get('t');
  const versioned = values.get('v1');

  if (timestamp && versioned) {
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const issuedAt = Number.parseInt(timestamp, 10);

    if (!Number.isFinite(issuedAt)) {
      return false;
    }

    if (Math.abs(now - issuedAt) > toleranceSeconds) {
      return false;
    }

    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest('hex');

    return safeCompare(expected, versioned);
  }

  const plain = values.get('sha256') ?? signature.replace(/^sha256=/i, '').trim();

  if (!/^[a-f0-9]{64}$/i.test(plain)) {
    return false;
  }

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

  return safeCompare(expected, plain.toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPath(source: unknown, path: string[]): unknown {
  let current: unknown = source;

  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

function readString(source: unknown, paths: string[][]): string | undefined {
  for (const path of paths) {
    const value = readPath(source, path);

    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }

    if (typeof value === 'number') {
      return String(value);
    }
  }

  return undefined;
}

function readRecipients(source: unknown, paths: string[][]): string[] {
  for (const path of paths) {
    const value = readPath(source, path);

    if (typeof value === 'string' && value.includes('@')) {
      return [value.trim().toLowerCase()];
    }

    if (Array.isArray(value)) {
      const addresses = value
        .filter((item): item is string => typeof item === 'string' && item.includes('@'))
        .map((item) => item.trim().toLowerCase());

      if (addresses.length > 0) {
        return addresses;
      }
    }
  }

  return [];
}

function readNumber(source: unknown, paths: string[][]): number | undefined {
  for (const path of paths) {
    const value = readPath(source, path);

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      return Number.parseInt(value.trim(), 10);
    }
  }

  return undefined;
}

/**
 * Normalizes a provider event name.
 *
 * The Brevo names are the reference, because Brevo is the configured provider:
 *
 * - `delivered` becomes `delivered`.
 * - `hard_bounce` becomes `bounced` and suppresses the address.
 * - `soft_bounce` becomes `delayed`, because a soft bounce is temporary and
 *   must not suppress the address.
 * - `blocked` becomes `bounced`, because Brevo blocked an invalid recipient.
 * - `spam` and `unsubscribe` become `complained` and suppress the address.
 * - `sent` and `queued` carry no delivery state of their own.
 *
 * The names of the other providers are understood as well.
 */
export function normalizeEventType(rawType: string): ProviderEventType {
  const normalized = rawType
    .toLowerCase()
    .replace(/[.\-_]+/g, ' ')
    .trim();

  if (normalized.includes('soft bounce')) {
    return 'delayed';
  }

  if (normalized.includes('unsubscribe') || normalized.includes('opt out')) {
    return 'complained';
  }

  if (normalized.includes('blocked')) {
    return 'bounced';
  }

  if (normalized.includes('delay')) {
    return 'delayed';
  }

  if (normalized.includes('bounce')) {
    return 'bounced';
  }

  if (normalized.includes('complain') || normalized.includes('spam')) {
    return 'complained';
  }

  if (normalized.includes('fail') || normalized.includes('reject')) {
    return 'failed';
  }

  if (normalized.includes('deliver')) {
    return 'delivered';
  }

  if (normalized.includes('open')) {
    return 'opened';
  }

  if (normalized.includes('click')) {
    return 'clicked';
  }

  if (normalized.includes('sent')) {
    return 'sent';
  }

  return 'unknown';
}

/**
 * Serializes a value with a stable key order, so the same payload always
 * produces the same fingerprint.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

/**
 * Maps a provider payload onto the event shape the application uses.
 *
 * The provider specific field names are resolved here, so the rest of the
 * code only deals with one shape. The lookup order is deliberately tolerant:
 * Resend style (`data.email_id`), SES style (`mail.messageId`) and Brevo style
 * (`email`, `message_id`) payloads are all understood.
 */
export function mapProviderEvent(payload: unknown): ProviderEmailEvent | null {
  if (!isRecord(payload)) {
    return null;
  }

  const rawType =
    readString(payload, [
      ['type'],
      ['event'],
      ['event_type'],
      ['eventType'],
      ['data', 'type'],
      ['data', 'event'],
    ]) ?? 'unknown';

  // A provider that does not send an event id still gets a stable one: the
  // fingerprint of the payload. A repeated event is then recognised as a
  // duplicate instead of being applied twice.
  const eventId =
    readString(payload, [
      ['id'],
      ['event_id'],
      ['eventId'],
      ['data', 'id'],
      ['data', 'event_id'],
    ]) ?? hashSecret(stableStringify(payload));

  const providerMessageId = normalizeMessageId(
    readString(payload, [
      ['data', 'email_id'],
      ['email_id'],
      ['emailId'],
      ['data', 'message_id'],
      ['message_id'],
      ['messageId'],
      ['mail', 'messageId'],
      ['data', 'id'],
    ]),
  );

  const deliveryId = readString(payload, [
    ['data', 'delivery_id'],
    ['delivery_id'],
    ['data', 'headers', 'X-Nexus-Delivery-Id'],
    ['headers', 'X-Nexus-Delivery-Id'],
  ]);

  const recipients = readRecipients(payload, [
    ['data', 'to'],
    ['to'],
    ['data', 'email'],
    ['email'],
    ['mail', 'destination'],
    ['data', 'recipients'],
    ['recipients'],
  ]);

  const reason = readString(payload, [
    ['data', 'reason'],
    ['reason'],
    ['bounce', 'bounceType'],
    ['bounce', 'bounceSubType'],
    ['data', 'bounce', 'bounceType'],
    ['data', 'failure_reason'],
  ]);

  // Brevo sends the moment of the event as a unix timestamp in seconds.
  const eventTimestamp = readNumber(payload, [
    ['ts'],
    ['data', 'ts'],
    ['timestamp'],
    ['data', 'timestamp'],
  ]);

  return {
    eventId,
    rawType,
    type: normalizeEventType(rawType),
    providerMessageId,
    deliveryId,
    recipients,
    reason,
    eventTimestamp,
  };
}

async function findDelivery(
  prisma: PrismaClient,
  event: ProviderEmailEvent,
): Promise<{ id: string; toAddress: string; status: string } | null> {
  if (event.deliveryId) {
    const byId = await prisma.emailDelivery.findUnique({
      where: { id: event.deliveryId },
      select: { id: true, toAddress: true, status: true },
    });

    if (byId) {
      return byId;
    }
  }

  if (event.providerMessageId) {
    const byProviderId = await prisma.emailDelivery.findFirst({
      where: { providerMessageId: event.providerMessageId },
      select: { id: true, toAddress: true, status: true },
      orderBy: { createdAt: 'desc' },
    });

    if (byProviderId) {
      return byProviderId;
    }

    // The message id is built from the id of the delivery, so its local part
    // identifies the delivery even when the provider decorates the id.
    const deliveryId = deliveryIdFromMessageId(event.providerMessageId);

    if (deliveryId) {
      const byId = await prisma.emailDelivery.findUnique({
        where: { id: deliveryId },
        select: { id: true, toAddress: true, status: true },
      });

      if (byId) {
        return byId;
      }
    }
  }

  if (event.recipients.length > 0) {
    // Without a matching message id the recipient identifies the delivery.
    // The event timestamp narrows the search, so an event is not applied to an
    // unrelated message that happens to go to the same address.
    const createdBefore = event.eventTimestamp
      ? new Date((event.eventTimestamp + 60) * 1000)
      : undefined;

    const byRecipient = await prisma.emailDelivery.findFirst({
      where: {
        toAddress: { in: event.recipients },
        status: { in: ['ACCEPTED', 'SENDING', 'QUEUED'] },
        ...(createdBefore ? { createdAt: { lte: createdBefore } } : {}),
      },
      select: { id: true, toAddress: true, status: true },
      orderBy: { createdAt: 'desc' },
    });

    if (byRecipient) {
      return byRecipient;
    }
  }

  return null;
}

function statusFor(
  type: ProviderEventType,
): 'DELIVERED' | 'BOUNCED' | 'COMPLAINED' | 'FAILED' | null {
  switch (type) {
    case 'delivered':
      return 'DELIVERED';
    case 'bounced':
      return 'BOUNCED';
    case 'complained':
      return 'COMPLAINED';
    case 'failed':
      return 'FAILED';
    default:
      return null;
  }
}

function suppressionFor(type: ProviderEventType): SuppressionReason | null {
  if (type === 'bounced') {
    return 'HARD_BOUNCE';
  }

  if (type === 'complained') {
    return 'COMPLAINT';
  }

  return null;
}

/**
 * Verifies and applies a provider webhook.
 */
export async function processProviderWebhook(input: ProcessWebhookInput): Promise<WebhookOutcome> {
  const log = input.logger ?? defaultLogger;

  // A provider that signs its events is verified with the signature. A
  // provider that does not, Brevo among them, is verified with the token that
  // the webhook URL carries. Both are shared secrets.
  const signatureValid = verifyWebhookSignature({
    rawBody: input.rawBody,
    signature: input.signature,
    secret: input.secret,
    toleranceSeconds: input.toleranceSeconds,
  });

  const tokenValid = verifyWebhookToken({
    token: input.token,
    expected: input.expectedToken,
  });

  if (!signatureValid && !tokenValid) {
    log.warn('email_webhook_unverified', { provider: input.provider });

    return 'unverified';
  }

  let payload: unknown;

  try {
    payload = JSON.parse(input.rawBody.toString('utf8'));
  } catch {
    log.warn('email_webhook_invalid_json', { provider: input.provider });

    return 'ignored';
  }

  const event = mapProviderEvent(payload);

  if (!event) {
    log.warn('email_webhook_unmapped', { provider: input.provider });

    return 'ignored';
  }

  let eventRowId: string;

  try {
    const created = await input.prisma.emailWebhookEvent.create({
      data: {
        provider: input.provider,
        providerEventId: event.eventId,
        type: event.type,
        payload: payload as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    eventRowId = created.id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      log.info('email_webhook_duplicate', {
        provider: input.provider,
        providerEventId: event.eventId,
      });

      return 'duplicate';
    }

    throw error;
  }

  const target = statusFor(event.type);
  const delivery = await findDelivery(input.prisma, event);

  if (!target) {
    await input.prisma.emailWebhookEvent.update({
      where: { id: eventRowId },
      data: { processedAt: new Date(), outcome: 'no_status_change' },
    });

    return 'ignored';
  }

  if (!delivery) {
    await input.prisma.emailWebhookEvent.update({
      where: { id: eventRowId },
      data: { processedAt: new Date(), outcome: 'unmatched' },
    });

    log.warn('email_webhook_unmatched', {
      provider: input.provider,
      providerEventId: event.eventId,
      type: event.type,
    });

    return 'unmatched';
  }

  const now = new Date();

  await input.prisma.emailDelivery.update({
    where: { id: delivery.id },
    data: {
      status: target,
      ...(target === 'DELIVERED' ? { deliveredAt: now } : {}),
      ...(target === 'BOUNCED' ? { bouncedAt: now } : {}),
      ...(target === 'COMPLAINED' ? { complainedAt: now } : {}),
      ...(target === 'FAILED'
        ? { failedAt: now, lastError: event.reason ?? 'Provider reported a failure' }
        : {}),
    },
  });

  const reason = suppressionFor(event.type);

  if (reason) {
    await suppressAddress(input.prisma, {
      emailAddress: delivery.toAddress,
      reason,
      provider: input.provider,
      detail: event.reason ?? event.rawType,
    });

    log.warn('email_address_suppressed', {
      provider: input.provider,
      reason,
    });
  }

  await input.prisma.emailWebhookEvent.update({
    where: { id: eventRowId },
    data: { processedAt: now, outcome: target.toLowerCase() },
  });

  log.info('email_webhook_processed', {
    provider: input.provider,
    providerEventId: event.eventId,
    type: event.type,
    deliveryId: delivery.id,
  });

  return 'processed';
}
