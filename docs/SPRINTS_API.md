# Sprints API (Stage 2)

Base path: `/workspaces/:workspaceId/projects/:projectId`

All routes require authentication + active account. Workspace/project scope is taken from route params only; request bodies never define workspace/project ownership.

## Common Sprint object

```json
{
  "id": "uuid",
  "projectId": "uuid",
  "name": "string",
  "goal": "string|null",
  "startDate": "ISO datetime|null",
  "endDate": "ISO datetime|null",
  "status": "PLANNED|ACTIVE|COMPLETED|ARCHIVED",
  "createdById": "uuid",
  "completedAt": "ISO datetime|null",
  "completedById": "uuid|null",
  "createdAt": "ISO datetime",
  "updatedAt": "ISO datetime"
}
```

## Error codes

| Code | HTTP | Meaning |
|---|---:|---|
| `SPRINTS_DISABLED_FOR_PROJECT` | 409 | Project `workflowMode` is `BACKLOG_ONLY`; sprint routes (except history) and sprint fields on task create/update are disabled. Details: `{ projectId, workflowMode }`. |
| `SPRINT_NOT_FOUND` | 404 | Sprint missing, not in project, or cross-project/cross-workspace id. |
| `PROJECT_NOT_FOUND` | 404 | Project missing/not accessible (existing project auth behavior). |
| `TASK_NOT_FOUND` | 404 | Task missing/not in project/deleted. |
| `TASK_NOT_IN_SPRINT` | 404 | Task exists in project but is not in the target sprint. |
| `PERMISSION_DENIED` | 403 | Authenticated but lacks required permission. |
| `SPRINT_NOT_ASSIGNABLE` | 422 | Sprint target is `COMPLETED` or `ARCHIVED` for assignment/move, or complete target `NEXT_SPRINT` is not `PLANNED`. |
| `ACTIVE_SPRINT_EXISTS` | 409 | Project already has an active sprint (start race/duplicate) or workflow switch to `BACKLOG_ONLY` requires confirmation. Details for switch: `{ sprintId, openTaskCount }`. Start details may include `{ projectId, activeSprintId }` or `{ projectId }` on DB unique violation. |
| `SPRINT_ALREADY_ACTIVE` | 409 | Target sprint is already `ACTIVE`. |
| `SPRINT_NOT_ACTIVE` | 409 | Complete requires an `ACTIVE` sprint. |
| `SPRINT_NOT_RESTORABLE` | 409 | Restore requires an `ARCHIVED` sprint. |
| `SPRINT_NOT_EDITABLE` | 409 | Stage 2 PATCH update only allows `PLANNED` sprints. |
| `SPRINT_NOT_STARTABLE` | 409 | Start only allows `PLANNED` sprints. |
| `VALIDATION_ERROR` | 422 | Request/body validation or semantic validation failure (e.g. missing `nextSprintId` for `NEXT_SPRINT`). |

Notes:
- Cross-project/cross-workspace ids return 404 (no existence leak).
- DB partial unique active-sprint violation is translated to clean 409 `ACTIVE_SPRINT_EXISTS` (never 500).

## Routes

### R1 - List sprints
- **Method/Path:** `GET /workspaces/:workspaceId/projects/:projectId/sprints`
- **Permission:** `ProjectPermission.View`
- **Query:** `cursor?: uuid`, `limit?: 1..100` (default 25), `status?: PLANNED|ACTIVE|COMPLETED|ARCHIVED`
- **Response 200:** `{ items: Sprint[], nextCursor: string|null }`
- **Errors:** 403 `PERMISSION_DENIED`, 404 `PROJECT_NOT_FOUND`, 409 `SPRINTS_DISABLED_FOR_PROJECT`

### R2 - Create sprint
- **Method/Path:** `POST /workspaces/:workspaceId/projects/:projectId/sprints`
- **Permission:** `ProjectPermission.Update`
- **Body:** `{ name: string(2..120), goal?: string|null, startDate?: ISO datetime|null, endDate?: ISO datetime|null }` (`strict`)
- **Response 201:** `Sprint` (status `PLANNED`)
- **Errors:** 403, 404, 409 `SPRINTS_DISABLED_FOR_PROJECT`, 422 validation

### R3 - Update sprint
- **Method/Path:** `PATCH /workspaces/:workspaceId/projects/:projectId/sprints/:sprintId`
- **Permission:** `ProjectPermission.Update`
- **Body:** any of `{ name?, goal?, startDate?, endDate? }` (`strict`, at least one field)
- **Response 200:** `Sprint`
- **Errors:** 403, 404 `SPRINT_NOT_FOUND`/`PROJECT_NOT_FOUND`, 409 `SPRINTS_DISABLED_FOR_PROJECT`, 409 `SPRINT_NOT_EDITABLE` (non-PLANNED), 422 validation/date range

### R4 - Start sprint
- **Method/Path:** `POST /workspaces/:workspaceId/projects/:projectId/sprints/:sprintId/start`
- **Permission:** `ProjectPermission.Update`
- **Body:** `{}` (strict, optional/empty)
- **Response 200:** `Sprint` (status `ACTIVE`)
- **Errors:** 403, 404, 409 `SPRINTS_DISABLED_FOR_PROJECT`, 409 `SPRINT_ALREADY_ACTIVE`, 409 `SPRINT_NOT_STARTABLE`, 409 `ACTIVE_SPRINT_EXISTS`

### R5 - Complete sprint
- **Method/Path:** `POST /workspaces/:workspaceId/projects/:projectId/sprints/:sprintId/complete`
- **Permission:** `ProjectPermission.Update`
- **Body:** `{ target: 'BACKLOG'|'NEXT_SPRINT', nextSprintId?: uuid }` (`strict`; `nextSprintId` required for `NEXT_SPRINT`, forbidden for `BACKLOG`)
- **Response 200:**
```json
{
  "sprint": { "...Sprint": "COMPLETED..." },
  "movedTaskCount": 0,
  "archivedUnfinishedMovedCount": 0,
  "destination": { "type": "BACKLOG" | "NEXT_SPRINT", "nextSprintId": "uuid?" }
}
```
- **Audit metadata (`sprint.completed`):** includes existing fields (`projectId, sprintId, movedTaskCount, archivedUnfinishedMovedCount, destinationType, nextSprintId?`, and `reason=WORKFLOW_MODE_SWITCH` when applicable) plus `carriedOverTaskIds: string[]` (unfinished task IDs moved out, both BACKLOG and NEXT_SPRINT, including archived unfinished) and `retainedTaskIds: string[]` (APPROVED task IDs retained in the completed sprint).
- **Behavior:** Unfinished tasks = task status not `APPROVED` and not deleted (includes `ASSIGNED, AWAITING_CLARIFICATION, IN_PROGRESS, SUBMITTED, UNDER_REVIEW, CHANGES_REQUESTED`). Archived non-APPROVED tasks count as unfinished and are moved; `archivedUnfinishedMovedCount` reported separately. APPROVED tasks retain sprint membership. BACKLOG moves set `sprintId=null, sprintPosition=null` and append backlog `position` after max in deterministic order `sprintPosition asc, id asc`. NEXT_SPRINT moves unfinished tasks to target sprint with sprintPosition append; target must be same project and `PLANNED`.
- **Errors:** 403, 404 `SPRINT_NOT_FOUND`, 409 `SPRINTS_DISABLED_FOR_PROJECT`, 409 `SPRINT_NOT_ACTIVE`, 422 `SPRINT_NOT_ASSIGNABLE` (NEXT_SPRINT not PLANNED), 422 validation

### R6 - Restore sprint
- **Method/Path:** `POST /workspaces/:workspaceId/projects/:projectId/sprints/:sprintId/restore`
- **Permission:** `ProjectPermission.Update`
- **Body:** `{}` (strict, optional/empty)
- **Response 200:** `Sprint` (status `PLANNED`, completed fields cleared)
- **Errors:** 403, 404, 409 `SPRINTS_DISABLED_FOR_PROJECT`, 409 `SPRINT_NOT_RESTORABLE`

### R7 - Add/move tasks to sprint
- **Method/Path:** `POST /workspaces/:workspaceId/projects/:projectId/sprints/:sprintId/tasks`
- **Permission:** `ProjectPermission.TaskUpdate` (existing task move/update authority)
- **Body:** `{ taskIds: uuid[] }` (`strict`, min 1, max 200)
- **Response 200:** `{ sprint: Sprint, addedTaskIds: string[] }` (`addedTaskIds` contains tasks newly moved/added; tasks already in sprint are ignored)
- **Behavior:** Project must be `SPRINTS`; target sprint must be `PLANNED` or `ACTIVE` (COMPLETED/ARCHIVED => 422 `SPRINT_NOT_ASSIGNABLE`). Sets `sprintId` and appends server-managed `sprintPosition`. Preserves backlog `position`.
- **Errors:** 403, 404 `SPRINT_NOT_FOUND`/`TASK_NOT_FOUND`/`PROJECT_NOT_FOUND`, 409 `SPRINTS_DISABLED_FOR_PROJECT`, 422 `SPRINT_NOT_ASSIGNABLE`

### R8 - Remove task from sprint to backlog
- **Method/Path:** `DELETE /workspaces/:workspaceId/projects/:projectId/sprints/:sprintId/tasks/:taskId`
- **Permission:** `ProjectPermission.TaskUpdate` (existing task move/update authority)
- **Response 200:** `{ sprint: Sprint, taskId: string }`
- **Behavior:** Task must be in target sprint; clears `sprintId`/`sprintPosition` and appends backlog `position` after current max backlog position.
- **Errors:** 403, 404 `SPRINT_NOT_FOUND`/`TASK_NOT_FOUND`/`TASK_NOT_IN_SPRINT`, 409 `SPRINTS_DISABLED_FOR_PROJECT`

### R9 - Sprint history
- **Method/Path:** `GET /workspaces/:workspaceId/projects/:projectId/sprints/history`
- **Permission:** Manager/admin only (`ProjectPermission.Update` required). Non-managers receive 403 `PERMISSION_DENIED` in both modes.
- **Query:** `cursor?: uuid`, `limit?: 1..100` (default 25), `status?: PLANNED|ACTIVE|COMPLETED|ARCHIVED` (history returns COMPLETED/ARCHIVED by default; if status filter is COMPLETED or ARCHIVED it is applied)
- **Response 200:** `{ items: Sprint[], nextCursor: string|null }`
- **Behavior:** Read-only retained sprint metadata. Works in both `SPRINTS` and `BACKLOG_ONLY` modes.

### R10 - Project workflow mode (existing project update)
- **Method/Path:** `PATCH /workspaces/:workspaceId/projects/:projectId`
- **Permission:** `ProjectPermission.Update` (existing project update authority)
- **Body fields (additive):** `workflowMode?: 'SPRINTS'|'BACKLOG_ONLY'`, `confirmActiveSprintCompletion?: boolean`
- **Response 200:** Project summary (existing shape, includes `workflowMode`).
- **Behavior:**
  - `SPRINTS -> BACKLOG_ONLY`: locks project row in tx. If ACTIVE sprint exists and `confirmActiveSprintCompletion` is not true, 409 `ACTIVE_SPRINT_EXISTS` with `{ sprintId, openTaskCount }` (openTaskCount uses unfinished definition: not APPROVED, not deleted; includes archived non-APPROVED). With confirmation: completes ACTIVE sprint, moves unfinished tasks to backlog with deterministic append (`sprintPosition asc, id asc`), archives PLANNED sprints, preserves COMPLETED/ARCHIVED history and APPROVED task sprint membership. Audits `sprint.completed` with `reason=WORKFLOW_MODE_SWITCH` and `project.workflow_mode_changed`.
  - `BACKLOG_ONLY -> SPRINTS`: locks project row, sets workflowMode to SPRINTS, starts nothing, preserves sprint states. Audits `project.workflow_mode_changed`.
  - No notification types/migrations in stage 2.

## Task create/update sprint fields (Stage 2)

- **Fields accepted:** `sprintId?: uuid|null` on `POST /workspaces/:wid/projects/:pid/tasks` and `PATCH /workspaces/:wid/projects/:pid/tasks/:taskId`.
- **Rejected:** `sprintPosition` in request body (server-managed; body schemas are strict).
- **Behavior:**
  - If `sprintId` is provided while project is `BACKLOG_ONLY`: 409 `SPRINTS_DISABLED_FOR_PROJECT`.
  - If `sprintId` is a sprint in another project/workspace or missing: 404 `SPRINT_NOT_FOUND`.
  - If sprint is `COMPLETED` or `ARCHIVED`: 422 `SPRINT_NOT_ASSIGNABLE`.
  - On assign/move to sprint: server sets/appends `sprintPosition`.
  - On move to backlog (`sprintId: null`) from a sprint: server clears `sprintId/sprintPosition` and appends backlog `position` after max backlog position.
- **Authority:** uses existing task create/update authority (`ProjectPermission.TaskCreate` / `ProjectPermission.TaskUpdate`).

## Audit actions (ids/counts only; no task titles)

- `sprint.created`
- `sprint.updated`
- `sprint.started`
- `sprint.completed` (`reason: WORKFLOW_MODE_SWITCH` when applicable; metadata includes `carriedOverTaskIds` and `retainedTaskIds`)
- `sprint.restored`
- `sprint.task_added` (sprint routes; also emitted by task create/update sprint membership changes with `source: 'task.create'|'task.update'`)
- `sprint.task_removed` (sprint routes; also emitted by task update sprint membership changes with `source: 'task.update'`)
- `project.workflow_mode_changed`

### Sprint membership audit rows (Step 2 scope-audit trail)

- **Task create with `sprintId`**: writes `sprint.task_added` in the same transaction as task creation. Metadata: `{ projectId, sprintId, taskIds: [taskId], count: 1, source: 'task.create' }`.
- **Task update changing `sprintId`**: in the same transaction, writes `sprint.task_removed` for old sprint (if any) and/or `sprint.task_added` for new sprint (if any). Metadata: `{ projectId, sprintId, taskIds: [taskId], count: 1, source: 'task.update' }`. Moving A->B writes both. No row if `sprintId` is unchanged.
- **Legacy limitation**: sprint memberships changed through task create/update before this audit-trail change have no sprint membership audit rows. `sprint.completed` rows emitted before this change may lack `carriedOverTaskIds`/`retainedTaskIds`.

No notification types were added in Stage 2.

## Stage 3 — Board and Reports (read-only)

All Stage 3 routes are read-only. No audit writes. No notification types. No migrations.

### R11 - Sprint board
- **Method/Path:** `GET /workspaces/:workspaceId/projects/:projectId/sprints/:sprintId/board`
- **Permission:** `ProjectPermission.View` (same auth behavior as R1 for non-members/missing permission/cross-project sprints)
- **Response 200:**
```json
{
  "sprint": { "...Sprint" },
  "columns": [
    { "status": "ASSIGNED|AWAITING_CLARIFICATION|IN_PROGRESS|SUBMITTED|UNDER_REVIEW|CHANGES_REQUESTED|APPROVED", "count": 0, "tasks": [{ "id", "key", "title", "status", "priority", "sprintId", "sprintPosition", "assignees": [{ "userId", "name" }], "dueDate", "archivedAt" }] }
  ],
  "totals": { "taskCount": 0, "doneCount": 0 }
}
```
- **Behavior:** Columns from ordered constant `SPRINT_BOARD_COLUMN_ORDER` (TaskStatus lifecycle order). Tasks in sprint where `deletedAt=null`, ordered by `sprintPosition asc, id asc`. Archived tasks included with `archivedAt`. Counts only (no weight). Board always uses current state and is never affected by legacy scope reconstructability.
- **Errors:** 403 `PERMISSION_DENIED`, 404 `PROJECT_NOT_FOUND`/`SPRINT_NOT_FOUND`, 409 `SPRINTS_DISABLED_FOR_PROJECT`

### R12 - Sprint report summary
- **Method/Path:** `GET /workspaces/:workspaceId/projects/:projectId/sprints/:sprintId/reports/summary`
- **Permission:** `ProjectPermission.View` (same auth behavior as R1)
- **Response 200 (ACTIVE/PLANNED, exact current state):**
```json
{
  "sprint": { "...Sprint" },
  "scopeReconstructable": true,
  "summary": { "metric": "TASK_COUNT", "totalTasks": 0, "doneTasks": 0, "remainingTasks": 0, "completionRate": 0.0 },
  "generatedAt": "ISO datetime"
}
```
- **Response 200 (COMPLETED, reconstructable):** same shape with `summary` populated from final scope (`retainedTaskIds + carriedOverTaskIds` from own `sprint.completed` row, excluding tasks deleted since).
- **Response 200 (COMPLETED, not reconstructable):** `{ "sprint", "scopeReconstructable": false, "reason": "string", "summary": null, "generatedAt" }` — **never partial counts**.
- **Errors:** 403, 404, 409 `SPRINTS_DISABLED_FOR_PROJECT`

### R13 - Sprint burndown
- **Method/Path:** `GET /workspaces/:workspaceId/projects/:projectId/sprints/:sprintId/reports/burndown`
- **Permission:** `ProjectPermission.View` (same auth behavior as R1)
- **Response 200 (reconstructable):**
```json
{
  "sprint": { "...Sprint" },
  "scopeReconstructable": true,
  "metric": "TASK_COUNT",
  "startAt": "ISO datetime",
  "endAt": "ISO datetime",
  "series": [{ "date": "YYYY-MM-DD", "remaining": 0, "ideal": 0, "scope": 0, "completed": 0 }],
  "totals": { "initialScope": 0, "completed": 0, "remaining": 0 },
  "generatedAt": "ISO datetime"
}
```
- **Response 200 (not reconstructable):** `{ "sprint", "scopeReconstructable": false, "reason": "string", "series": [], "generatedAt" }` — **never partial counts**.
- **Errors:** 403, 404, 409 `SPRINTS_DISABLED_FOR_PROJECT`

## Stage 3 rules

- **Done:** `status === APPROVED`. Counts only; no weight. Metric `TASK_COUNT`.
- **Done time:** `Task.completedAt` (primary). Fallback: latest `task.approved` or `task.completed` AuditLog `createdAt` when task is APPROVED but `completedAt` is null. Limitation: reopen followed by re-approve shows only the latest completion time.
- **Subtasks:** same as Stage 2 sprint/task membership behavior - tasks with `sprintId` in sprint are included regardless of parent/child relationship (membership is by `sprintId`); no special exclusion.
- **Archived tasks:** included in board/report scope where present (with `archivedAt` on board); deleted tasks (`deletedAt != null`) excluded and documented.
- **Board size:** no explicit pagination in Stage 3; returns all non-deleted sprint tasks (same membership filter as sprint task queries; Stage 2 did not impose a board limit). Column counts reflect returned tasks.
- **Burndown days:** UTC calendar days. Weekends count.
  - ACTIVE: start day (`startDate ?? createdAt`) through today (UTC). Ideal clamps to 0 after `endDate`.
  - COMPLETED: start day through `completedAt` day (UTC).
  - PLANNED: 200 with empty `series`, totals from current sprint members.
  - Ideal linear from `initialScope` to 0 across sprint days; single-day series has `ideal = initialScope`.
- **Scope reconstruction (audit-only):** membership history from audit rows only: `sprint.task_added`, `sprint.task_removed` (task IDs in metadata), `sprint.completed` (`carriedOverTaskIds`, `retainedTaskIds`, `nextSprintId`). 
  - Scope at time T = (task IDs from `sprint.task_added` up to T) + (`carriedOverTaskIds` from `sprint.completed` rows whose `nextSprintId` is this sprint, counted at that row's `createdAt`) - (task IDs from `sprint.task_removed` up to T).
  - COMPLETED final scope = `retainedTaskIds + carriedOverTaskIds` from its own `sprint.completed` row.
  - `AUDIT_TRAIL_EPOCH` is hard-coded from PR #166 mergeAt (`2026-11-23T18:52:26Z`).
- **Legacy/not reconstructable:** if sprint.createdAt < AUDIT_TRAIL_EPOCH, or COMPLETED and own `sprint.completed` lacks carried/retained IDs, or depends on carry-in from completion missing IDs: R13 returns 200 `scopeReconstructable:false, reason, series:[]`; R12 COMPLETED returns 200 `scopeReconstructable:false, reason, summary:null`. ACTIVE/PLANNED R12 uses current state and returns exact summary with `scopeReconstructable:true`; burndown is unavailable. Never partial counts.
- **Invariants:** ACTIVE last burndown point equals R12 summary (remaining, completed). COMPLETED final scope equals R12 total.
