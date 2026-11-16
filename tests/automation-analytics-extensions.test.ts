import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomationSchema } from '../src/modules/automation/automation.service';
import { analyticsScopedQuerySchema } from '../src/modules/analytics/analytics.schemas';

test('automation schema accepts requested triggers', () => {
  const triggers = [
    'EVENT_TASK_STATUS_CHANGED',
    'EVENT_TASK_ASSIGNED',
    'EVENT_TASK_DUE_DATE_PASSED',
    'EVENT_FORM_SUBMITTED',
  ] as const;
  for (const trigger of triggers) {
    const res = createAutomationSchema.safeParse({
      name: 'Auto',
      trigger,
      action: 'SEND_NOTIFICATION',
      actionConfig: { userId: '00000000-0000-4000-8000-000000000001', title: 'Hi' },
    });
    assert.equal(res.success, true, `trigger ${trigger} should be accepted`);
  }
});

test('automation schema accepts requested actions with valid configs', () => {
  const base = { name: 'Auto', trigger: 'EVENT_TASK_STATUS_CHANGED' as const };
  assert.equal(
    createAutomationSchema.safeParse({
      ...base,
      action: 'SET_FIELD',
      actionConfig: { taskId: '00000000-0000-4000-8000-000000000001', field: 'status', value: 'IN_PROGRESS' },
    }).success,
    true,
  );
  assert.equal(
    createAutomationSchema.safeParse({
      ...base,
      action: 'ASSIGN',
      actionConfig: { taskId: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002' },
    }).success,
    true,
  );
  assert.equal(
    createAutomationSchema.safeParse({
      ...base,
      action: 'POST_MESSAGE',
      actionConfig: { channelId: '00000000-0000-4000-8000-000000000003', body: 'Hello' },
    }).success,
    true,
  );
});

test('automation schema rejects invalid action configs for requested actions', () => {
  const base = { name: 'Auto', trigger: 'EVENT_TASK_STATUS_CHANGED' as const };
  assert.equal(createAutomationSchema.safeParse({ ...base, action: 'SET_FIELD', actionConfig: { field: 'status' } }).success, false);
  assert.equal(createAutomationSchema.safeParse({ ...base, action: 'ASSIGN', actionConfig: { taskId: 'x' } }).success, false);
  assert.equal(createAutomationSchema.safeParse({ ...base, action: 'POST_MESSAGE', actionConfig: { channelId: 'x' } }).success, false);
});

test('analytics scoped query schema requires workspaceId and accepts project scoping', () => {
  assert.equal(
    analyticsScopedQuerySchema.safeParse({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      projectId: '00000000-0000-4000-8000-000000000002',
      range: '30d',
    }).success,
    true,
  );
  assert.equal(analyticsScopedQuerySchema.safeParse({ range: '30d' }).success, false);
});
