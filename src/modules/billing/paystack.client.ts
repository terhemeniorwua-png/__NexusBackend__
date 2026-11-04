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
