import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCOUNT_DELETION_GRACE_PERIOD_MS,
  scheduledAccountDeletionAt,
} from '../src/modules/auth/account-deletion.service';

test('account deletion schedules exactly 30 days after the request time', () => {
  const requestedAt = new Date('2026-11-03T12:34:56.789Z');

  assert.equal(ACCOUNT_DELETION_GRACE_PERIOD_MS, 30 * 24 * 60 * 60 * 1_000);
  assert.equal(scheduledAccountDeletionAt(requestedAt).toISOString(), '2026-12-03T12:34:56.789Z');
});
