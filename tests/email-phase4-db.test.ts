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
import { Logger } from '../src/utils/logger';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { captureLogs } from './helpers/test-logger';
import { startSmtpServer, type TestSmtpServer } from './helpers/smtp-server';
import { jsonRequest, startServer, type RunningServer } from './helpers/test-server';
import type { EmailTransport } from '../src/services/providers/email';

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
  if (process.env.RUN_PHASE4_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database could not be resolved';
}

let uniqueCounter = 0;
const fixtureEmails = new Set<string>();
const fixtureUserIds = new Set<string>();
const fixtureWebhookEventIds = new Set<string>();

function uniqueEmail(prefix = 'mail'): string {
  uniqueCounter += 1;
  const email = `${prefix}.${process.pid}.${uniqueCounter}.${Date.now()}@example.com`;
  fixtureEmails.add(email);
  return email;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createCapturingLogger(): {
  logger: Logger;
  entries: Record<string, unknown>[];
} {
  const entries: Record<string, unknown>[] = [];
  const logger = new Logger('info', {}, (line) => {
    entries.push(JSON.parse(line) as Record<string, unknown>);
  });

  return { logger, entries };
}

/**
 * A transport that throws instead of returning a result. The transport
 * contract says this should not happen, so it exercises the worker's
 * unexpected-error path. The delivery is still accepted after the configured
 * number of failures.
 */
function createThrowingTransport(failuresBeforeSuccess: number): EmailTransport & {
  readonly calls: number;
} {
  let calls = 0;

  return {
    provider: 'throwing',

    get calls(): number {
      return calls;
    },

    async send(request) {
      calls += 1;

      if (calls <= failuresBeforeSuccess) {
        throw new Error('Simulated worker failure');
      }

      return {
        accepted: true,
        providerMessageId: `throwing-${request.deliveryId}`,
        retryable: false,
      };
    },

    async verify(): Promise<void> {
      // Nothing to verify.
    },

    async close(): Promise<void> {
      // Nothing to close.
    },
  };
}

/**
 * A transport that never settles. It exercises the delivery worker's own
 * provider timeout, which must bound the attempt even when an adapter ignores
 * its socket timeouts.
 */
function createHangingTransport(): EmailTransport & { readonly calls: number } {
  let calls = 0;

  return {
    provider: 'hanging',

    get calls(): number {
      return calls;
    },

    async send() {
      calls += 1;

      return new Promise<never>(() => {});
    },

    async verify(): Promise<void> {
      // Nothing to verify.
    },

    async close(): Promise<void> {
      // Nothing to close.
    },
  };
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
    if (fixtureUserIds.size) {
      await prisma?.auditLog.deleteMany({ where: { actorId: { in: [...fixtureUserIds] } } });
      await prisma?.user.deleteMany({ where: { id: { in: [...fixtureUserIds] } } });
    }
    await disconnectRedis();
    await prisma?.$disconnect();
  });

  async function clearTestDeliveries(): Promise<void> {
    if (!prisma) {
      return;
    }

    if (fixtureEmails.size) {
      const emails = [...fixtureEmails];
      await prisma.emailDelivery.deleteMany({ where: { toAddress: { in: emails } } });
      await prisma.emailSuppression.deleteMany({ where: { emailAddress: { in: emails } } });
    }
    if (fixtureWebhookEventIds.size) {
      await prisma.emailWebhookEvent.deleteMany({
        where: { providerEventId: { in: [...fixtureWebhookEventIds] } },
      });
    }
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
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    fixtureUserIds.add(user.id);
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
    assert.match(plainTextOf(captured.body), /\b\d{6}\b/, 'Expected a six-digit code in the verification email');
    assert.match(captured.body, /<!doctype html>/i);

    const delivered = await prisma.emailDelivery.findUnique({ where: { id: queued.id } });

    assert.equal(delivered?.status, 'ACCEPTED');
    assert.equal(delivered?.attempts, 1);
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

  test('repeated transient failures reach the limit and stay in a terminal state', async () => {
    smtp.reset();
    smtp.failNext(10);

    const limitedConfig = buildConfig({
      EMAIL_MAX_ATTEMPTS: '3',
      EMAIL_RETRY_BASE_DELAY_MS: '10',
      EMAIL_RETRY_MAX_DELAY_MS: '20',
    });
    const limited = createEmailDeliveryService({
      prisma,
      transport: getEmailTransport(config),
      config: limitedConfig,
    });

    const email = uniqueEmail('exhaust');
    const deliveryId = await limited.enqueue({
      to: email,
      subject: 'Exhaust the retries',
      template: 'security_notification',
      text: 'Exhaust the retries',
      idempotencyKey: `test:exhaust:${email}`,
    });
    const id = deliveryId.providerMessageId as string;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await limited.processPending(10);
      const row = await prisma.emailDelivery.findUnique({ where: { id } });

      assert.equal(row?.attempts, attempt);

      if (attempt < 3) {
        assert.equal(result.retried, 1);
        assert.equal(result.failed, 0);
        assert.equal(row?.status, 'QUEUED');
        assert.ok(row?.lastError);
        assert.ok(row?.nextAttemptAt);

        await sleep(50);
      } else {
        assert.equal(result.retried, 0);
        assert.equal(result.failed, 1);
        assert.equal(row?.status, 'FAILED');
        assert.ok(row?.failedAt);
        assert.ok(row?.lastError);
      }
    }

    const afterLimit = await limited.processPending(10);
    const final = await prisma.emailDelivery.findUnique({ where: { id } });

    assert.equal(afterLimit.claimed, 0);
    assert.equal(afterLimit.sent, 0);
    assert.equal(final?.status, 'FAILED');
    assert.equal(final?.attempts, 3);
    assert.equal(smtp.messages.length, 0);
  });

  test('an exhausted row left in the queue is moved to the terminal state without sending', async () => {
    smtp.reset();

    const email = uniqueEmail('stale');
    const id = `eml_stale_${process.pid}_${Date.now()}`;

    await prisma.emailDelivery.create({
      data: {
        id,
        toAddress: email,
        fromAddress: 'Nexus <no-reply@example.com>',
        template: 'security_notification',
        subject: 'Already exhausted',
        textBody: 'Already exhausted',
        provider: 'smtp',
        idempotencyKey: `test:stale:${email}`,
        status: 'QUEUED',
        attempts: 2,
        maxAttempts: 2,
        lastError: 'The previous attempt failed',
        lastErrorCode: 'SMTP_451',
        nextAttemptAt: new Date(Date.now() - 1_000),
      },
    });

    const result = await deliveryService().processPending(10);
    const row = await prisma.emailDelivery.findUnique({ where: { id } });

    assert.equal(result.failed, 1);
    assert.equal(result.sent, 0);
    assert.equal(row?.status, 'FAILED');
    assert.equal(row?.attempts, 2);
    assert.ok(row?.failedAt);
    assert.equal(row?.lastError, 'The previous attempt failed');
    assert.equal(smtp.messages.length, 0);
  });

  test('an unexpected worker failure is retried and then fails at the limit', async () => {
    const limitedConfig = buildConfig({
      EMAIL_MAX_ATTEMPTS: '2',
      EMAIL_RETRY_BASE_DELAY_MS: '10',
      EMAIL_RETRY_MAX_DELAY_MS: '20',
    });
    const transport = createThrowingTransport(Number.POSITIVE_INFINITY);
    const limited = createEmailDeliveryService({ prisma, transport, config: limitedConfig });

    const email = uniqueEmail('unexpected-fail');
    const deliveryId = await limited.enqueue({
      to: email,
      subject: 'Unexpected failure',
      template: 'security_notification',
      text: 'Unexpected failure',
      idempotencyKey: `test:unexpected-fail:${email}`,
    });
    const id = deliveryId.providerMessageId as string;

    const first = await limited.processPending(10);
    const afterFirst = await prisma.emailDelivery.findUnique({ where: { id } });

    assert.equal(first.retried, 1);
    assert.equal(afterFirst?.status, 'QUEUED');
    assert.equal(afterFirst?.attempts, 1);
    assert.equal(afterFirst?.lastErrorCode, 'UNEXPECTED');

    await sleep(50);

    const second = await limited.processPending(10);
    const afterSecond = await prisma.emailDelivery.findUnique({ where: { id } });

    assert.equal(second.failed, 1);
    assert.equal(second.retried, 0);
    assert.equal(afterSecond?.status, 'FAILED');
    assert.equal(afterSecond?.attempts, 2);
    assert.ok(afterSecond?.failedAt);
    assert.equal(afterSecond?.lastErrorCode, 'UNEXPECTED');

    const afterLimit = await limited.processPending(10);

    assert.equal(afterLimit.claimed, 0);
    assert.equal(transport.calls, 2);

    await transport.close();
  });

  test('a delivery recovers after a temporary worker failure', async () => {
    const limitedConfig = buildConfig({
      EMAIL_MAX_ATTEMPTS: '3',
      EMAIL_RETRY_BASE_DELAY_MS: '10',
      EMAIL_RETRY_MAX_DELAY_MS: '20',
    });
    const transport = createThrowingTransport(1);
    const limited = createEmailDeliveryService({ prisma, transport, config: limitedConfig });

    const email = uniqueEmail('unexpected-recover');
    const deliveryId = await limited.enqueue({
      to: email,
      subject: 'Recover after a worker failure',
      template: 'security_notification',
      text: 'Recover after a worker failure',
      idempotencyKey: `test:unexpected-recover:${email}`,
    });
    const id = deliveryId.providerMessageId as string;

    const first = await limited.processPending(10);

    assert.equal(first.retried, 1);

    await sleep(50);

    const second = await limited.processPending(10);
    const row = await prisma.emailDelivery.findUnique({ where: { id } });

    assert.equal(second.sent, 1);
    assert.equal(row?.status, 'ACCEPTED');
    assert.equal(row?.attempts, 2);
    assert.equal(transport.calls, 2);

    await transport.close();
  });

  test('a provider timeout is retried and then fails at the attempt limit', async () => {
    const limitedConfig = buildConfig({
      EMAIL_MAX_ATTEMPTS: '2',
      EMAIL_RETRY_BASE_DELAY_MS: '10',
      EMAIL_RETRY_MAX_DELAY_MS: '20',
      EMAIL_REQUEST_TIMEOUT_MS: '20',
    });
    const transport = createHangingTransport();
    const limited = createEmailDeliveryService({ prisma, transport, config: limitedConfig });

    const email = uniqueEmail('timeout');
    const deliveryId = await limited.enqueue({
      to: email,
      subject: 'The provider never answers',
      template: 'security_notification',
      text: 'The provider never answers',
      idempotencyKey: `test:timeout:${email}`,
    });
    const id = deliveryId.providerMessageId as string;

    const first = await limited.processPending(10);
    const afterFirst = await prisma.emailDelivery.findUnique({ where: { id } });

    assert.equal(first.retried, 1);
    assert.equal(afterFirst?.status, 'QUEUED');
    assert.equal(afterFirst?.attempts, 1);
    assert.equal(afterFirst?.lastErrorCode, 'PROVIDER_TIMEOUT');

    await sleep(60);

    const second = await limited.processPending(10);
    const afterSecond = await prisma.emailDelivery.findUnique({ where: { id } });

    assert.equal(second.failed, 1);
    assert.equal(second.retried, 0);
    assert.equal(afterSecond?.status, 'FAILED');
    assert.equal(afterSecond?.attempts, 2);
    assert.equal(afterSecond?.lastErrorCode, 'PROVIDER_TIMEOUT');
    assert.ok(afterSecond?.failedAt);

    const afterLimit = await limited.processPending(10);

    assert.equal(afterLimit.claimed, 0);
    assert.equal(transport.calls, 2);

    await transport.close();
  });

  test('a delivery left in SENDING by an interrupted worker is recovered and delivered', async () => {
    smtp.reset();

    const limitedConfig = buildConfig({
      EMAIL_MAX_ATTEMPTS: '3',
      EMAIL_RETRY_BASE_DELAY_MS: '200',
      EMAIL_RETRY_MAX_DELAY_MS: '200',
      EMAIL_REQUEST_TIMEOUT_MS: '1000',
      EMAIL_SENDING_STALE_MS: '2000',
    });
    const limited = createEmailDeliveryService({
      prisma,
      transport: getEmailTransport(config),
      config: limitedConfig,
    });

    const email = uniqueEmail('interrupted-recover');
    const id = `eml_interrupted_${process.pid}_${Date.now()}`;

    await prisma.emailDelivery.create({
      data: {
        id,
        toAddress: email,
        fromAddress: 'Nexus <no-reply@example.com>',
        template: 'security_notification',
        subject: 'Recover an interrupted delivery',
        textBody: 'Recover an interrupted delivery',
        provider: 'smtp',
        idempotencyKey: `test:interrupted-recover:${email}`,
        status: 'SENDING',
        attempts: 1,
        maxAttempts: 3,
        nextAttemptAt: new Date(Date.now() - 10_000),
        updatedAt: new Date(Date.now() - 10_000),
      },
    });

    const recoveryPass = await limited.processPending(10);
    const recovered = await prisma.emailDelivery.findUnique({ where: { id } });

    assert.equal(recoveryPass.retried, 1);
    assert.equal(recoveryPass.sent, 0);
    assert.equal(recovered?.status, 'QUEUED');
    assert.equal(recovered?.attempts, 1);
    assert.equal(recovered?.lastErrorCode, 'SENDING_INTERRUPTED');

    await sleep(300);

    const deliveryPass = await limited.processPending(10);
    const delivered = await prisma.emailDelivery.findUnique({ where: { id } });
    const sentToAddress = smtp.messages.filter((message) => message.to.includes(email));

    assert.equal(deliveryPass.sent, 1);
    assert.equal(delivered?.status, 'ACCEPTED');
    assert.equal(delivered?.attempts, 2);
    assert.equal(sentToAddress.length, 1);
  });

  test('a stale SENDING row at the attempt limit becomes terminal without sending', async () => {
    smtp.reset();

    const limitedConfig = buildConfig({
      EMAIL_MAX_ATTEMPTS: '2',
      EMAIL_REQUEST_TIMEOUT_MS: '10',
      EMAIL_SENDING_STALE_MS: '20',
    });
    const limited = createEmailDeliveryService({
      prisma,
      transport: getEmailTransport(config),
      config: limitedConfig,
    });

    const email = uniqueEmail('interrupted-exhausted');
    const id = `eml_interrupted_exhausted_${process.pid}_${Date.now()}`;

    await prisma.emailDelivery.create({
      data: {
        id,
        toAddress: email,
        fromAddress: 'Nexus <no-reply@example.com>',
        template: 'security_notification',
        subject: 'Already exhausted by an interrupted worker',
        textBody: 'Already exhausted by an interrupted worker',
        provider: 'smtp',
        idempotencyKey: `test:interrupted-exhausted:${email}`,
        status: 'SENDING',
        attempts: 2,
        maxAttempts: 2,
        nextAttemptAt: new Date(Date.now() - 1_000),
        updatedAt: new Date(Date.now() - 1_000),
      },
    });

    const result = await limited.processPending(10);
    const failed = await prisma.emailDelivery.findUnique({ where: { id } });
    const sentToAddress = smtp.messages.filter((message) => message.to.includes(email));

    assert.equal(result.failed, 1);
    assert.equal(result.sent, 0);
    assert.equal(failed?.status, 'FAILED');
    assert.equal(failed?.attempts, 2);
    assert.equal(failed?.lastErrorCode, 'MAX_ATTEMPTS_EXHAUSTED');
    assert.ok(failed?.failedAt);
    assert.equal(sentToAddress.length, 0);
  });

  test('concurrent delivery passes never claim or send a row twice', async () => {
    smtp.reset();

    const email = uniqueEmail('concurrent');
    const deliveryId = await deliveryService().enqueue({
      to: email,
      subject: 'Claim me once',
      template: 'security_notification',
      text: 'Claim me once',
      idempotencyKey: `test:concurrent:${email}`,
    });
    const id = deliveryId.providerMessageId as string;

    const [first, second] = await Promise.all([
      deliveryService().processPending(10),
      deliveryService().processPending(10),
    ]);
    const row = await prisma.emailDelivery.findUnique({ where: { id } });
    const sentToAddress = smtp.messages.filter((message) => message.to.includes(email));

    assert.equal(row?.status, 'ACCEPTED');
    assert.equal(row?.attempts, 1);
    assert.equal(sentToAddress.length, 1);
    assert.ok(first.claimed + second.claimed >= 1);
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
    fixtureWebhookEventIds.add(`evt_${email}`);

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
    fixtureWebhookEventIds.add(`evt_duplicate_${email}`);

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

    const code = /\b(\d{6})\b/.exec(plainTextOf(captured.body))?.[1];

    assert.ok(code, 'Expected the email to contain a six-digit code');
    assert.equal(logs.output.includes(code), false);
  });

  test('the delivery lifecycle logs never expose the recipient address', async () => {
    smtp.reset();
    const email = uniqueEmail('privacy');
    const { logger, entries } = createCapturingLogger();
    const service = createEmailDeliveryService({
      prisma,
      transport: getEmailTransport(config),
      config,
      logger,
    });

    const queuedResult = await service.enqueue({
      to: email,
      subject: 'A private message',
      template: 'security_notification',
      text: 'A private message',
    });
    const pass = await service.processPending(10);

    assert.equal(queuedResult.accepted, true);
    assert.equal(pass.sent, 1);
    assert.equal(
      entries.some((entry) => JSON.stringify(entry).includes(email)),
      false,
    );

    const queued = entries.find((entry) => entry.message === 'email_delivery_queued');
    const sent = entries.find((entry) => entry.message === 'email_delivery_sent');

    assert.ok(queued);
    assert.equal(queued.deliveryId, queuedResult.providerMessageId);
    assert.equal(queued.template, 'security_notification');
    assert.equal('to' in queued, false);
    assert.equal(JSON.stringify(queued).includes('@'), false);

    assert.ok(sent);
    assert.equal(sent.deliveryId, queuedResult.providerMessageId);
    assert.equal(sent.template, 'security_notification');
    assert.equal(sent.provider, 'smtp');
    assert.equal(JSON.stringify(sent).includes('@'), false);

    const row = await prisma.emailDelivery.findUnique({
      where: { id: queuedResult.providerMessageId },
    });

    assert.equal(row?.status, 'ACCEPTED');
  });

  test('a provider error response does not put the recipient address in the log', async () => {
    const email = uniqueEmail('privacy-provider');
    const { logger, entries } = createCapturingLogger();
    const transport: EmailTransport = {
      provider: 'rejecting',
      async send() {
        return {
          accepted: false,
          retryable: false,
          errorCode: 'SMTP_550',
          error: `The server rejected ${email}`,
        };
      },
      async verify() {},
      async close() {},
    };
    const limited = createEmailDeliveryService({
      prisma,
      transport,
      config: buildConfig({ EMAIL_MAX_ATTEMPTS: '1' }),
      logger,
    });

    const queued = await limited.enqueue({
      to: email,
      subject: 'Rejected',
      template: 'security_notification',
      text: 'Rejected',
    });
    const pass = await limited.processPending(10);

    assert.equal(pass.failed, 1);
    assert.equal(
      entries.some((entry) => JSON.stringify(entry).includes(email)),
      false,
    );

    const failed = entries.find((entry) => entry.message === 'email_delivery_failed');

    assert.ok(failed);
    assert.equal(failed.deliveryId, queued.providerMessageId);
    assert.equal(failed.errorCode, 'SMTP_550');
    assert.equal(failed.attempt, 1);

    const row = await prisma.emailDelivery.findUnique({
      where: { id: queued.providerMessageId },
    });

    assert.equal(row?.status, 'FAILED');
  });

  test('an unexpected worker error is logged without the recipient address', async () => {
    const email = uniqueEmail('privacy-unexpected');
    const { logger, entries } = createCapturingLogger();
    const transport: EmailTransport = {
      provider: 'throwing',
      async send() {
        throw new Error(`SMTP conversation failed for ${email}`);
      },
      async verify() {},
      async close() {},
    };
    const limited = createEmailDeliveryService({
      prisma,
      transport,
      config: buildConfig({ EMAIL_MAX_ATTEMPTS: '1' }),
      logger,
    });

    const queued = await limited.enqueue({
      to: email,
      subject: 'Unexpected failure',
      template: 'security_notification',
      text: 'Unexpected failure',
    });
    const pass = await limited.processPending(10);

    assert.equal(pass.failed, 1);
    assert.equal(
      entries.some((entry) => JSON.stringify(entry).includes(email)),
      false,
    );

    const unexpected = entries.find((entry) => entry.message === 'email_delivery_unexpected_error');
    const failed = entries.find((entry) => entry.message === 'email_delivery_failed');

    assert.ok(unexpected);
    assert.equal(unexpected.deliveryId, queued.providerMessageId);
    assert.match(JSON.stringify(unexpected), /\[REDACTED_EMAIL\]/);

    assert.ok(failed);
    assert.equal(failed.errorCode, 'UNEXPECTED');
    assert.equal(failed.attempt, 1);
  });
});

function plainTextOf(raw: string): string {
  const decoded = raw
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  const htmlAt = decoded.search(/Content-Type: text\/html/i);
  const textPart = htmlAt === -1 ? decoded : decoded.slice(0, htmlAt);
  const bodyStart = textPart.indexOf('\r\n\r\n');
  return bodyStart === -1 ? textPart : textPart.slice(bodyStart + 4);
}
