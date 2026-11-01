import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import type { Express } from 'express';
import { createApp } from '../src/app';
import { parseEnv, type AppConfig } from '../src/config/env';
import { getPrismaClient } from '../src/db/prisma';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import {
  createEmailDeliveryService,
  getEmailDeliveryService,
  getEmailTransport,
  installOutboxEmailSender,
  resetEmailServices,
  type EmailMessage,
} from '../src/services/email';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { captureLogs } from './helpers/test-logger';
import { startSmtpServer, type TestSmtpServer } from './helpers/smtp-server';
import { jsonRequest, startServer, type RunningServer } from './helpers/test-server';

/**
 * Phase 4 integration tests.
 *
 * The suite runs against a real PostgreSQL database and a real SMTP server.
 * The SMTP server speaks enough of the protocol for nodemailer to complete a
 * delivery, so the production transport is exercised instead of a stub.
 *
 * It only runs when the database is explicitly marked as a test database,
 * because it creates accounts and delivery rows.
 */

const WEBHOOK_SECRET = 'phase4-webhook-secret-value-that-is-long-enough';
const WEBHOOK_TOKEN = 'phase4-webhook-token-value-that-is-long-enough';

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE4_DB_TESTS=true and a test DATABASE_URL to run this suite';

try {
  databaseUrl = resolveTestDatabaseUrl('RUN_PHASE4_DB_TESTS');

  if (databaseUrl) {
    skipReason = '';
  }
} catch (error) {
  skipReason = error instanceof Error ? error.message : 'The test database could not be resolved';
}

let uniqueCounter = 0;

function uniqueEmail(prefix = 'mail'): string {
  uniqueCounter += 1;

  return `${prefix}.${process.pid}.${uniqueCounter}.${Date.now()}@example.com`;
}

describe('Phase 4 transactional email', { skip: skipReason || false }, () => {
  let smtp: TestSmtpServer;
  let app: Express;
  let server: RunningServer;
  let prisma: ReturnType<typeof getPrismaClient>;
  let config: AppConfig;
  let baseUrl: string;

  function buildConfig(overrides: Record<string, string> = {}): AppConfig {
    return parseEnv({
      NODE_ENV: 'test',
      PORT: '4000',
      DATABASE_URL: databaseUrl as string,
      REDIS_URL: 'redis://localhost:6379/15',
      FRONTEND_URL: 'http://localhost:3000',
      CORS_ORIGINS: 'http://localhost:3000',
      LOG_LEVEL: 'info',
      JWT_ACCESS_SECRET: 'phase4-integration-test-access-secret-value',
      BCRYPT_SALT_ROUNDS: '4',
      RATE_LIMIT_MAX: '100000',
      RATE_LIMIT_NAMESPACE: `nexus-phase4-${process.pid}-${Date.now()}`,
      // The suite registers more accounts than the production limit allows.
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
      AUTH_LOGIN_RATE_LIMIT_MAX: '1000',
      AUTH_VERIFICATION_RATE_LIMIT_MAX: '1000',
      AUTH_PASSWORD_RATE_LIMIT_MAX: '1000',
      EMAIL_PROVIDER: 'smtp',
      EMAIL_SMTP_HOST: smtp.host,
      EMAIL_SMTP_PORT: String(smtp.port),
      EMAIL_SMTP_SECURE: 'false',
      EMAIL_FROM_ADDRESS: 'no-reply@example.com',
      EMAIL_FROM_NAME: 'Nexus',
      EMAIL_SUPPORT_ADDRESS: 'support@example.com',
      EMAIL_WEBHOOK_SECRET: WEBHOOK_SECRET,
      EMAIL_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
      EMAIL_MAX_ATTEMPTS: '2',
      EMAIL_RETRY_BASE_DELAY_MS: '10',
      ...overrides,
    });
  }

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);

    prisma = getPrismaClient(database.url);

    await connectRedis({ redisUrl: 'redis://localhost:6379/15' });

    // A previous run can leave queued rows behind. They would be claimed by
    // the next run and break the counters of the delivery tests.
    await clearTestDeliveries();

    smtp = await startSmtpServer();
    config = buildConfig();

    installOutboxEmailSender(config);

    app = createApp({ config });
    server = await startServer(app);
    baseUrl = server.baseUrl;
  });

  after(async () => {
    await server?.close();
    await resetEmailServices();
    await smtp?.close();

    // The delivery rows of this suite are disposable.
    await clearTestDeliveries();
    await disconnectRedis();
    await prisma?.$disconnect();
  });

  async function clearTestDeliveries(): Promise<void> {
    if (!prisma) {
      return;
    }

    await prisma.emailDelivery.deleteMany({
      where: { toAddress: { endsWith: '@example.com' } },
    });
    await prisma.emailWebhookEvent.deleteMany({});
    await prisma.emailSuppression.deleteMany({});
  }

  function deliveryService() {
    return getEmailDeliveryService(config);
  }

  async function register(email: string): Promise<void> {
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ email, name: 'Mail Tester', password: 'Correct-Horse-9' }),
    });

    assert.equal(response.status, 201, JSON.stringify(response.body));
  }

  test('a registration email is queued, delivered and recorded', async () => {
    smtp.reset();
    const email = uniqueEmail('register');

    await register(email);

    const queued = await prisma.emailDelivery.findFirst({
      where: { toAddress: email },
      orderBy: { createdAt: 'desc' },
    });

    assert.ok(queued, 'Expected a delivery row for the registration email');
    assert.equal(queued.status, 'QUEUED');
    assert.equal(queued.template, 'account_verification');
    assert.equal(smtp.messages.length, 0, 'The provider must not be called before the worker runs');

    const result = await deliveryService().processPending(10);

    assert.equal(result.sent, 1);
    assert.equal(smtp.messages.length, 1);

    const captured = smtp.messages[0];

    assert.ok(captured);
    assert.equal(captured.to[0], email);
    assert.match(captured.from, /no-reply@example\.com/);
    assert.match(captured.body, /token=/);
    assert.match(captured.body, /<!doctype html>/i);

    const delivered = await prisma.emailDelivery.findUnique({ where: { id: queued.id } });

    assert.equal(delivered?.status, 'ACCEPTED');
    assert.ok(delivered?.providerMessageId);
    assert.ok(delivered?.acceptedAt);
  });

  test('the same idempotency key never delivers the message twice', async () => {
    smtp.reset();

    const message: EmailMessage = {
      to: uniqueEmail('dedupe'),
      subject: 'Only once',
      template: 'security_notification',
      text: 'Only once',
      idempotencyKey: `test:dedupe:${uniqueCounter}`,
    };

    const first = await deliveryService().enqueue(message);
    const second = await deliveryService().enqueue(message);

    assert.equal(first.accepted, true);
    assert.equal(second.accepted, true);
    assert.equal(first.providerMessageId, second.providerMessageId);

    const rows = await prisma.emailDelivery.count({
      where: { idempotencyKey: `test:dedupe:${uniqueCounter}` },
    });

    assert.equal(rows, 1);

    await deliveryService().processPending(10);

    const sentToAddress = smtp.messages.filter((sent) => sent.to[0] === message.to);

    assert.equal(sentToAddress.length, 1, 'The message must reach the provider exactly once');
  });

  test('a transient provider failure is retried and then succeeds', async () => {
    smtp.reset();
    smtp.failNext(1);

    const email = uniqueEmail('retry');
    const deliveryId = await deliveryService().enqueue({
      to: email,
      subject: 'Retry me',
      template: 'security_notification',
      text: 'Retry me',
      idempotencyKey: `test:retry:${email}`,
    });

    const first = await deliveryService().processPending(10);

    assert.equal(first.retried, 1);
    assert.equal(first.sent, 0);

    const afterFailure = await prisma.emailDelivery.findUnique({
      where: { id: deliveryId.providerMessageId },
    });

    assert.equal(afterFailure?.status, 'QUEUED');
    assert.equal(afterFailure?.attempts, 1);
    assert.ok(afterFailure?.lastError);

    // The retry delay is very short in the test config, but we must still wait
    // for nextAttemptAt to pass before the second processPending can claim the
    // row. A brief sleep is enough; the production delay is 30 seconds.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await deliveryService().processPending(10);

    assert.equal(second.sent, 1);
    assert.equal(smtp.messages.length, 1);

    const afterRetry = await prisma.emailDelivery.findUnique({
      where: { id: deliveryId.providerMessageId },
    });

    assert.equal(afterRetry?.status, 'ACCEPTED');
    assert.equal(afterRetry?.attempts, 2);
  });

  test('a permanent provider failure fails the delivery without retrying', async () => {
    smtp.reset();
    smtp.rejectNext(1);

    const email = uniqueEmail('reject');
    const deliveryId = await deliveryService().enqueue({
      to: email,
      subject: 'Reject me',
      template: 'security_notification',
      text: 'Reject me',
      idempotencyKey: `test:reject:${email}`,
    });

    const result = await deliveryService().processPending(10);

    assert.equal(result.failed, 1);
    assert.equal(result.retried, 0);

    const failed = await prisma.emailDelivery.findUnique({
      where: { id: deliveryId.providerMessageId },
    });

    assert.equal(failed?.status, 'FAILED');
    assert.equal(failed?.attempts, 1);
  });

  test('a delivery is given up after the attempt limit', async () => {
    smtp.reset();
    smtp.failNext(10);

    const limitedConfig = buildConfig({ EMAIL_MAX_ATTEMPTS: '1' });
    const limited = createEmailDeliveryService({
      prisma,
      transport: getEmailTransport(config),
      config: limitedConfig,
    });

    const email = uniqueEmail('limit');
    const deliveryId = await limited.enqueue({
      to: email,
      subject: 'Give up',
      template: 'security_notification',
      text: 'Give up',
      idempotencyKey: `test:limit:${email}`,
    });

    const result = await limited.processPending(10);

    assert.equal(result.failed, 1);

    const failed = await prisma.emailDelivery.findUnique({
      where: { id: deliveryId.providerMessageId },
    });

    assert.equal(failed?.status, 'FAILED');
    assert.equal(failed?.attempts, 1);

    // The row is terminal, so it never reaches the provider again.
    await prisma.emailDelivery.delete({ where: { id: deliveryId.providerMessageId as string } });
  });

  test('a bounced address is suppressed and stops receiving email', async () => {
    smtp.reset();
    const email = uniqueEmail('bounce');

    await register(email);

    await deliveryService().processPending(10);

    const delivered = await prisma.emailDelivery.findFirst({
      where: { toAddress: email },
      orderBy: { createdAt: 'desc' },
    });

    assert.ok(delivered?.providerMessageId);

    const payload = JSON.stringify({
      id: `evt_${email}`,
      type: 'email.bounced',
      data: {
        email_id: delivered?.providerMessageId,
        to: [email],
        reason: 'The recipient does not exist',
      },
    });

    const signature = createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');

    const response = await fetch(`${baseUrl}/api/v1/webhooks/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nexus-signature': `sha256=${signature}`,
      },
      body: payload,
    });

    assert.equal(response.status, 200);

    const body = (await response.json()) as { data: { outcome: string } };

    assert.equal(body.data.outcome, 'processed');

    const bounced = await prisma.emailDelivery.findUnique({ where: { id: delivered.id } });

    assert.equal(bounced?.status, 'BOUNCED');
    assert.ok(bounced?.bouncedAt);

    const suppression = await prisma.emailSuppression.findUnique({
      where: { emailAddress: email },
    });

    assert.equal(suppression?.reason, 'HARD_BOUNCE');

    // A later message to the same address is not handed to the provider.
    const blocked = await deliveryService().enqueue({
      to: email,
      subject: 'Should not be sent',
      template: 'security_notification',
      text: 'Should not be sent',
      idempotencyKey: `test:suppressed:${email}`,
    });

    const result = await deliveryService().processPending(10);

    assert.equal(result.suppressed, 1);

    const suppressed = await prisma.emailDelivery.findUnique({
      where: { id: blocked.providerMessageId },
    });

    assert.equal(suppressed?.status, 'SUPPRESSED');

    const sentToAddress = smtp.messages.filter((message) => message.to.includes(email));

    assert.equal(
      sentToAddress.length,
      1,
      'Only the first message may reach the provider for this address',
    );
  });

  test('a repeated webhook event is applied once', async () => {
    smtp.reset();
    const email = uniqueEmail('duplicate');

    await register(email);
    await deliveryService().processPending(10);

    const delivered = await prisma.emailDelivery.findFirst({
      where: { toAddress: email },
      orderBy: { createdAt: 'desc' },
    });

    const payload = JSON.stringify({
      id: `evt_duplicate_${email}`,
      type: 'email.delivered',
      data: { email_id: delivered?.providerMessageId, to: [email] },
    });

    const signature = createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');

    const first = await fetch(`${baseUrl}/api/v1/webhooks/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nexus-signature': `sha256=${signature}` },
      body: payload,
    });

    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { data: { outcome: string } }).data.outcome, 'processed');

    const second = await fetch(`${baseUrl}/api/v1/webhooks/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nexus-signature': `sha256=${signature}` },
      body: payload,
    });

    assert.equal(second.status, 200);
    assert.equal(
      ((await second.json()) as { data: { outcome: string } }).data.outcome,
      'duplicate',
    );

    const events = await prisma.emailWebhookEvent.count({
      where: { providerEventId: `evt_duplicate_${email}` },
    });

    assert.equal(events, 1);
  });

  test('the webhook endpoint rejects a payload without a valid signature', async () => {
    const response = await fetch(`${baseUrl}/api/v1/webhooks/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nexus-signature': 'sha256=not-a-signature',
      },
      body: JSON.stringify({ id: 'evt_forged', type: 'email.delivered' }),
    });

    assert.equal(response.status, 401);

    const body = (await response.json()) as { error: { code: string } };

    assert.equal(body.error.code, 'WEBHOOK_SIGNATURE_INVALID');
  });

  test('a Brevo event is accepted with the token of the webhook URL', async () => {
    smtp.reset();
    const email = uniqueEmail('brevo');

    await register(email);
    await deliveryService().processPending(10);

    const delivered = await prisma.emailDelivery.findFirst({
      where: { toAddress: email },
      orderBy: { createdAt: 'desc' },
    });

    assert.ok(delivered, 'Expected a delivery row for the registration email');
    assert.ok(delivered.providerMessageId, 'Expected a provider message id');

    // Brevo reports the SMTP message id in angle brackets and the moment of
    // the event as a unix timestamp.
    const payload = JSON.stringify({
      event: 'delivered',
      email,
      message_id: `<${delivered.providerMessageId}>`,
      ts: Math.floor(Date.now() / 1000),
    });

    const response = await fetch(`${baseUrl}/api/v1/webhooks/email/${WEBHOOK_TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    assert.equal(response.status, 200);

    const body = (await response.json()) as { data: { outcome: string } };

    assert.equal(body.data.outcome, 'processed');

    const updated = await prisma.emailDelivery.findFirst({
      where: { id: delivered.id },
    });

    assert.equal(updated?.status, 'DELIVERED');
    assert.ok(updated?.deliveredAt);
  });

  test('a Brevo event with the wrong token is rejected', async () => {
    const response = await fetch(`${baseUrl}/api/v1/webhooks/email/wrong-token-value`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'delivered', email: 'someone@example.com' }),
    });

    assert.equal(response.status, 401);
  });

  test('a Brevo hard bounce suppresses the address', async () => {
    smtp.reset();
    const email = uniqueEmail('brevo-bounce');

    await register(email);
    await deliveryService().processPending(10);

    const delivered = await prisma.emailDelivery.findFirst({
      where: { toAddress: email },
      orderBy: { createdAt: 'desc' },
    });

    assert.ok(delivered);

    const payload = JSON.stringify({
      event: 'hard_bounce',
      email,
      message_id: `<${delivered.providerMessageId}>`,
      ts: Math.floor(Date.now() / 1000),
    });

    const response = await fetch(`${baseUrl}/api/v1/webhooks/email/${WEBHOOK_TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    assert.equal(response.status, 200);

    const updated = await prisma.emailDelivery.findFirst({ where: { id: delivered.id } });

    assert.equal(updated?.status, 'BOUNCED');
    assert.ok(updated?.bouncedAt);

    const suppression = await prisma.emailSuppression.findFirst({
      where: { emailAddress: email },
    });

    assert.ok(suppression, 'Expected the bounced address to be suppressed');
    assert.equal(suppression?.reason, 'HARD_BOUNCE');
  });

  test('a Brevo soft bounce does not suppress the address', async () => {
    smtp.reset();
    const email = uniqueEmail('brevo-soft');

    await register(email);
    await deliveryService().processPending(10);

    const delivered = await prisma.emailDelivery.findFirst({
      where: { toAddress: email },
      orderBy: { createdAt: 'desc' },
    });

    assert.ok(delivered);

    const payload = JSON.stringify({
      event: 'soft_bounce',
      email,
      message_id: `<${delivered.providerMessageId}>`,
      ts: Math.floor(Date.now() / 1000),
    });

    const response = await fetch(`${baseUrl}/api/v1/webhooks/email/${WEBHOOK_TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    assert.equal(response.status, 200);

    const body = (await response.json()) as { data: { outcome: string } };

    assert.equal(body.data.outcome, 'ignored');

    const suppression = await prisma.emailSuppression.findFirst({
      where: { emailAddress: email },
    });

    assert.equal(suppression, null, 'A soft bounce must not suppress the address');
  });

  test('a verification token never reaches the application log', async () => {
    smtp.reset();
    const email = uniqueEmail('logs');

    const { result, logs } = await captureLogs(async () => {
      await register(email);
      await deliveryService().processPending(10);
    });

    assert.equal(result, undefined);

    const captured = smtp.messages[0];

    assert.ok(captured);

    const token = /token=([A-Za-z0-9_-]+)/.exec(captured.body)?.[1];

    assert.ok(token, 'Expected the email to contain a single use token');
    assert.equal(logs.output.includes(token as string), false);
    assert.equal(logs.output.includes('token='), false);
  });
});
