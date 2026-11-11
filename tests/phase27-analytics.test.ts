import assert from 'node:assert/strict';
import test from 'node:test';
import { analyticsQuerySchema } from '../src/modules/analytics/analytics.schemas';

/**
 * Phase 27 unit tests.
 *
 * These cover the analytics request schema validation without touching
 * PostgreSQL or Redis.
 */

test('analytics query schema accepts a workspace-scoped 30d range', () => {
  assert.equal(
    analyticsQuerySchema.safeParse({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      range: '30d',
    }).success,
    true,
  );
});

test('analytics query schema accepts a custom date range', () => {
  assert.equal(
    analyticsQuerySchema.safeParse({
      range: 'custom',
      startDate: '2026-10-01T00:00:00.000Z',
      endDate: '2026-10-31T23:59:59.999Z',
    }).success,
    true,
  );
});

test('analytics query schema rejects an invalid range', () => {
  assert.equal(analyticsQuerySchema.safeParse({ range: '365d' }).success, false);
});

test('analytics query schema rejects a non-UUID workspaceId', () => {
  assert.equal(analyticsQuerySchema.safeParse({ workspaceId: 'not-a-uuid' }).success, false);
});

test('analytics query schema defaults range to 30d', () => {
  const result = analyticsQuerySchema.safeParse({});
  assert.equal(result.success, true);
  assert.equal((result.data as { range: string }).range, '30d');
});
