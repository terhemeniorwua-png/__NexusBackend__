import type { TaskStatus } from '@prisma/client';
import { AppError } from '../../utils/errors';

const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  ASSIGNED: ['IN_PROGRESS'],
  IN_PROGRESS: ['SUBMITTED', 'ASSIGNED'],
  SUBMITTED: ['UNDER_REVIEW', 'APPROVED', 'CHANGES_REQUESTED', 'IN_PROGRESS'],
  UNDER_REVIEW: ['APPROVED', 'CHANGES_REQUESTED'],
  CHANGES_REQUESTED: ['IN_PROGRESS', 'SUBMITTED'],
  APPROVED: ['IN_PROGRESS'],
};

export type StatusTransitionContext =
  | 'update'
  | 'complete'
  | 'reopen'
  | 'submit'
  | 'review'
  | 'subtask_complete'
  | 'start';

function isAllowedByMatrix(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Enforce the task status transition matrix.
 *
 * Same-status transitions are always allowed. The proposed matrix is the base
 * policy; a small set of context-specific allowances preserve existing tested
 * behavior where it conflicts with the proposal.
 */
export function assertTaskStatusTransition(
  from: TaskStatus,
  to: TaskStatus,
  context: StatusTransitionContext = 'update',
): void {
  if (from === to) return;

  let allowed = isAllowedByMatrix(from, to);

  // Preserve existing behavior: complete() has historically moved tasks to
  // APPROVED from non-approved states.
  if (!allowed && context === 'complete' && to === 'APPROVED') {
    allowed = true;
  }

  // Preserve existing behavior: submit() accepts ASSIGNED and UNDER_REVIEW in
  // addition to the proposed matrix.
  if (
    !allowed &&
    context === 'submit' &&
    to === 'SUBMITTED' &&
    (from === 'ASSIGNED' || from === 'UNDER_REVIEW')
  ) {
    allowed = true;
  }

  // Preserve existing behavior: review decisions have not been restricted by a
  // prior-status matrix historically.
  if (!allowed && context === 'review') {
    allowed = true;
  }

  // Preserve existing behavior: reopening is a no-op unless APPROVED; when it
  // does transition it follows APPROVED -> IN_PROGRESS.
  if (!allowed && context === 'reopen' && from === 'APPROVED' && to === 'IN_PROGRESS') {
    allowed = true;
  }

  if (!allowed) {
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'This status transition is not allowed', {
      details: { from, to },
    });
  }
}

export { ALLOWED_TRANSITIONS };
