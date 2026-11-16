import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import {
  assertDependencyDateConsistency,
  assertDependencyPairDateConsistency,
} from '../src/modules/tasks/task.service';
import {
  createCustomFieldSchema,
  createProjectTemplateSchema,
  createSavedViewSchema,
  createTaskTemplateSchema,
  updateSavedViewSchema,
  upsertRecurrenceSchema,
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

test('saved view schema accepts versioned filters/sort/group config and rejects unknown keys', () => {
  const res = createSavedViewSchema.safeParse({
    name: 'My view',
    isShared: true,
    config: {
      version: 1,
      filters: { status: ['IN_PROGRESS'], assigneeIds: ['u1'] },
      sort: { by: 'dueDate', order: 'asc' },
      group: { by: 'status' },
    },
  });
  assert.equal(res.success, true);
  if (res.success) {
    assert.equal(res.data.isShared, true);
    assert.equal(res.data.config.version, 1);
    assert.deepEqual(res.data.config.filters, { status: ['IN_PROGRESS'], assigneeIds: ['u1'] });
  }

  const unknown = createSavedViewSchema.safeParse({
    name: 'Bad',
    config: { version: 1, filters: {}, sort: null, group: null, extra: true },
  });
  assert.equal(unknown.success, false);
});

test('saved view config enforces size limit', () => {
  const huge = 'x'.repeat(40 * 1024);
  const res = createSavedViewSchema.safeParse({
    name: 'Huge',
    config: { version: 1, filters: { blob: huge }, sort: null, group: null },
  });
  assert.equal(res.success, false);
});

test('saved view update schema requires version when config provided and rejects unknown keys', () => {
  const ok = updateSavedViewSchema.safeParse({
    config: { version: 1, filters: { status: ['DONE'] } },
  });
  assert.equal(ok.success, true);
  const missingVersion = updateSavedViewSchema.safeParse({
    config: { filters: { status: ['DONE'] } } as unknown,
  });
  assert.equal(missingVersion.success, false);
});

test('recurrence schema validates frequency and bounds', () => {
  assert.equal(upsertRecurrenceSchema.safeParse({ frequency: 'DAILY', interval: 1 }).success, true);
  assert.equal(upsertRecurrenceSchema.safeParse({ frequency: 'WEEKLY', daysOfWeek: [1, 3, 5] }).success, true);
  assert.equal(upsertRecurrenceSchema.safeParse({ frequency: 'HOURLY' }).success, false);
  assert.equal(upsertRecurrenceSchema.safeParse({ frequency: 'DAILY', interval: 0 }).success, false);
});

test('task template blueprint requires version, rejects unknown keys, and enforces size limit', () => {
  const ok = createTaskTemplateSchema.safeParse({
    name: 'Bug fix',
    data: { version: 1, title: 'Fix bug', priority: 'HIGH', labels: ['bug'] },
  });
  assert.equal(ok.success, true);

  const unknown = createTaskTemplateSchema.safeParse({
    name: 'Bad',
    data: { version: 1, mystery: true } as unknown,
  });
  assert.equal(unknown.success, false);

  const huge = createTaskTemplateSchema.safeParse({
    name: 'Huge',
    data: { version: 1, description: 'x'.repeat(70 * 1024) },
  });
  assert.equal(huge.success, false);

  const defaulted = createTaskTemplateSchema.safeParse({ name: 'Default' });
  assert.equal(defaulted.success, true);
  if (defaulted.success) assert.equal((defaulted.data.data as { version: number }).version, 1);
});

test('project template blueprint requires version, rejects unknown keys, and enforces size limit', () => {
  const ok = createProjectTemplateSchema.safeParse({
    name: 'Sprint',
    data: {
      version: 1,
      visibility: 'WORKSPACE',
      tasks: [{ title: 'Plan', priority: 'MEDIUM' }],
      customFields: [{ name: 'Estimate', type: 'NUMBER' }],
    },
  });
  assert.equal(ok.success, true);

  const unknown = createProjectTemplateSchema.safeParse({
    name: 'Bad',
    data: { version: 1, nope: 1 } as unknown,
  });
  assert.equal(unknown.success, false);

  const huge = createProjectTemplateSchema.safeParse({
    name: 'Huge',
    data: { version: 1, description: 'x'.repeat(70 * 1024) },
  });
  assert.equal(huge.success, false);
});

// ---------------------------------------------------------------------------
// Dependency-aware date validation
// ---------------------------------------------------------------------------

test('dependency pair date validation rejects when dependent task starts before dependency ends', async () => {
  const prisma = {
    task: {
      findFirst: async ({ where }: { where?: { id?: string } }) => {
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
      findFirst: async ({ where }: { where?: { id?: string } }) => {
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
        dependencies: [],
        blockers: [
          { task: { id: 't3', key: 'P-3', startDate: new Date('2026-01-12T00:00:00.000Z'), dueDate: new Date('2026-01-13T00:00:00.000Z'), deletedAt: null } },
        ],
      }),
    },
  } as unknown as PrismaClient;

  await assert.rejects(
    assertDependencyDateConsistency(prisma, 'p1', 't1', { dueDate: '2026-01-15T00:00:00.000Z' }),
    (error: unknown) => (error as { code?: string }).code === 'TASK_DATE_CONFLICT',
  );
});
