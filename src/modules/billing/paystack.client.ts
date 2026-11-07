import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../config/env';
import { AppError } from '../../utils/errors';

export interface PaystackTransaction {
  reference: string;
  status: string;
  amount: number;
  currency: string;
  paid_at: string | null;
  customer: { email: string; customer_code: string };
  authorization: { authorization_code: string; reusable: boolean };
}

export interface PaystackSubscription {
  subscription_code: string;
  email_token: string;
  next_payment_date: string | null;
  status: string;
  amount?: number;
  plan?: { amount: number; currency: string; interval: string };
}

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

export interface PaystackClient {
  initialize(input: {
    email: string;
    amount: number;
    reference: string;
    workspaceId: string;
  }): Promise<{ authorization_url: string }>;
  verify(reference: string): Promise<PaystackTransaction>;
  createPlan(input: {
    name: string;
    amount: number;
    interval: 'monthly' | 'annually';
  }): Promise<{ plan_code: string }>;
  createSubscription(input: {
    customer: string;
    plan: string;
    authorization?: string;
    start_date: string;
  }): Promise<PaystackSubscription>;
  fetchSubscription(code: string): Promise<PaystackSubscription>;
  disableSubscription(input: { code: string; token: string }): Promise<void>;
}

export function createPaystackClient(
  config: AppConfig,
  request: typeof fetch = fetch,
): PaystackClient {
  function requireConfiguration(): void {
    if (!config.paystackSecretKey || !config.paystackUsdEnabled) {
      throw new AppError(
        503,
        'PAYMENTS_UNAVAILABLE',
        'USD checkout is not enabled for this merchant account',
      );
    }
  }

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    requireConfiguration();
    const response = await request(`${config.paystackApiUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.paystackSecretKey}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: AbortSignal.timeout(config.paystackRequestTimeoutMs),
    });
    const envelope = (await response.json().catch(() => null)) as PaystackEnvelope<T> | null;
    if (!response.ok || !envelope?.status || !('data' in envelope)) {
      throw new AppError(
        502,
        'PAYSTACK_REQUEST_FAILED',
        'The payment provider could not complete the request',
      );
    }
    return envelope.data;
  }

  return {
    initialize: ({ email, amount, reference, workspaceId }) =>
      call('/transaction/initialize', {
        method: 'POST',
        body: JSON.stringify({
          email,
          amount,
          currency: 'USD',
          reference,
          callback_url: config.paystackCallbackUrl,
          metadata: { workspaceId, billingReference: reference },
        }),
      }),
    verify: (reference) => call(`/transaction/verify/${encodeURIComponent(reference)}`),
    createPlan: (input) =>
      call('/plan', {
        method: 'POST',
        body: JSON.stringify({ ...input, currency: 'USD', send_invoices: false, send_sms: false }),
      }),
    createSubscription: (input) =>
      call('/subscription', { method: 'POST', body: JSON.stringify(input) }),
    fetchSubscription: (code) => call(`/subscription/${encodeURIComponent(code)}`),
    disableSubscription: async ({ code, token }) => {
      await call('/subscription/disable', {
        method: 'POST',
        body: JSON.stringify({ code, token }),
      });
    },
  };
}

export function verifyPaystackSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha512', secret).update(rawBody).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Verify Paystack's timestamped signature over the unmodified webhook bytes. */
export function verifyPaystackWebhookSignature(
  rawBody: Buffer,
  header: string | undefined,
  secrets: readonly string[],
  nowSeconds = Math.floor(Date.now() / 1_000),
): boolean {
  if (!Buffer.isBuffer(rawBody) || !header || secrets.length === 0) return false;

  let timestamp: number | null = null;
  const signatures: Array<{ keyId: string; digest: string }> = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') {
      if (timestamp !== null || !/^\d+$/.test(value)) return false;
      timestamp = Number(value);
      if (!Number.isSafeInteger(timestamp)) return false;
    } else if (key === 'v1') {
      const delimiter = value.indexOf(':');
      if (delimiter > 0) {
        signatures.push({ keyId: value.slice(0, delimiter), digest: value.slice(delimiter + 1) });
      }
    }
  }

  if (timestamp === null || Math.abs(nowSeconds - timestamp) > 300 || signatures.length === 0) {
    return false;
  }

  for (const secret of secrets) {
    if (!secret) continue;
    const expected = createHmac('sha512', secret).update(`${timestamp}.`).update(rawBody).digest();
    for (const signature of signatures) {
      if (
        !/^whk_[A-Za-z0-9_-]+$/.test(signature.keyId) ||
        !/^[0-9a-f]{128}$/.test(signature.digest)
      )
        continue;
      const supplied = Buffer.from(signature.digest, 'hex');
      if (supplied.length === expected.length && timingSafeEqual(expected, supplied)) return true;
    }
  }
  return false;
}
