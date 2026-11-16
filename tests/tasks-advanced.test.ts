import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import {
  assertDependencyDateConsistency,
  assertDependencyPairDateConsistency,
} from '../src/modules/tasks/task.service';
import {
  createCustomFieldSchema,
  createSavedViewSchema,
  upsertRecurrenceSchema,
  createTaskTemplateSchema,
  createProjectTemplateSchema,
} from '../src/modules/tasks/task-advanced.schemas';

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

test('custom field schema requires options for select/multi-select types', () => {
  const select = createCustomFieldSchema.safeParse({ name: 'Priority', type: 'SELECT' });
  assert.equal(select.success, false);
  const multi = createCustomFieldSchema.safeParse({ name: 'Tags', type: 'MULTI_SELECT', options: [] });
  assert.equal(multi.success, false);
  const ok = createCustomFieldSchema.safeParse({
    name: 'Environment',
    type: 'SELECT',
    options: [
      { value: 'dev', label: 'Dev' },
      { value: 'prod', label: 'Prod' },
    ],
  });
  assert.equal(ok.success, true);
});

test('custom field schema rejects duplicate option values', () => {
  const res = createCustomFieldSchema.safeParse({
    name: 'Stage',
    type: 'MULTI_SELECT',
    options: [
      { value: 'a', label: 'A' },
      { value: 'a', label: 'A2' },
    ],
  });
  assert.equal(res.success, false);
});

test('saved view schema accepts filters/sort/group config', () => {
  const res = createSavedViewSchema.safeParse({
    name: 'My view',
    isShared: true,
    config: {
      filters: { status: ['IN_PROGRESS'], assigneeIds: ['u1'] },
      sort: { by: 'dueDate', order: 'asc' },
      group: { by: 'status' },
    },
  });
  assert.equal(res.success, true);
  if (res.success) {
    assert.equal(res.data.isShared, true);
    assert.deepEqual(res.data.config.filters, { status: ['IN_PROGRESS'], assigneeIds: ['u1'] });
  }
});

test('recurrence schema validates frequency and bounds', () => {
  assert.equal(upsertRecurrenceSchema.safeParse({ frequency: 'DAILY', interval: 1 }).success, true);
  assert.equal(upsertRecurrenceSchema.safeParse({ frequency: 'WEEKLY', daysOfWeek: [1, 3, 5] }).success, true);
  assert.equal(upsertRecurrenceSchema.safeParse({ frequency: 'HOURLY' }).success, false);
  assert.equal(upsertRecurrenceSchema.safeParse({ frequency: 'DAILY', interval: 0 }).success, false);
});

test('task/project template schemas accept blueprint data', () => {
  const taskTpl = createTaskTemplateSchema.safeParse({ name: 'Bug fix', data: { title: 'Fix bug', priority: 'HIGH' } });
  assert.equal(taskTpl.success, true);
  const projTpl = createProjectTemplateSchema.safeParse({ name: 'Sprint', data: { tasks: [{ title: 'Plan' }] } });
  assert.equal(projTpl.success, true);
});

// ---------------------------------------------------------------------------
// Dependency-aware date validation
// ---------------------------------------------------------------------------

test('dependency pair date validation rejects when dependent task starts before dependency ends', async () => {
  const prisma = {
    task: {
      findFirst: async ({ where }: any) => {
        if (where?.id === 't1') return { id: 't1', key: 'P-1', startDate: new Date('2026-01-10T00:00:00.000Z'), dueDate: new Date('2026-01-20T00:00:00.000Z'), deletedAt: null };
        if (where?.id === 't2') return { id: 't2', key: 'P-2', startDate: new Date('2026-01-01T00:00:00.000Z'), dueDate: new Date('2026-01-15T00:00:00.000Z'), deletedAt: null };
        return null;
      },
    },
  } as unknown as PrismaClient;

  await assert.rejects(
    assertDependencyPairDateConsistency(prisma, 'p1', 't1', 't2'),
    (error: unknown) => (error as { code?: string }).code === 'TASK_DATE_CONFLICT',
  );
});

test('dependency pair date validation allows consistent dates', async () => {
  const prisma = {
    task: {
      findFirst: async ({ where }: any) => {
        if (where?.id === 't1') return { id: 't1', key: 'P-1', startDate: new Date('2026-01-20T00:00:00.000Z'), dueDate: new Date('2026-01-25T00:00:00.000Z'), deletedAt: null };
        if (where?.id === 't2') return { id: 't2', key: 'P-2', startDate: new Date('2026-01-01T00:00:00.000Z'), dueDate: new Date('2026-01-15T00:00:00.000Z'), deletedAt: null };
        return null;
      },
    },
  } as unknown as PrismaClient;

  await assert.doesNotReject(assertDependencyPairDateConsistency(prisma, 'p1', 't1', 't2'));
});

test('dependency-aware date validation rejects moving a task to end after a dependent starts', async () => {
  const prisma = {
    task: {
      findFirst: async () => ({
        id: 't1',
        key: 'P-1',
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        dueDate: new Date('2026-01-10T00:00:00.000Z'),
        dependencies: { select: undefined } as any,
      }),
    },
  } as any;

  // simulate current task with dependents (tasks that depend on this task)
  prisma.task.findFirst = async () => ({
    id: 't1',
    key: 'P-1',
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    dueDate: new Date('2026-01-10T00:00:00.000Z'),
    dependencies: [],
    blockers: [
      { task: { id: 't3', key: 'P-3', startDate: new Date('2026-01-12T00:00:00.000Z'), dueDate: new Date('2026-01-13T00:00:00.000Z'), deletedAt: null } },
    ],
  });

  await assert.rejects(
    assertDependencyDateConsistency(prisma, 'p1', 't1', { dueDate: '2026-01-15T00:00:00.000Z' }),
    (error: unknown) => (error as { code?: string }).code === 'TASK_DATE_CONFLICT',
  );
});
