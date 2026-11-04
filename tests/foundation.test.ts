import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import express, { type Express } from 'express';
import { createApp } from '../src/app';
import { parseEnv, type AppConfig } from '../src/config/env';
import { createErrorHandler } from '../src/middleware/error-handler';
import { createRateLimiter } from '../src/middleware/rate-limit';
import type { ReadinessProbe } from '../src/services/health';
import { Logger } from '../src/utils/logger';
import { FakeRedisClient } from './helpers/fake-redis';

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

const readyProbe: ReadinessProbe = async () => ({
  status: 'ready',
  dependencies: {
    database: { status: 'up', latencyMs: 1 },
    redis: { status: 'up', latencyMs: 1 },
  },
});

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1') as Server;
  await once(server, 'listening');

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address');
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
      server.closeAllConnections();
    });
  }
}

test('liveness endpoint returns a consistent success response and security headers', async () => {
  const app = createApp({
    config: createTestConfig(),
    readinessProbe: readyProbe,
    rateLimitClient: new FakeRedisClient(),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/health`);
    const body = (await response.json()) as {
      success: boolean;
      data: { status: string; service: string };
      requestId: string;
    };

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.status, 'ok');
    assert.equal(body.data.service, 'Nexus');
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(response.headers.get('x-request-id'), body.requestId);
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(response.headers.get('content-security-policy'));
  });
});

test('request IDs are preserved when safe and replaced when unsafe', async () => {
  const app = createApp({
    config: createTestConfig(),
    readinessProbe: readyProbe,
    rateLimitClient: new FakeRedisClient(),
  });

  await withServer(app, async (baseUrl) => {
    const accepted = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { 'x-request-id': 'client-request-123' },
    });

    assert.equal(accepted.headers.get('x-request-id'), 'client-request-123');

    const unsafe = 'x'.repeat(129);
    const replaced = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { 'x-request-id': unsafe },
    });

    assert.notEqual(replaced.headers.get('x-request-id'), unsafe);
  });
});

test('unknown routes return the standard error shape', async () => {
  const app = createApp({
    config: createTestConfig(),
    readinessProbe: readyProbe,
    rateLimitClient: new FakeRedisClient(),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    const body = (await response.json()) as {
      success: boolean;
      error: { code: string; message: string; requestId: string };
    };

    assert.equal(response.status, 404);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.requestId, response.headers.get('x-request-id'));
  });
});

test('readiness reports dependency status and returns 503 when a dependency is down', async () => {
  const notReadyProbe: ReadinessProbe = async () => ({
    status: 'not_ready',
    dependencies: {
      database: { status: 'up', latencyMs: 1 },
      redis: { status: 'down', latencyMs: 2 },
    },
  });

  const app = createApp({
    config: createTestConfig(),
    readinessProbe: notReadyProbe,
    rateLimitClient: new FakeRedisClient(),
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/health/ready`);
    const body = (await response.json()) as {
      success: boolean;
      data: { status: string; dependencies: Record<string, { status: string }> };
    };

    assert.equal(response.status, 503);
    assert.equal(body.success, false);
    assert.equal(body.data.status, 'not_ready');
    assert.equal(body.data.dependencies.redis?.status, 'down');
  });
});

test('CORS allows configured origins and rejects unknown origins', async () => {
  const app = createApp({
    config: createTestConfig(),
    readinessProbe: readyProbe,
    rateLimitClient: new FakeRedisClient(),
  });

  await withServer(app, async (baseUrl) => {
    const allowed = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { origin: 'https://app.example.com' },
    });

    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.com');
    assert.match(allowed.headers.get('vary') ?? '', /Origin/i);
    assert.equal(allowed.headers.get('access-control-allow-credentials'), null);

    const preflight = await fetch(`${baseUrl}/api/v1/health`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,content-type',
      },
    });

    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get('access-control-allow-methods'),
      'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    );
    assert.equal(
      preflight.headers.get('access-control-allow-headers'),
      'Content-Type,Authorization,X-Request-Id',
    );
    assert.equal(preflight.headers.get('access-control-max-age'), '600');

    const denied = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { origin: 'https://attacker.example.com' },
    });
    const body = (await denied.json()) as { error: { code: string } };

    assert.equal(denied.status, 403);
    assert.equal(body.error.code, 'CORS_ORIGIN_DENIED');
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    assert.match(denied.headers.get('vary') ?? '', /Origin/i);
  });
});

test('the global rate limiter allows requests within the configured limit', async () => {
  const app = createApp({
    config: createTestConfig({ RATE_LIMIT_MAX: '2' }),
    readinessProbe: readyProbe,
    rateLimitClient: new FakeRedisClient(),
  });

  await withServer(app, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    const second = await fetch(`${baseUrl}/api/v1/does-not-exist`);

    assert.equal(first.status, 404);
    assert.equal(second.status, 404);
  });
});

test('the global rate limiter returns the standard 429 response after the limit', async () => {
  const app = createApp({
    config: createTestConfig({ RATE_LIMIT_MAX: '1' }),
    readinessProbe: readyProbe,
    rateLimitClient: new FakeRedisClient(),
  });

  await withServer(app, async (baseUrl) => {
    const allowed = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    assert.equal(allowed.status, 404);

    const blocked = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    const body = (await blocked.json()) as {
      success: boolean;
      error: { code: string; message: string; requestId: string };
    };

    assert.equal(blocked.status, 429);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.equal(body.error.message, 'Too many requests. Please try again later.');
    assert.equal(body.error.requestId, blocked.headers.get('x-request-id'));

    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('AppError'), false);
    assert.equal(serialized.includes('stack'), false);

    const stillBlocked = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    assert.equal(stillBlocked.status, 429);
  });
});

test('route-level rate limiters still return their configured 429 error', async () => {
  const app = express();

  app.use(
    createRateLimiter({
      namespace: `phase-1-1-${process.pid}-${Date.now()}`,
      windowMs: 60_000,
      limit: 1,
      code: 'TEST_RATE_LIMITED',
      message: 'Too many test requests.',
      client: new FakeRedisClient(),
    }),
  );

  app.get('/limited', (_req, res) => {
    res.json({ success: true, data: { ok: true } });
  });

  app.use(createErrorHandler(new Logger('silent'), { isProduction: true }));

  await withServer(app, async (baseUrl) => {
    const allowed = await fetch(`${baseUrl}/limited`);
    assert.equal(allowed.status, 200);

    const blocked = await fetch(`${baseUrl}/limited`);
    const body = (await blocked.json()) as {
      success: boolean;
      error: { code: string; message: string };
    };

    assert.equal(blocked.status, 429);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'TEST_RATE_LIMITED');
    assert.equal(body.error.message, 'Too many test requests.');
  });
});
