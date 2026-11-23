import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { TaskStatus } from '@prisma/client';
import {
  SPRINT_BOARD_COLUMN_ORDER,
  calculateBurndown,
  evaluateScopeReconstructability,
  reconstructCompletedFinalScope,
  reconstructScopeAt,
} from '../src/modules/sprints/sprint-report';

describe('sprint report pure functions', () => {
  test('board columns cover all TaskStatus values in required order', () => {
    const required = [
      'ASSIGNED',
      'AWAITING_CLARIFICATION',
      'IN_PROGRESS',
      'SUBMITTED',
      'UNDER_REVIEW',
      'CHANGES_REQUESTED',
      'APPROVED',
    ];
    assert.deepEqual([...SPRINT_BOARD_COLUMN_ORDER], required);
    const all = Object.values(TaskStatus).sort();
    const cols = [...SPRINT_BOARD_COLUMN_ORDER].sort();
    assert.deepEqual(cols, all);
  });

  test('scope reconstruction: added, removed, carry-in, carry-out, legacy row, before epoch', () => {
    const epoch = '2026-11-23T18:52:26Z';
    const base = {
      sprintId: 's1',
      sprintCreatedAt: '2026-11-24T00:00:00.000Z',
      sprintStatus: 'ACTIVE' as const,
      events: [
        { action: 'sprint.task_added' as const, createdAt: '2026-11-24T01:00:00Z', sprintId: 's1', taskIds: ['t1', 't2'] },
        { action: 'sprint.task_removed' as const, createdAt: '2026-11-24T02:00:00Z', sprintId: 's1', taskIds: ['t2'] },
        { action: 'sprint.task_added' as const, createdAt: '2026-11-24T03:00:00Z', sprintId: 's1', taskIds: ['t3'] },
        { action: 'sprint.completed' as const, createdAt: '2026-11-24T04:00:00Z', sprintId: 's0', nextSprintId: 's1', carriedOverTaskIds: ['t4'], retainedTaskIds: ['r1'] },
      ],
    };
    const scope = reconstructScopeAt(base, '2026-11-24T05:00:00Z');
    assert.equal(scope.reconstructable, true);
    assert.deepEqual(scope.taskIds.sort(), ['t1', 't3', 't4'].sort());

    // carry-out / completed final scope
    const completed = {
      sprintId: 's1',
      sprintCreatedAt: '2026-11-24T00:00:00.000Z',
      sprintStatus: 'COMPLETED' as const,
      events: [
        { action: 'sprint.task_added' as const, createdAt: '2026-11-24T01:00:00Z', sprintId: 's1', taskIds: ['t1', 't2'] },
        { action: 'sprint.completed' as const, createdAt: '2026-11-25T00:00:00Z', sprintId: 's1', nextSprintId: null, carriedOverTaskIds: ['t2'], retainedTaskIds: ['t1'] },
      ],
    };
    const final = reconstructCompletedFinalScope(completed);
    assert.equal(final.reconstructable, true);
    assert.deepEqual(final.taskIds.sort(), ['t1', 't2'].sort());

    // legacy completion row without fields
    const legacy = {
      sprintId: 's1',
      sprintCreatedAt: '2026-11-24T00:00:00.000Z',
      sprintStatus: 'COMPLETED' as const,
      events: [{ action: 'sprint.completed' as const, createdAt: '2026-11-25T00:00:00Z', sprintId: 's1', nextSprintId: null }],
    };
    const legacyCheck = evaluateScopeReconstructability(legacy);
    assert.equal(legacyCheck.reconstructable, false);
    assert.equal(legacyCheck.reason, 'COMPLETED_SPRINT_MISSING_COMPLETION_TASK_IDS');

    // created before epoch
    const before = evaluateScopeReconstructability({ ...base, sprintCreatedAt: '2026-11-23T18:52:25Z' });
    assert.equal(before.reconstructable, false);
    assert.equal(before.reason, 'SPRINT_CREATED_BEFORE_AUDIT_TRAIL_EPOCH');
    assert.ok(epoch);
  });

  test('burndown math: empty, zero completed, same-day, added mid-sprint, removed mid-sprint, reopened, no end date', () => {
    const empty = calculateBurndown({
      sprint: { id: 's1', status: 'ACTIVE', startDate: '2026-11-24T00:00:00Z', endDate: '2026-11-26T00:00:00Z', createdAt: '2026-11-24T00:00:00Z', completedAt: null },
      scope: { reconstructable: true, taskIds: [] },
      completionEvents: [],
      now: '2026-11-25T00:00:00Z',
    });
    assert.equal(empty.totals.initialScope, 0);
    assert.equal(empty.series.length, 2); // start through today

    const zero = calculateBurndown({
      sprint: { id: 's1', status: 'ACTIVE', startDate: '2026-11-24T00:00:00Z', endDate: '2026-11-26T00:00:00Z', createdAt: '2026-11-24T00:00:00Z', completedAt: null },
      scope: { reconstructable: true, taskIds: ['t1', 't2'] },
      completionEvents: [],
      now: '2026-11-24T00:00:00Z',
    });
    assert.equal(zero.series[0]?.remaining, 2);
    assert.equal(zero.series[0]?.completed, 0);

    const sameDay = calculateBurndown({
      sprint: { id: 's1', status: 'COMPLETED', startDate: '2026-11-24T00:00:00Z', endDate: '2026-11-24T00:00:00Z', createdAt: '2026-11-24T00:00:00Z', completedAt: '2026-11-24T12:00:00Z' },
      scope: { reconstructable: true, taskIds: ['t1'] },
      completionEvents: [{ taskId: 't1', completedAt: '2026-11-24T10:00:00Z' }],
      now: '2026-11-25T00:00:00Z',
    });
    assert.equal(sameDay.series.length, 1);
    assert.equal(sameDay.series[0]?.ideal, 1); // single-day series ideal = initialScope
    assert.equal(sameDay.series[0]?.completed, 1);

    // added mid-sprint: scope includes t3, completion later
    const added = calculateBurndown({
      sprint: { id: 's1', status: 'ACTIVE', startDate: '2026-11-24T00:00:00Z', endDate: '2026-11-26T00:00:00Z', createdAt: '2026-11-24T00:00:00Z', completedAt: null },
      scope: { reconstructable: true, taskIds: ['t1', 't3'] },
      completionEvents: [{ taskId: 't3', completedAt: '2026-11-25T10:00:00Z' }],
      now: '2026-11-25T00:00:00Z',
    });
    assert.equal(added.series[0]?.remaining, 2);
    assert.equal(added.series[1]?.remaining, 1);

    // removed mid-sprint represented by scope no longer containing t2
    const removed = calculateBurndown({
      sprint: { id: 's1', status: 'ACTIVE', startDate: '2026-11-24T00:00:00Z', endDate: '2026-11-26T00:00:00Z', createdAt: '2026-11-24T00:00:00Z', completedAt: null },
      scope: { reconstructable: true, taskIds: ['t1'] },
      completionEvents: [],
      now: '2026-11-25T00:00:00Z',
    });
    assert.equal(removed.totals.initialScope, 1);

    // reopened: only latest completion event provided (per done time rule), so no completion counted
    const reopened = calculateBurndown({
      sprint: { id: 's1', status: 'ACTIVE', startDate: '2026-11-24T00:00:00Z', endDate: '2026-11-26T00:00:00Z', createdAt: '2026-11-24T00:00:00Z', completedAt: null },
      scope: { reconstructable: true, taskIds: ['t1'] },
      completionEvents: [], // latest completion missing because reopened
      now: '2026-11-25T00:00:00Z',
    });
    assert.equal(reopened.series[1]?.remaining, 1);

    // no end date: ACTIVE runs start through today, ideal uses totalDays
    const noEnd = calculateBurndown({
      sprint: { id: 's1', status: 'ACTIVE', startDate: '2026-11-24T00:00:00Z', endDate: null, createdAt: '2026-11-24T00:00:00Z', completedAt: null },
      scope: { reconstructable: true, taskIds: ['t1', 't2'] },
      completionEvents: [],
      now: '2026-11-26T00:00:00Z',
    });
    assert.equal(noEnd.series.length, 3);
    assert.equal(noEnd.series[2]?.ideal, 0);
  });
});
