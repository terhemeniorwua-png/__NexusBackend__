import assert from 'node:assert/strict';
import test from 'node:test';
import { isSecurityEvent, SecurityAuditAction } from '../src/services/audit';

/**
 * Phase 26 unit tests.
 *
 * These cover audit security event classification without touching PostgreSQL.
 */

test('security event classification flags membership and ownership changes', () => {
  assert.equal(isSecurityEvent('workspace.member_role_changed'), true);
  assert.equal(isSecurityEvent('workspace.member_removed'), true);
  assert.equal(isSecurityEvent('workspace.ownership_transferred'), true);
  assert.equal(isSecurityEvent('workspace.member_suspended'), true);
  assert.equal(isSecurityEvent('workspace.member_restored'), true);
});

test('security event classification flags invitation and join-code changes', () => {
  assert.equal(isSecurityEvent('workspace.invitation_revoked'), true);
  assert.equal(isSecurityEvent('workspace.join_code_rotated'), true);
  assert.equal(isSecurityEvent('workspace.join_code_disabled'), true);
  assert.equal(isSecurityEvent('workspace.join_request_rejected'), true);
  assert.equal(isSecurityEvent('workspace.join_request_withdrawn'), true);
});

test('security event classification flags workspace deletion and AI mutations', () => {
  assert.equal(isSecurityEvent('workspace.archived'), true);
  assert.equal(isSecurityEvent('workspace.deleted'), true);
  assert.equal(isSecurityEvent('ai.action_approved'), true);
  assert.equal(isSecurityEvent('ai.action_executed'), true);
});

test('security event classification does not flag routine events', () => {
  assert.equal(isSecurityEvent('workspace.created'), false);
  assert.equal(isSecurityEvent('workspace.updated'), false);
  assert.equal(isSecurityEvent('task.created'), false);
  assert.equal(isSecurityEvent('task.comment_created'), false);
  assert.equal(isSecurityEvent('message.created'), false);
  assert.equal(isSecurityEvent('ai.action_proposed'), false);
  assert.equal(isSecurityEvent('ai.action_rejected'), false);
  assert.equal(isSecurityEvent('unknown.action'), false);
});

test('SecurityAuditAction export lists every classified action', () => {
  const expected = [
    'workspace.ownership_transferred',
    'workspace.archived',
    'workspace.deleted',
    'workspace.member_role_changed',
    'workspace.member_removed',
    'workspace.member_suspended',
    'workspace.member_restored',
    'workspace.invitation_revoked',
    'workspace.join_request_rejected',
    'workspace.join_request_withdrawn',
    'workspace.join_code_rotated',
    'workspace.join_code_disabled',
    'institution.department_member_removed',
    'ai.action_approved',
    'ai.action_executed',
  ];
  const actual = Object.values(SecurityAuditAction) as string[];
  assert.equal(actual.length, expected.length);
  for (const value of expected) {
    assert.equal(actual.includes(value), true, `${value} is missing from SecurityAuditAction`);
  }
});
