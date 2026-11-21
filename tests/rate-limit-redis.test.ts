import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createApp } from '../src/app';
import { parseEnv, type AppConfig } from '../src/config/env';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { createErrorHandler } from '../src/middleware/error-handler';
import { createRateLimiter } from '../src/middleware/rate-limit';
import { createRateLimitStore } from '../src/services/cache/rate-limit-store';
import type { ReadinessProbe } from '../src/services/health';
import { Logger } from '../src/utils/logger';
import { FakeRedisClient } from './helpers/fake-redis';
import { withServer } from './helpers/test-server';

const readyProbe: ReadinessProbe = async () => ({
  status: 'ready',
  dependencies: {
    database: { status: 'up', latencyMs: 1 },
    redis: { status: 'up', latencyMs: 1 },
  },
});

let namespaceCounter = 0;

function uniqueNamespace(prefix: string): string {
  namespaceCounter += 1;

  return `phase-1-2-${prefix}-${process.pid}-${namespaceCounter}-${Date.now()}`;
}

function createTestConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): AppConfig {
  return parseEnv({
    NODE_ENV: 'test',
    PORT: '4000',
    DATABASE_URL: 'postgresql://nexus:nexus@localhost:5432/nexus_test',
    REDIS_URL: 'redis://localhost:6379/15',
    CORS_ORIGINS: 'https://app.example.com',
    CORS_CREDENTIALS: 'false',
    LOG_LEVEL: 'silent',
    REQUEST_BODY_LIMIT: '1mb',
    RATE_LIMIT_WINDOW_MS: '60000',
    RATE_LIMIT_MAX: '300',
    TRUST_PROXY: 'false',
    SHUTDOWN_TIMEOUT_MS: '10000',
    DB_HEALTH_TIMEOUT_MS: '1000',
    REDIS_HEALTH_TIMEOUT_MS: '1000',
    APP_NAME: 'Nexus',
    APP_VERSION: '0.1.0',
    JWT_ACCESS_SECRET: 'test-only-access-secret-do-not-use-in-production',
    ...overrides,
  });
}

test('the Redis rate-limit store shares counters between instances', async () => {
  const redis = new FakeRedisClient();
  const namespace = uniqueNamespace('shared-store');
  const first = createRateLimitStore({ namespace, windowMs: 60_000, client: redis });
  const second = createRateLimitStore({ namespace, windowMs: 60_000, client: redis });

  const firstHit = await first.increment('client-1');
  const secondHit = await second.increment('client-1');
  const otherClient = await second.increment('client-2');

  assert.equal(firstHit.totalHits, 1);
  assert.equal(secondHit.totalHits, 2);
  assert.equal(otherClient.totalHits, 1);

  await first.resetKey('client-1');

  const afterReset = await second.increment('client-1');

  assert.equal(afterReset.totalHits, 1);
});

test('rate-limit counters reset after the window expires', async () => {
  const redis = new FakeRedisClient();
  const store = createRateLimitStore({
    namespace: uniqueNamespace('window'),
    windowMs: 1_000,
    client: redis,
  });

  assert.equal((await store.increment('client-1')).totalHits, 1);

  redis.advance(999);
  assert.equal((await store.increment('client-1')).totalHits, 2);

  redis.advance(2);
  assert.equal((await store.increment('client-1')).totalHits, 1);
});

test('two applications share the global limiter counter through Redis', async () => {
  const redis = new FakeRedisClient();
  const config = createTestConfig({
    RATE_LIMIT_MAX: '1',
    RATE_LIMIT_NAMESPACE: uniqueNamespace('global-shared'),
  });
  const firstApp = createApp({
    config,
    readinessProbe: readyProbe,
    rateLimitClient: redis,
  });
  const secondApp = createApp({
    config,
    readinessProbe: readyProbe,
    rateLimitClient: redis,
  });

  await withServer(firstApp, async (baseUrl) => {
    const allowed = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    assert.equal(allowed.status, 404);
  });

  await withServer(secondApp, async (baseUrl) => {
    const blocked = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    const body = (await blocked.json()) as {
      success: boolean;
      error: { code: string; message: string };
    };

    assert.equal(blocked.status, 429);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'RATE_LIMITED');

    const health = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(health.status, 200);
  });
});

test('the global limiter fails closed when Redis is unavailable', async () => {
  const redis = new FakeRedisClient();
  redis.setAvailable(false);

  const app = createApp({
    config: createTestConfig({
      RATE_LIMIT_MAX: '1',
      RATE_LIMIT_NAMESPACE: uniqueNamespace('global-unavailable'),
    }),
    readinessProbe: readyProbe,
    rateLimitClient: redis,
  });

  await withServer(app, async (baseUrl) => {
    const blocked = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    const body = (await blocked.json()) as {
      success: boolean;
      error: { code: string; message: string; requestId: string };
    };

    assert.equal(blocked.status, 503);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'RATE_LIMIT_UNAVAILABLE');
    assert.equal(
      body.error.message,
      'Rate limiting is temporarily unavailable. Please try again later.',
    );
    assert.equal(body.error.requestId, blocked.headers.get('x-request-id'));

    const health = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(health.status, 200);
  });
});

test('route-level limiters fail closed when Redis is unavailable', async () => {
  const redis = new FakeRedisClient();
  redis.setAvailable(false);

  const app = express();

  app.use(
    createRateLimiter({
      namespace: uniqueNamespace('route-unavailable'),
      windowMs: 60_000,
      limit: 1,
      client: redis,
    }),
  );

  app.get('/limited', (_req, res) => {
    res.json({ success: true, data: { ok: true } });
  });

  app.use(createErrorHandler(new Logger('silent'), { isProduction: true }));

  await withServer(app, async (baseUrl) => {
    const blocked = await fetch(`${baseUrl}/limited`);
    const body = (await blocked.json()) as {
      success: boolean;
      error: { code: string; message: string };
    };

    assert.equal(blocked.status, 503);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'RATE_LIMIT_UNAVAILABLE');
    assert.equal(
      body.error.message,
      'Rate limiting is temporarily unavailable. Please try again later.',
    );
  });
});

test('custom key generators bucket IPv6 addresses in the same /64 together', async () => {
  const redis = new FakeRedisClient();
  const app = express();
  app.set('trust proxy', true);

  app.use(
    createRateLimiter({
      namespace: uniqueNamespace('ipv6-keygen'),
      windowMs: 60_000,
      limit: 1,
      client: redis,
      keyGenerator: (req) => `ip:${req.ip ?? 'unknown'}`,
    }),
  );

  app.get('/limited', (_req, res) => {
    res.json({ success: true, data: { ok: true } });
  });

  app.use(createErrorHandler(new Logger('silent'), { isProduction: true }));

  await withServer(app, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/limited`, {
      headers: { 'x-forwarded-for': '2001:db8:1234:5678::1' },
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${baseUrl}/limited`, {
      headers: { 'x-forwarded-for': '2001:db8:1234:5678::2' },
    });
    assert.equal(second.status, 429);
  });
});

test('the global limiter does not trust forwarded addresses when proxying is disabled', async () => {
  const app = createApp({
    config: createTestConfig({
      RATE_LIMIT_MAX: '1',
      RATE_LIMIT_NAMESPACE: uniqueNamespace('proxy'),
      TRUST_PROXY: 'false',
    }),
    readinessProbe: readyProbe,
    rateLimitClient: new FakeRedisClient(),
  });

  await withServer(app, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/v1/does-not-exist`, {
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    assert.equal(first.status, 404);

    const second = await fetch(`${baseUrl}/api/v1/does-not-exist`, {
      headers: { 'x-forwarded-for': '203.0.113.11' },
    });
    assert.equal(second.status, 429);
  });
});

test('decrement and reset do not reject when Redis is unavailable', async () => {
  const redis = new FakeRedisClient();
  redis.setAvailable(false);

  const store = createRateLimitStore({
    namespace: uniqueNamespace('cleanup'),
    windowMs: 60_000,
    client: redis,
  });

  await assert.doesNotReject(async () => {
    await store.decrement('client-1');
  });
  await assert.doesNotReject(async () => {
    await store.resetKey('client-1');
  });
  store.shutdown?.();
});

const runRedisTests = process.env.RUN_REDIS_TESTS === 'true';
const redisTestUrl = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379/15';
const redisSkipReason = runRedisTests
  ? false
  : 'Set RUN_REDIS_TESTS=true and a test Redis URL to run this suite';

test(
  'the global limiter shares counters through a real Redis connection',
  { skip: redisSkipReason },
  async () => {
    const namespace = uniqueNamespace('real-redis');
    const config = createTestConfig({
      RATE_LIMIT_MAX: '1',
      RATE_LIMIT_NAMESPACE: namespace,
      REDIS_URL: redisTestUrl,
    });

    await connectRedis({ redisUrl: redisTestUrl });

    try {
      const firstApp = createApp({ config, readinessProbe: readyProbe });
      const secondApp = createApp({ config, readinessProbe: readyProbe });

      await withServer(firstApp, async (baseUrl) => {
        const allowed = await fetch(`${baseUrl}/api/v1/does-not-exist`);
        assert.equal(allowed.status, 404);
      });

      await withServer(secondApp, async (baseUrl) => {
        const blocked = await fetch(`${baseUrl}/api/v1/does-not-exist`);
        assert.equal(blocked.status, 429);
      });

      await disconnectRedis();

      await withServer(secondApp, async (baseUrl) => {
        const unavailable = await fetch(`${baseUrl}/api/v1/does-not-exist`);
        const body = (await unavailable.json()) as {
          success: boolean;
          error: { code: string };
        };

        assert.equal(unavailable.status, 503);
        assert.equal(body.success, false);
        assert.equal(body.error.code, 'RATE_LIMIT_UNAVAILABLE');
      });
    } finally {
      await disconnectRedis();
    }
  },
);
