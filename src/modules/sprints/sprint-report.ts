import type { TaskStatus } from '@prisma/client';
import { AUDIT_TRAIL_EPOCH } from './sprint-report.constants';

export const SPRINT_BOARD_COLUMN_ORDER: readonly TaskStatus[] = [
  'ASSIGNED',
  'AWAITING_CLARIFICATION',
  'IN_PROGRESS',
  'SUBMITTED',
  'UNDER_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
] as const;

export const DONE_STATUS: TaskStatus = 'APPROVED';

export interface SprintAuditEvent {
  action: 'sprint.task_added' | 'sprint.task_removed' | 'sprint.completed';
  createdAt: Date | string;
  sprintId: string; // target sprint of the audit row
  taskIds?: string[];
  carriedOverTaskIds?: string[];
  retainedTaskIds?: string[];
  nextSprintId?: string | null;
}

export interface SprintScopeInput {
  sprintId: string;
  sprintCreatedAt: Date | string;
  sprintStatus: 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
  events: SprintAuditEvent[]; // all events relevant to this sprint: added/removed for sprintId, own completion, and completion rows where nextSprintId==sprintId
}

export interface ScopeReconstruction {
  reconstructable: boolean;
  reason?: string;
  taskIds: string[];
}

function toTime(value: Date | string): number {
  const t = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function asIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

function hasCompletionIds(event: SprintAuditEvent): boolean {
  return Array.isArray(event.carriedOverTaskIds) && Array.isArray(event.retainedTaskIds);
}

export function getOwnCompletionEvent(input: SprintScopeInput): SprintAuditEvent | undefined {
  return input.events.find((e) => e.action === 'sprint.completed' && e.sprintId === input.sprintId);
}

export function getCarryInCompletionEvents(input: SprintScopeInput): SprintAuditEvent[] {
  return input.events.filter(
    (e) => e.action === 'sprint.completed' && e.sprintId !== input.sprintId && e.nextSprintId === input.sprintId,
  );
}

export function evaluateScopeReconstructability(input: SprintScopeInput): { reconstructable: boolean; reason?: string } {
  if (toTime(input.sprintCreatedAt) < toTime(AUDIT_TRAIL_EPOCH)) {
    return { reconstructable: false, reason: 'SPRINT_CREATED_BEFORE_AUDIT_TRAIL_EPOCH' };
  }

  const ownCompletion = getOwnCompletionEvent(input);
  if (input.sprintStatus === 'COMPLETED') {
    if (!ownCompletion) {
      return { reconstructable: false, reason: 'COMPLETED_SPRINT_MISSING_COMPLETION_AUDIT' };
    }
    if (!hasCompletionIds(ownCompletion)) {
      return { reconstructable: false, reason: 'COMPLETED_SPRINT_MISSING_COMPLETION_TASK_IDS' };
    }
  }

  for (const carryIn of getCarryInCompletionEvents(input)) {
    if (!hasCompletionIds(carryIn)) {
      return { reconstructable: false, reason: 'CARRY_IN_COMPLETION_MISSING_TASK_IDS' };
    }
  }

  return { reconstructable: true };
}

export function reconstructCompletedFinalScope(input: SprintScopeInput): ScopeReconstruction {
  const check = evaluateScopeReconstructability(input);
  if (!check.reconstructable) return { reconstructable: false, reason: check.reason, taskIds: [] };
  if (input.sprintStatus !== 'COMPLETED') {
    return { reconstructable: false, reason: 'SPRINT_NOT_COMPLETED', taskIds: [] };
  }
  const own = getOwnCompletionEvent(input)!;
  const taskIds = [...new Set([...asIds(own.retainedTaskIds), ...asIds(own.carriedOverTaskIds)])];
  return { reconstructable: true, taskIds };
}

export function reconstructScopeAt(input: SprintScopeInput, at: Date | string): ScopeReconstruction {
  const check = evaluateScopeReconstructability(input);
  if (!check.reconstructable) return { reconstructable: false, reason: check.reason, taskIds: [] };

  const atMs = toTime(at);
  if (input.sprintStatus === 'COMPLETED') {
    const own = getOwnCompletionEvent(input)!;
    if (atMs >= toTime(own.createdAt)) {
      return reconstructCompletedFinalScope(input);
    }
    // before completion, replay adds/carry-ins/removes; completion move-out hasn't happened yet
  }

  const set = new Set<string>();

  const adds = input.events
    .filter((e) => e.action === 'sprint.task_added' && e.sprintId === input.sprintId && toTime(e.createdAt) <= atMs)
    .sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt));
  for (const e of adds) for (const id of asIds(e.taskIds)) set.add(id);

  const carryIns = getCarryInCompletionEvents(input)
    .filter((e) => toTime(e.createdAt) <= atMs)
    .sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt));
  for (const e of carryIns) for (const id of asIds(e.carriedOverTaskIds)) set.add(id);

  const removes = input.events
    .filter((e) => e.action === 'sprint.task_removed' && e.sprintId === input.sprintId && toTime(e.createdAt) <= atMs)
    .sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt));
  for (const e of removes) for (const id of asIds(e.taskIds)) set.delete(id);

  return { reconstructable: true, taskIds: [...set] };
}

export interface BurndownCompletionEvent {
  taskId: string;
  completedAt: Date | string; // resolved done time
}

export interface BurndownInput {
  sprint: {
    id: string;
    status: 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'ARCHIVED';
    startDate: Date | string | null;
    endDate: Date | string | null;
    createdAt: Date | string;
    completedAt: Date | string | null;
  };
  scope: ScopeReconstruction;
  completionEvents: BurndownCompletionEvent[];
  now?: Date | string;
}

export interface BurndownPoint {
  date: string; // YYYY-MM-DD UTC
  remaining: number;
  ideal: number;
  scope: number;
  completed: number;
}

export interface BurndownResult {
  metric: 'TASK_COUNT';
  startAt: string;
  endAt: string;
  series: BurndownPoint[];
  totals: { initialScope: number; completed: number; remaining: number };
}

function utcDayStart(value: Date | string): Date {
  const d = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function toIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addUtcDays(d: Date, days: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days));
}

function diffUtcDays(a: Date, b: Date): number {
  const ms = utcDayStart(b).getTime() - utcDayStart(a).getTime();
  return Math.round(ms / 86400000);
}

export function calculateBurndown(input: BurndownInput): BurndownResult {
  const now = utcDayStart(input.now ?? new Date());
  const start = utcDayStart(input.sprint.startDate ?? input.sprint.createdAt);
  const completedDay = input.sprint.completedAt ? utcDayStart(input.sprint.completedAt) : null;
  const endDateDay = input.sprint.endDate ? utcDayStart(input.sprint.endDate) : null;

  const scopeIds = new Set(input.scope.taskIds);
  const initialScope = scopeIds.size;

  if (input.sprint.status === 'PLANNED') {
    return {
      metric: 'TASK_COUNT',
      startAt: start.toISOString(),
      endAt: start.toISOString(),
      series: [],
      totals: { initialScope, completed: 0, remaining: initialScope },
    };
  }

  let seriesEnd: Date;
  if (input.sprint.status === 'COMPLETED') {
    seriesEnd = completedDay ?? endDateDay ?? start;
  } else {
    // ACTIVE or other non-planned, non-completed treated as active-like
    seriesEnd = now;
  }
  if (seriesEnd.getTime() < start.getTime()) seriesEnd = start;

  const totalDays = diffUtcDays(start, seriesEnd); // 0 => single day
  const idealDenomDays = endDateDay ? Math.max(0, diffUtcDays(start, endDateDay)) : totalDays;
  const series: BurndownPoint[] = [];

  for (let i = 0; i <= totalDays; i++) {
    const day = addUtcDays(start, i);
    const dayEndMs = addUtcDays(day, 1).getTime() - 1;
    let completed = 0;
    for (const ev of input.completionEvents) {
      if (!scopeIds.has(ev.taskId)) continue;
      const t = toTime(ev.completedAt);
      if (Number.isFinite(t) && t <= dayEndMs) completed++;
    }
    if (completed > initialScope) completed = initialScope;
    const remaining = initialScope - completed;

    let ideal = initialScope;
    if (totalDays === 0) {
      ideal = initialScope;
    } else if (idealDenomDays <= 0) {
      ideal = 0;
    } else {
      const idealRemaining = initialScope * (1 - i / idealDenomDays);
      ideal = Math.max(0, Math.round(idealRemaining));
    }
    // ACTIVE ideal clamps to 0 after endDate
    if (input.sprint.status === 'ACTIVE' && endDateDay && day.getTime() > endDateDay.getTime()) {
      ideal = 0;
    }

    series.push({
      date: toIsoDay(day),
      remaining,
      ideal,
      scope: initialScope,
      completed,
    });
  }

  const last = series[series.length - 1];
  return {
    metric: 'TASK_COUNT',
    startAt: start.toISOString(),
    endAt: seriesEnd.toISOString(),
    series,
    totals: {
      initialScope,
      completed: last?.completed ?? 0,
      remaining: last?.remaining ?? initialScope,
    },
  };
}
