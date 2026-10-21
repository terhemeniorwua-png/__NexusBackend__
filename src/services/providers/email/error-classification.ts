/**
 * Delivery failure classification.
 *
 * A provider error is either transient (the message never reached the
 * provider, or the provider asked us to try again) or permanent (the message
 * was rejected and will be rejected again). The delivery worker retries the
 * first kind with a backoff and fails the second kind immediately.
 */

export interface ClassifiedTransportError {
  code: string;
  message: string;
  retryable: boolean;
}

interface NodemailerLikeError {
  code?: unknown;
  command?: unknown;
  responseCode?: unknown;
  message?: unknown;
}

/**
 * Nodemailer error codes that describe a configuration problem or a rejected
 * message. Retrying these only repeats the same failure.
 */
const PERMANENT_ERROR_CODES = new Set([
  'EENVELOPE',
  'EMESSAGE',
  'EAUTH',
  'EAUTHUNKNOWN',
  'EADDRESS',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ECONFIG',
]);

/**
 * Nodemailer error codes that describe a temporary network or provider
 * condition. The same message usually succeeds later.
 */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'ECONNRESET',
  'EPIPE',
  'ESOCKETTIMEDOUT',
  'EDNS',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Turns an arbitrary thrown value into a classification.
 *
 * The message is truncated because provider errors can embed the full SMTP
 * conversation, which contains the recipient address.
 */
export function classifyTransportError(error: unknown): ClassifiedTransportError {
  if (!isRecord(error)) {
    return {
      code: 'UNKNOWN',
      message: 'Unknown email delivery failure',
      retryable: true,
    };
  }

  const candidate = error as NodemailerLikeError;
  const code = readString(candidate.code) ?? 'UNKNOWN';
  const responseCode =
    typeof candidate.responseCode === 'number' ? candidate.responseCode : undefined;
  const rawMessage = readString(candidate.message) ?? 'Unknown email delivery failure';
  const message = rawMessage.slice(0, 500);

  // The SMTP reply code is the most precise signal: 4xx asks us to try again
  // later, 5xx means the message will be rejected again.
  if (responseCode !== undefined && responseCode >= 400 && responseCode < 600) {
    return {
      code: `SMTP_${responseCode}`,
      message,
      retryable: responseCode < 500,
    };
  }

  if (PERMANENT_ERROR_CODES.has(code)) {
    return { code, message, retryable: false };
  }

  if (RETRYABLE_ERROR_CODES.has(code)) {
    return { code, message, retryable: true };
  }

  return { code, message, retryable: true };
}
