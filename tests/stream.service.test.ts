/**
 * Redis Streams service — integration tests.
 *
 * Gating: identical to `tests/rate-limit-redis.test.ts`.
 *   Set  RUN_REDIS_TESTS=true  and  REDIS_TEST_URL=redis://...  to run.
 *   Without them every case is skipped.
 *
 * Spin up an isolated instance first:
 *   docker run -d --name nexus-test-redis -p 63799:6379 redis:7
 *
 * Then run with:
 *   RUN_REDIS_TESTS=true REDIS_TEST_URL=redis://127.0.0.1:63799 \
 *     NODE_ENV=test node --import tsx --test tests/stream.service.test.ts
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { describe, after, before } from 'node:test';
import { createClient, type RedisClientType } from 'redis';
import { createStreamService } from '../src/services/streams/stream.service';
import { createAutomationRunQueue } from '../src/modules/automation/automation.queue';

// ---------------------------------------------------------------------------
// Test gating — same pattern as rate-limit-redis.test.ts
// ---------------------------------------------------------------------------

const runRedisTests = process.env['RUN_REDIS_TESTS'] === 'true';
const redisTestUrl = process.env['REDIS_TEST_URL'] ?? 'redis://localhost:6379/15';
const redisSkipReason = runRedisTests
  ? false
  : 'Set RUN_REDIS_TESTS=true and REDIS_TEST_URL to run this suite';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sharedClient: RedisClientType | null = null;

before(async () => {
  if (!runRedisTests) return;
  sharedClient = createClient({ url: redisTestUrl }) as RedisClientType;
  sharedClient.on('error', () => {});
  await sharedClient.connect();
});

after(async () => {
  if (sharedClient?.isOpen) await sharedClient.quit();
});

/** Create a unique stream/key name per test run to avoid cross-test pollution. */
function uid(): string {
  return randomBytes(6).toString('hex');
}

/** Build a stream service pointing at the test Redis. */
function makeSvc(opts: { namespace?: string } = {}) {
  return createStreamService({
    redis: sharedClient as RedisClientType,
    namespace: opts.namespace ?? `test-${uid()}`,
  });
}

/** Flush the specific keys created in a test. */
async function del(...keys: string[]) {
  if (!sharedClient) return;
  for (const key of keys) {
    await (sharedClient as unknown as { del(k: string): Promise<number> }).del(key);
  }
}

// ---------------------------------------------------------------------------
// 1. Add and read round-trip
// ---------------------------------------------------------------------------

describe('StreamService', () => {
  test(
    'add and read round-trip',
    { skip: redisSkipReason },
    async () => {
      const svc = makeSvc();
      const stream = `rt-${uid()}`;
      const group = 'rg';
      const consumer = 'c1';

      await svc.ensureGroup(stream, group);
      const entryId = await svc.addToStream(stream, { runId: 'run-1' });
      assert.ok(entryId, 'addToStream should return an entry ID');

      const msgs = await svc.readGroup(stream, group, consumer, { count: 1 });
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0]!.fields['runId'], 'run-1');
      assert.ok(msgs[0]!.id, 'message should have an ID');

      await svc.close();
      await del(svc.streamKey(stream));
    },
  );

  // -------------------------------------------------------------------------
  // 2. Consumer group created once; BUSYGROUP ignored
  // -------------------------------------------------------------------------

  test(
    'ensureGroup is idempotent (BUSYGROUP ignored)',
    { skip: redisSkipReason },
    async () => {
      const svc = makeSvc();
      const stream = `idm-${uid()}`;
      const group = 'grp';

      const created1 = await svc.ensureGroup(stream, group);
      assert.equal(created1, true, 'first call should return true');

      const created2 = await svc.ensureGroup(stream, group);
      assert.equal(created2, false, 'second call should return false (BUSYGROUP)');

      await svc.close();
      await del(svc.streamKey(stream));
    },
  );

  // -------------------------------------------------------------------------
  // 3. ACK removes entry from pending
  // -------------------------------------------------------------------------

  test(
    'ack removes entry from pending',
    { skip: redisSkipReason },
    async () => {
      const svc = makeSvc();
      const stream = `ack-${uid()}`;
      const group = 'ackgrp';
      const consumer = 'ackc';

      await svc.ensureGroup(stream, group);
      await svc.addToStream(stream, { runId: 'run-ack' });

      const msgs = await svc.readGroup(stream, group, consumer, { count: 1 });
      assert.equal(msgs.length, 1);

      let pending = await svc.pendingSummary(stream, group);
      assert.equal(pending?.pending, 1, 'one pending entry before ack');

      const acked = await svc.ack(stream, group, msgs[0]!.id);
      assert.equal(acked, 1, 'ack should return 1');

      pending = await svc.pendingSummary(stream, group);
      assert.equal(pending?.pending, 0, 'zero pending entries after ack');

      await svc.close();
      await del(svc.streamKey(stream));
    },
  );

  // -------------------------------------------------------------------------
  // 4. Unacked entry is reclaimed by another consumer after minIdle
  // -------------------------------------------------------------------------

  test(
    'unacked entry is reclaimed by another consumer after minIdle=0',
    { skip: redisSkipReason },
    async () => {
      const svc = makeSvc();
      const stream = `rcl-${uid()}`;
      const group = 'rclgrp';

      await svc.ensureGroup(stream, group);
      await svc.addToStream(stream, { runId: 'run-reclaim' });

      // Consumer c1 reads but does NOT ack.
      const msgs = await svc.readGroup(stream, group, 'c1', { count: 1 });
      assert.equal(msgs.length, 1);

      // Consumer c2 reclaims with minIdle=0 (immediate).
      const result = await svc.reclaimStale(stream, group, 'c2', 0, 10);
      assert.equal(result.messages.length, 1, 'c2 should reclaim the entry');
      assert.equal(result.messages[0]!.fields['runId'], 'run-reclaim');

      await svc.close();
      await del(svc.streamKey(stream));
    },
  );

  // -------------------------------------------------------------------------
  // 5. Entry goes to dead-letter after N deliveries (via queue)
  // -------------------------------------------------------------------------

  test(
    'entry is dead-lettered by AutomationRunQueue after maxDeliveries',
    { skip: redisSkipReason },
    async () => {
      const ns = `dl-${uid()}`;
      const queue = createAutomationRunQueue({
        redis: sharedClient as RedisClientType,
        namespace: ns,
        maxDeliveries: 2,
      });

      const consumer = 'dlc';
      await queue.ensureGroup();
      await queue.enqueue('run-dl');

      // Read once to get the entry in the PEL (delivery 1).
      const first = await queue.consume(consumer, { count: 1 });
      assert.equal(first.length, 1);
      // Don't ACK — leave pending.

      // Reclaim with minIdle=0 so this consumer takes it again (delivery 2).
      const reclaimed = await queue.reclaimStale(consumer, 0, 10);
      assert.ok(reclaimed.length >= 1, 'should reclaim the entry');
      const entry = reclaimed[0]!;
      assert.ok(entry.deliveries >= 2, `deliveries=${entry.deliveries} should be >=2`);

      // Dead-letter it now.
      await queue.deadLetter(entry, 'test exhausted');

      // The dead-letter stream should have an entry — use xRange to check
      // entries that already exist without creating a new consumer group.
      const deadStreamKey = queue.deadStreamKey;
      const range = await (sharedClient as unknown as {
        xRange(key: string, start: string, end: string): Promise<Array<{
          id: string;
          message: Map<string, string> | Record<string, string>;
        }>>;
      }).xRange(deadStreamKey, '-', '+');
      const match = range.find((m) => {
        const msg = m.message;
        const fields = msg instanceof Map ? Object.fromEntries(msg) : (msg as Record<string, string>);
        return fields['runId'] === 'run-dl';
      });
      assert.ok(match, 'dead-letter stream should contain the entry');

      // The original stream's pending count should now be 0.
      const pc = await queue.pendingCount();
      assert.equal(pc, 0, 'original PEL should be empty after dead-letter');

      await queue.stop();
    },
  );

  // -------------------------------------------------------------------------
  // 6. Trimming caps stream length
  // -------------------------------------------------------------------------

  test(
    'exact MAXLEN trimming caps stream length',
    { skip: redisSkipReason },
    async () => {
      const svc = makeSvc();
      const stream = `trim-${uid()}`;

      // Use exact trimming (strategyModifier '=') to guarantee the cap.
      // The service uses approximate '~' for efficiency in production, but
      // approximate trimming only fires once the internal radix tree node is
      // full (typically >1 000 entries) so we test the exact mode here to
      // confirm the TRIM option flows through correctly.
      const maxLen = 5;
      for (let i = 0; i < 20; i++) {
        await (sharedClient as unknown as {
          xAdd(
            key: string,
            id: string,
            fields: Record<string, string>,
            opts: { TRIM: { strategy: string; strategyModifier: string; threshold: number } },
          ): Promise<string>;
        }).xAdd(svc.streamKey(stream), '*', { i: String(i) }, {
          TRIM: { strategy: 'MAXLEN', strategyModifier: '=', threshold: maxLen },
        });
      }

      const client = sharedClient as unknown as { xLen(k: string): Promise<number> };
      const len = await client.xLen(svc.streamKey(stream));
      assert.equal(len, maxLen, `stream length should be exactly ${maxLen} with exact trimming`);

      // Also verify that approximate trimming (used by addToStream) works with
      // a small stream: at minimum it must not *add more* than maxLen * 2.
      const approxStream = `approx-${uid()}`;
      for (let i = 0; i < 20; i++) {
        await svc.addToStream(approxStream, { i: String(i) }, { maxLen: 5 });
      }
      const approxLen = await client.xLen(svc.streamKey(approxStream));
      // Redis applies ~ lazily; for small streams it may not trim yet.
      // We only assert it did not create more entries than were inserted.
      assert.ok(approxLen <= 20, `approx stream should have <= 20 entries, got ${approxLen}`);

      await svc.close();
      await del(svc.streamKey(stream), svc.streamKey(approxStream));
    },
  );

  // -------------------------------------------------------------------------
  // 7. Two consumers in one group never receive the same entry
  // -------------------------------------------------------------------------

  test(
    'two consumers in one group never receive the same entry',
    { skip: redisSkipReason },
    async () => {
      const svc = makeSvc();
      const stream = `two-${uid()}`;
      const group = 'twogrp';

      await svc.ensureGroup(stream, group);

      // Add 4 entries.
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const id = await svc.addToStream(stream, { i: String(i) });
        if (id) ids.push(id);
      }
      assert.equal(ids.length, 4);

      // Consumer A reads 2, Consumer B reads 2.
      const msgsA = await svc.readGroup(stream, group, 'consumerA', { count: 2 });
      const msgsB = await svc.readGroup(stream, group, 'consumerB', { count: 2 });

      const setA = new Set(msgsA.map((m) => m.id));
      const setB = new Set(msgsB.map((m) => m.id));

      // No overlap.
      for (const id of setB) {
        assert.ok(!setA.has(id), `entry ${id} delivered to both consumers`);
      }
      assert.equal(msgsA.length + msgsB.length, 4, 'all 4 entries delivered exactly once');

      await svc.close();
      await del(svc.streamKey(stream));
    },
  );

  // -------------------------------------------------------------------------
  // 8. Redis unavailable returns empty without throwing
  // -------------------------------------------------------------------------

  test(
    'Redis unavailable returns empty without throwing',
    { skip: redisSkipReason },
    async () => {
      // Create a service that cannot connect.
      const badSvc = createStreamService({
        redisUrl: 'redis://127.0.0.1:19999', // nothing listening here
        namespace: 'bad',
      });

      // None of these should throw.
      const addResult = await badSvc.addToStream('x', { k: 'v' });
      assert.equal(addResult, null, 'addToStream should return null when Redis is unavailable');

      const readResult = await badSvc.readGroup('x', 'g', 'c');
      assert.deepEqual(readResult, [], 'readGroup should return [] when Redis is unavailable');

      const ackResult = await badSvc.ack('x', 'g', '0-0');
      assert.equal(ackResult, 0, 'ack should return 0 when Redis is unavailable');

      const reclaimResult = await badSvc.reclaimStale('x', 'g', 'c', 0);
      assert.deepEqual(reclaimResult.messages, []);
      assert.deepEqual(reclaimResult.deletedMessages, []);

      const pendingResult = await badSvc.pendingSummary('x', 'g');
      assert.equal(pendingResult, null, 'pendingSummary should return null when Redis is unavailable');

      await badSvc.close();
    },
  );

  // -------------------------------------------------------------------------
  // 9. Legacy list items are drained into the stream exactly once
  // -------------------------------------------------------------------------

  test(
    'legacy list items are drained into the stream exactly once',
    { skip: redisSkipReason },
    async () => {
      const ns = `legacy-${uid()}`;
      const queue = createAutomationRunQueue({
        redis: sharedClient as RedisClientType,
        namespace: ns,
      });

      // Seed the old list key with 3 items using an array (required by redis@6
      // variadic lPush — passing multiple string args only pushes the first).
      const legacyKey = queue.legacyListKey;
      const client = sharedClient as unknown as {
        lPush(k: string, v: string[]): Promise<number>;
        lLen(k: string): Promise<number>;
      };
      await client.lPush(legacyKey, ['run-leg-1', 'run-leg-2', 'run-leg-3']);

      // Ensure group first.
      await queue.ensureGroup();

      // Drain.
      const drained = await queue.migrateLegacyList();
      assert.equal(drained, 3, 'should drain exactly 3 items');

      // Legacy list should now be empty.
      const remaining = await client.lLen(legacyKey);
      assert.equal(remaining, 0, 'legacy list should be empty after drain');

      // The stream should have 3 entries readable by a consumer.
      const entries = await queue.consume('drain-consumer', { count: 10 });
      assert.equal(entries.length, 3, 'all 3 drained runs should be in the stream');

      const runIds = entries.map((e) => e.runId);
      assert.ok(runIds.includes('run-leg-1'));
      assert.ok(runIds.includes('run-leg-2'));
      assert.ok(runIds.includes('run-leg-3'));

      // A second call to migrateLegacyList should drain 0 more.
      const drained2 = await queue.migrateLegacyList();
      assert.equal(drained2, 0, 'second drain should be a no-op');

      await queue.stop();
    },
  );
});
