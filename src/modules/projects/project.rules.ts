import type { ProjectStatus } from '@prisma/client';

/**
 * Pure project rules.
 *
 * These functions do not touch the database so they can be unit tested in
 * isolation. The service calls them before writing a change.
 */

// ---------------------------------------------------------------------------
// Project keys
// ---------------------------------------------------------------------------

const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

/**
 * Returns whether a value is a valid project key.
 *
 * A key is 2–10 characters, starts with a letter and contains only uppercase
 * letters and digits, so it reads well in task references such as `NEX-14`.
 */
export function isValidProjectKey(value: string): boolean {
  return PROJECT_KEY_PATTERN.test(value);
}

/**
 * Builds a readable key from a project name.
 *
 * The key is only a starting point: the service checks the workspace for a
 * collision and appends a numeric suffix when needed.
 */
export function projectKeyFromName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);

  if (base.length >= 2) {
    return base;
  }

  return `${base}PRJ`.slice(0, 6);
}

/**
 * Builds the candidate key for a collision attempt.
 *
 * The first attempt is the base itself; later attempts append a growing
 * number while keeping the key at most ten characters long.
 */
export function projectKeyCandidate(base: string, attempt: number): string {
  if (attempt <= 0) {
    return base.slice(0, 10);
  }

  const suffix = String(attempt + 1);
  const head = base.slice(0, Math.max(2, 10 - suffix.length));

  return `${head}${suffix}`.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

/**
 * The only status changes a normal update may perform.
 *
 * Archiving is a separate operation because it is an explicit lifecycle
 * action with its own permission and audit event. A project can be reopened
 * from `COMPLETED` or `ON_HOLD`, but an archived project is read-only.
 */
export const PROJECT_STATUS_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  PLANNING: ['ACTIVE'],
  ACTIVE: ['ON_HOLD', 'COMPLETED'],
  ON_HOLD: ['ACTIVE'],
  COMPLETED: ['ACTIVE'],
  ARCHIVED: [],
};

export function canTransitionProjectStatus(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_STATUS_TRANSITIONS[from].includes(to);
}
