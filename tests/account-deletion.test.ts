import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduledAccountDeletionAt } from '../src/modules/auth/account-deletion.service';

test('account deletion cleanup is scheduled after the 30-day recovery period', () => {
  const requestedAt = new Date('2026-11-03T12:34:56.789Z');

  assert.equal(scheduledAccountDeletionAt(requestedAt).toISOString(), '2026-12-03T12:34:56.789Z');
});
