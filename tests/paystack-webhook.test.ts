import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express, { type Express } from 'express';
import test, { afterEach } from 'node:test';
import type { AppConfig } from '../src/config/env';
import { createPaystackWebhookRouter } from '../src/modules/billing/paystack-webhook.routes';
import type { BillingService } from '../src/modules/billing/billing.service';
import type { PrismaClient } from '@prisma/client';
import { startServer, type RunningServer } from './helpers/test-server';

const secret = 'webhook-test-secret';
const config = {
  paystackSecretKey: secret,
  paystackWebhookSecret: secret,
  paystackWebhookPreviousSecret: '',
  requestBodyLimit: '1mb',
} as AppConfig;
let server: RunningServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function appFor(service: BillingService): Promise<{ app: Express; baseUrl: string }> {
  const app = express();
  app.use(
    '/api/v1/webhooks',
    createPaystackWebhookRouter({
      config,
      prisma: {} as PrismaClient,
      service,
    }),
  );
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status =
        typeof error === 'object' && error !== null && 'statusCode' in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : 500;
      res.status(status).json({ error: 'request failed' });
    },
  );
  server = await startServer(app);
  return { app, baseUrl: server.baseUrl };
}

function signature(body: string): string {
  return createHmac('sha512', secret).update(body).digest('hex');
}

test('Paystack webhook rejects an invalid signature before invoking billing state changes', async () => {
  let processed = 0;
  const service = {
    processWebhook: async () => {
      processed += 1;
    },
  } as unknown as BillingService;
  const { baseUrl } = await appFor(service);
  const response = await fetch(`${baseUrl}/api/v1/webhooks/paystack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paystack-signature': 'invalid' },
    body: JSON.stringify({ event: 'charge.success', data: { reference: 'ref-1' } }),
  });
  assert.equal(response.status, 401);
  assert.equal(processed, 0);
});

test('Paystack webhook validates the exact raw body and passes payment fields to billing service', async () => {
  const received: Array<Record<string, unknown>> = [];
  const service = {
    processWebhook: async (input: Record<string, unknown>) => {
      received.push(input);
    },
  } as unknown as BillingService;
  const { baseUrl } = await appFor(service);
  const body = JSON.stringify({
    event: 'charge.success',
    data: {
      reference: 'ref-2',
      amount: 1_000,
      currency: 'USD',
      paid_at: '2026-11-04T12:00:00.000Z',
    },
  });
  const response = await fetch(`${baseUrl}/api/v1/webhooks/paystack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paystack-signature': signature(body) },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.event, 'charge.success');
  assert.equal(received[0]?.reference, 'ref-2');
  assert.equal(received[0]?.amount, 1_000);
  assert.equal(received[0]?.currency, 'USD');
  assert.equal(typeof received[0]?.eventKey, 'string');
});

test('Paystack webhook accepts the timestamped provider header and rejects stale timestamps', async () => {
  let processed = 0;
  const service = {
    processWebhook: async () => {
      processed += 1;
    },
  } as unknown as BillingService;
  const { baseUrl } = await appFor(service);
  const body = JSON.stringify({ event: 'charge.success', data: { reference: 'ref-new' } });
  const timestamp = Math.floor(Date.now() / 1_000);
  const digest = createHmac('sha512', secret).update(`${timestamp}.${body}`).digest('hex');
  const valid = await fetch(`${baseUrl}/api/v1/webhooks/paystack`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Paystack-Signature': `t=${timestamp},v1=whk_test_123:${digest}`,
    },
    body,
  });
  assert.equal(valid.status, 200);
  assert.equal(processed, 1);

  const staleTimestamp = timestamp - 301;
  const staleDigest = createHmac('sha512', secret)
    .update(`${staleTimestamp}.${body}`)
    .digest('hex');
  const stale = await fetch(`${baseUrl}/api/v1/webhooks/paystack`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Paystack-Signature': `t=${staleTimestamp},v1=whk_test_123:${staleDigest}`,
    },
    body,
  });
  assert.equal(stale.status, 401);
  assert.equal(processed, 1);
});
