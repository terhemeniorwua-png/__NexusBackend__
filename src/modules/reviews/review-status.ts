import type { ReviewStatus } from '@prisma/client';
import { AppError } from '../../utils/errors';

/**
 * BE-2 review lifecycle. This is deliberately stricter than the task matrix:
 * APPROVED is terminal, UNDER_REVIEW cannot return to SUBMITTED, and there is
 * no ASSIGNED or IN_PROGRESS state.
 */
export const ALLOWED_REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  SUBMITTED: ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'CHANGES_REQUESTED'],
  UNDER_REVIEW: ['UNDER_REVIEW', 'APPROVED', 'CHANGES_REQUESTED'],
  APPROVED: ['APPROVED'],
  CHANGES_REQUESTED: ['CHANGES_REQUESTED', 'SUBMITTED'],
};

export function isAllowedByMatrix(from: ReviewStatus, to: ReviewStatus): boolean {
  return ALLOWED_REVIEW_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertReviewTransition(
  from: ReviewStatus,
  to: ReviewStatus,
  round?: number,
): void {
  if (isAllowedByMatrix(from, to)) return;

  throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'This status transition is not allowed', {
    details: round === undefined ? { from, to } : { from, to, round },
  });
}

export function isOpenReviewStatus(status: ReviewStatus): boolean {
  return status === 'SUBMITTED' || status === 'UNDER_REVIEW';
}
