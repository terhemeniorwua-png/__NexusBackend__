import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { once } from 'node:events';
import test, { describe } from 'node:test';
import type { Express } from 'express';
import { createApp } from '../src/app';
import { parseEnv, type AppConfig } from '../src/config/env';
import type { ReadinessProbe } from '../src/services/health';
import { createCacheService, type CacheRedisClient } from '../src/services/cache/cache.service';
import {
  createWorkerHealthRegistry,
  type WorkerHealthRecorder,
} from '../src/services/workers/worker-health';
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

class MemoryCacheClient implements CacheRedisClient {
  readonly isOpen = true;
  readonly isReady = true;
  readonly data = new Map<string, string>();
  readonly expirations = new Map<string, number>();
  private scanSnapshot: string[] | null = null;
  failNextGet = false;
  failNextSet = false;
  failNextScan = false;

  async get(key: string): Promise<string | null> {
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new Error('redis get failed');
    }

    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string, options?: { EX?: number }): Promise<unknown> {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('redis set failed');
    }

    this.data.set(key, value);

    if (options?.EX) {
      this.expirations.set(key, options.EX);
    }

    return 'OK';
  }

  async del(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    let removed = 0;

    for (const entry of keys) {
      if (this.data.delete(entry)) {
        removed += 1;
        this.expirations.delete(entry);
      }
    }

    return removed;
  }

  async scan(
    cursor: string,
    options: { MATCH: string; COUNT: number },
  ): Promise<{ cursor: string; keys: string[] }> {
    if (this.failNextScan) {
      this.failNextScan = false;
      throw new Error('redis scan failed');
    }

    const prefix = options.MATCH.replace(/\*$/, '');

    if (cursor === '0') {
      // Real SCAN does not promise a stable order while keys are deleted, so
      // keep one snapshot for the whole cursor sequence.
      this.scanSnapshot = [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
    }

    const matching = this.scanSnapshot ?? [];
    // Emulate multiple SCAN pages so the cursor loop is exercised.
    const pageSize = 2;
    const start = Number(cursor);
    const page = matching.slice(start, start + pageSize);
    const next = start + pageSize >= matching.length ? '0' : String(start + pageSize);

    return { cursor: next, keys: page };
  }
}

function cacheFor(client: CacheRedisClient, ttlSeconds = 60) {
  return createCacheService({
    namespace: 'test-cache',
    defaultTtlSeconds: ttlSeconds,
    client,
  });
}

describe('Phase 24 cache service', () => {
  test('stores namespaced JSON with a TTL and reads it back', async () => {
    const client = new MemoryCacheClient();
    const cache = cacheFor(client, 30);

    await cache.set('analytics:workspace:1', { count: 4 }, { ttlSeconds: 15 });

    assert.equal(client.data.get('test-cache:analytics:workspace:1'), '{"count":4}');
    assert.equal(client.expirations.get('test-cache:analytics:workspace:1'), 15);

    const value = await cache.get<{ count: number }>('analytics:workspace:1');
    assert.deepEqual(value, { count: 4 });
  });

  test('treats malformed cached JSON as a miss', async () => {
    const client = new MemoryCacheClient();
    client.data.set('test-cache:broken', '{not json');
    const cache = cacheFor(client);

    assert.equal(await cache.get('broken'), null);
  });

  test('degrades to cache misses when Redis is unavailable', async () => {
    const closed: CacheRedisClient = {
      isOpen: false,
      get: async () => {
        throw new Error('should not be called');
      },
      set: async () => {
        throw new Error('should not be called');
      },
      del: async () => 0,
      scan: async () => ({ cursor: '0', keys: [] }),
    };

    const cache = cacheFor(closed);
    assert.equal(cache.isAvailable(), false);
    assert.equal(await cache.get('anything'), null);
    await cache.set('anything', { value: 1 });
    await cache.delete('anything');
    assert.equal(await cache.deletePrefix('workspace:'), 0);
  });

  test('never throws when a Redis command fails', async () => {
    const client = new MemoryCacheClient();
    const cache = cacheFor(client);

    client.failNextGet = true;
    assert.equal(await cache.get('missing'), null);

    client.failNextSet = true;
    await cache.set('missing', { value: 1 });

    client.failNextScan = true;
    assert.equal(await cache.deletePrefix('missing'), 0);
  });

  test('invalidates keys by prefix across SCAN pages only', async () => {
    const client = new MemoryCacheClient();
    client.data.set('test-cache:workspace:1:a', '1');
    client.data.set('test-cache:workspace:1:b', '2');
    client.data.set('test-cache:workspace:1:c', '3');
    client.data.set('test-cache:workspace:2:a', '4');

    const cache = cacheFor(client);
    const deleted = await cache.deletePrefix('workspace:1:');

    assert.equal(deleted, 3);
    assert.deepEqual([...client.data.keys()], ['test-cache:workspace:2:a']);
  });

  test('getOrSet shares one load between concurrent callers', async () => {
    const client = new MemoryCacheClient();
    const cache = cacheFor(client);
    let loads = 0;

    const loader = async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { value: 42 };
    };

    const [first, second] = await Promise.all([
      cache.getOrSet('shared', loader),
      cache.getOrSet('shared', loader),
    ]);

    assert.deepEqual(first, { value: 42 });
    assert.deepEqual(second, { value: 42 });
    assert.equal(loads, 1);

    const cached = await cache.getOrSet('shared', async () => {
      throw new Error('must not reload');
    });
    assert.deepEqual(cached, { value: 42 });
  });
});

describe('Phase 24 worker health registry', () => {
  test('records a successful pass and reports an idle worker', () => {
    const registry = createWorkerHealthRegistry({ staleAfterMs: 60_000 });
    const worker = registry.register('email');

    worker.started();
    worker.passStarted();
    worker.succeeded();

    const report = registry.snapshot();
    assert.equal(report.status, 'ok');
    assert.equal(report.workers.length, 1);
    assert.equal(report.workers[0]?.name, 'email');
    assert.equal(report.workers[0]?.state, 'IDLE');
    assert.equal(report.workers[0]?.stale, false);
    assert.ok(report.workers[0]?.lastSuccessAt);
    assert.equal(report.workers[0]?.lastErrorCode, null);
  });

  test('marks a worker failing after consecutive failed passes', () => {
    const registry = createWorkerHealthRegistry({ staleAfterMs: 60_000, failureThreshold: 2 });
    const worker = registry.register('webhooks');

    worker.started();
    worker.passStarted();
    worker.failed(new Error('provider down'));

    assert.equal(registry.snapshot().status, 'ok');

    worker.passStarted();
    worker.failed({ code: 'PROVIDER_TIMEOUT' });

    const report = registry.snapshot();
    assert.equal(report.status, 'degraded');
    assert.equal(report.workers[0]?.state, 'FAILING');
    assert.equal(report.workers[0]?.consecutiveFailures, 2);
    assert.equal(report.workers[0]?.lastErrorCode, 'PROVIDER_TIMEOUT');
  });

  test('detects a stale worker without a recent success', () => {
    const registry = createWorkerHealthRegistry({ staleAfterMs: 1_000 });
    const worker = registry.register('automation');
    worker.started();

    const later = new Date(Date.now() + 5_000);
    const report = registry.snapshot(later);

    assert.equal(report.workers[0]?.stale, true);
    assert.equal(report.status, 'degraded');
  });

  test('reports stopped workers separately from degraded ones', () => {
    const registry = createWorkerHealthRegistry({ staleAfterMs: 1_000 });
    const worker: WorkerHealthRecorder = registry.register('integration-sync');

    worker.started();
    worker.passStarted();
    worker.succeeded();
    worker.stopped();

    const report = registry.snapshot(new Date(Date.now() + 10_000));
    assert.equal(report.workers[0]?.state, 'STOPPED');
    assert.equal(report.workers[0]?.stale, false);
    assert.equal(report.status, 'ok');
  });
});

describe('Phase 24 worker health endpoint', () => {
  test('returns worker liveness and queue depth', async () => {
    const registry = createWorkerHealthRegistry({ staleAfterMs: 60_000 });
    const worker = registry.register('email');
    worker.started();
    worker.passStarted();
    worker.succeeded();

    const app = createApp({
      config: createTestConfig(),
      readinessProbe: readyProbe,
      rateLimitClient: new FakeRedisClient(),
      workerHealth: registry,
      queueStatusProbe: async () => [{ name: 'email', pending: 3, failed: 1 }],
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/health/workers`);
      const body = (await response.json()) as {
        success: boolean;
        data: {
          status: string;
          workers: Array<{ name: string; state: string }>;
          queues: Array<{ name: string; pending: number; failed: number }>;
        };
      };

      assert.equal(response.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.status, 'ok');
      assert.equal(body.data.workers[0]?.name, 'email');
      assert.deepEqual(body.data.queues, [{ name: 'email', pending: 3, failed: 1 }]);
    });
  });

  test('returns 503 when a worker is failing', async () => {
    const registry = createWorkerHealthRegistry({ staleAfterMs: 60_000, failureThreshold: 1 });
    const worker = registry.register('automation');
    worker.started();
    worker.passStarted();
    worker.failed(new Error('boom'));

    const app = createApp({
      config: createTestConfig(),
      readinessProbe: readyProbe,
      rateLimitClient: new FakeRedisClient(),
      workerHealth: registry,
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/health/workers`);
      const body = (await response.json()) as { success: boolean; data: { status: string } };

      assert.equal(response.status, 503);
      assert.equal(body.success, false);
      assert.equal(body.data.status, 'degraded');
    });
  });

  test('keeps worker liveness when the queue probe fails', async () => {
    const registry = createWorkerHealthRegistry({ staleAfterMs: 60_000 });
    const worker = registry.register('email');
    worker.started();
    worker.passStarted();
    worker.succeeded();

    const app = createApp({
      config: createTestConfig(),
      readinessProbe: readyProbe,
      rateLimitClient: new FakeRedisClient(),
      workerHealth: registry,
      queueStatusProbe: async () => {
        throw new Error('database unavailable');
      },
    });

    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/health/workers`);
      const body = (await response.json()) as {
        success: boolean;
        data: { workers: unknown[]; queues: unknown[] };
      };

      assert.equal(response.status, 200);
      assert.equal(body.success, true);
      assert.equal(body.data.workers.length, 1);
      assert.deepEqual(body.data.queues, []);
    });
  });
});
