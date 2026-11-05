import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import type { AppConfig } from '../src/config/env';
import {
  createPaystackClient,
  verifyPaystackSignature,
  verifyPaystackWebhookSignature,
} from '../src/modules/billing/paystack.client';

const config = {
  paystackSecretKey: 'sk_test_example',
  paystackUsdEnabled: true,
  paystackApiUrl: 'https://api.paystack.co',
  paystackCallbackUrl: 'https://nexus.example/app/billing',
  paystackRequestTimeoutMs: 1_000,
} as AppConfig;

test('hosted checkout initializes a USD transaction with server-owned reference and workspace metadata', async () => {
  let requestUrl = '';
  let requestBody: Record<string, unknown> = {};
  const client = createPaystackClient(config, async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      status: true,
      message: 'ok',
      data: { authorization_url: 'https://checkout.paystack.com/example' },
    });
  });

  const result = await client.initialize({
    email: 'owner@example.test',
    amount: 1_000,
    reference: 'nexus_reference_1234',
    workspaceId: 'workspace-1',
  });

  assert.equal(requestUrl, 'https://api.paystack.co/transaction/initialize');
  assert.deepEqual(requestBody, {
    email: 'owner@example.test',
    amount: 1_000,
    currency: 'USD',
    reference: 'nexus_reference_1234',
    callback_url: 'https://nexus.example/app/billing',
    metadata: { workspaceId: 'workspace-1', billingReference: 'nexus_reference_1234' },
  });
  assert.equal(result.authorization_url, 'https://checkout.paystack.com/example');
});

test('transaction references are URL encoded before server-side verification', async () => {
  let requestUrl = '';
  const client = createPaystackClient(config, async (input) => {
    requestUrl = String(input);
    return Response.json({ status: true, message: 'ok', data: { reference: 'ref/one' } });
  });

  await client.verify('ref/one');

  assert.equal(requestUrl, 'https://api.paystack.co/transaction/verify/ref%2Fone');
});

test('webhook signature validation uses HMAC SHA-512 over the exact raw bytes', () => {
  const body = Buffer.from('{"event":"charge.success"}');
  const secret = 'test-secret';
  const signature = createHmac('sha512', secret).update(body).digest('hex');

  assert.equal(verifyPaystackSignature(body, signature, secret), true);
  const tamperedSignature = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
  assert.equal(verifyPaystackSignature(body, tamperedSignature, secret), false);
  assert.equal(verifyPaystackSignature(body, undefined, secret), false);
  assert.equal(verifyPaystackSignature(body, signature, ''), false);
});

test('timestamped Paystack webhook signatures verify with current or previous signing secret', () => {
  const body = Buffer.from('{"event":"charge.success"}');
  const timestamp = 1_800_000_000;
  const secret = 'whsec_test_secret';
  const digest = createHmac('sha512', secret).update(`${timestamp}.`).update(body).digest('hex');
  const header = `t=${timestamp},v1=whk_test_123:${digest}`;

  assert.equal(verifyPaystackWebhookSignature(body, header, [secret], timestamp), true);
  assert.equal(
    verifyPaystackWebhookSignature(body, header, ['old-secret', secret], timestamp),
    true,
  );
  assert.equal(verifyPaystackWebhookSignature(body, header, ['wrong-secret'], timestamp), false);
  assert.equal(verifyPaystackWebhookSignature(body, header, [secret], timestamp + 301), false);
  assert.equal(
    verifyPaystackWebhookSignature(
      Buffer.from('{"event":"charge.failed"}'),
      header,
      [secret],
      timestamp,
    ),
    false,
  );
  assert.equal(
    verifyPaystackWebhookSignature(body, `t=${timestamp},v1=whk_test_123:bad`, [secret], timestamp),
    false,
  );
});

test('provider failures return safe application errors without exposing request credentials', async () => {
  const client = createPaystackClient(config, async () =>
    Response.json({ status: false, message: 'sensitive provider detail' }, { status: 400 }),
  );

  await assert.rejects(client.verify('nexus_reference_1234'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'PAYSTACK_REQUEST_FAILED');
    assert.equal((error as Error).message.includes('sensitive provider detail'), false);
    assert.equal((error as Error).message.includes('sk_test_example'), false);
    return true;
  });
});
