/**
 * PR #166 (feat(sprints): complete sprint scope audit trail) mergedAt timestamp.
 * Sprint scope reconstruction relies on sprint.task_added/removed/completed audit rows
 * with task IDs. Sprints created before this epoch (or completed without
 * carriedOverTaskIds/retainedTaskIds) are not fully reconstructable and must be
 * reported as scopeReconstructable: false (never partial counts).
 */
export const AUDIT_TRAIL_EPOCH = '2026-11-23T18:52:26Z';
