# Design Note: Sprints and Backlog (Optional Per Project)

**Status:** Design only (no code, no schema, no migrations).  
**Base:** `origin/main` @ `05e07d530a0a51c213a06f99d77b9d04cae92f31` (`git rev-parse origin/main`).  
**Scope:** Project workflow mode, backlog ordering, sprints, task assignment to sprint/backlog, API behavior, migration plan, frontend/tests.

**Stage 2 implementation contract:** See [SPRINTS_API.md](./SPRINTS_API.md) for the implemented Stage 2 route/request/response/error contract (source of truth for Stage 2 code behavior).

## 1. Current Inventory

**Exists today**
- **Projects** (`Project`, `prisma/schema.prisma`): workspace-scoped; fields include `status` (`ProjectStatus`), `type`, `visibility`, `commentPolicy`, dates, owner, archive/complete metadata, team/department links. No workflow/sprint mode field. Project update (`PATCH /workspaces/:wid/projects/:pid`, `project.routes.ts`/`project.schemas.ts`/`project.service.ts`) allows settings updates with `project.update` authorization.
- **Tasks** (`Task`): project-scoped, unique `(projectId,key)`, `status` (`TaskStatus`: ASSIGNED, AWAITING_CLARIFICATION, IN_PROGRESS, SUBMITTED, UNDER_REVIEW, APPROVED, CHANGES_REQUESTED), `priority`, `position Int @default(0)`, dates, assignees, parent/subtasks, dependencies, milestone, labels/category, review/submission fields, recurrence, custom fields, dev links. Indexes include `(projectId,status)`, `(projectId,priority)`, `(projectId,position)`.
- **Task ordering/listing** (`task.service.ts`, `task.schemas.ts`): create/update accept `position`; list supports `sortBy=position|dueDate|priority|createdAt`, default `position asc, id asc`; filters by status/priority/assignee/search/etc. No backlog entity; `position` is the current per-project ordering field.
- **Task status transitions** (`task-status.ts`, task routes/service): lifecycle and review/clarification rules exist; no sprint state machine.
- **Audit/notifications**: `recordAuditEvent` writes audit rows in same transaction as changes (`src/services/audit.ts`); notifications via `createNotification` with workspace-scoped in-app preference checks (`src/services/notifications.ts`). Project/task audit actions are defined as constants.

**Missing**
- No `Sprint` model, no sprint status/lifecycle, no sprint-task membership.
- No backlog model/entity; no explicit backlog position separate from sprint membership.
- No `ProjectWorkflowMode` / `SPRINTS|BACKLOG_ONLY` setting.
- No sprint routes, no sprint board/burndown/velocity endpoints, no sprint-aware task filters.
- No migration/history semantics for switching modes.
- No 409 contract for sprint-disabled projects.

## 2. Model

**Project workflow setting**
- `ProjectWorkflowMode` enum: `SPRINTS | BACKLOG_ONLY` (design; additive schema change in migration plan).
- Stored on `Project` as `workflowMode` (default per §3). Existing project behavior must remain unchanged at deploy.

**Backlog (per project)**
- The backlog is the ordered set of project tasks not in an active/planned sprint context as defined by mode. `Task.position` remains the backlog order in **both** modes. In `BACKLOG_ONLY`, all non-deleted project tasks are ordered by `position`; in `SPRINTS`, tasks where `sprintId IS NULL` are backlog tasks ordered by `position`. Reordering backlog updates `position` in a transaction; clients receive ordered lists by `position asc, id asc`.

**Sprint (proposed model)**
- `Sprint`: `id`, `projectId`, `name`, `goal?`, `startDate?`, `endDate?`, `status` (`PLANNED | ACTIVE | COMPLETED | ARCHIVED` - `ARCHIVED` used for planned sprints retired by mode switch, read-only), `createdById`, `completedAt?`, `completedById?`, `createdAt`, `updatedAt`.
- Task membership: add nullable `Task.sprintId` FK to `Sprint` (on delete set null only through controlled service logic; preferred explicit move transaction). Add `Task.sprintPosition Int?` for ordering **only inside a sprint**. `Task.position` is never repurposed for sprint ordering; when moving a task into a sprint, set `sprintId` and `sprintPosition` and preserve backlog `position` unchanged for easy return. When returning to backlog, clear `sprintId`/`sprintPosition` and set backlog `position` per completion/switch rules.
- Rules: a task is in at most one sprint (`sprintId` single FK). A task may be in backlog (`sprintId=null`).

**Active sprint constraint**
- At most one ACTIVE sprint per project. Enforce with a partial unique index: `UNIQUE(projectId) WHERE status='ACTIVE'` (Postgres). Service also checks in transaction before starting sprint to return clear 409 on conflict.

**Completing a sprint**
- Input: `target=BACKLOG | NEXT_SPRINT`, optional `nextSprintId` when target is next sprint. In one transaction: lock sprint row; require ACTIVE; mark sprint COMPLETED with `completedAt/completedById`; for unfinished tasks (not in terminal done state - use project/task completion rule, recommended: status not APPROVED/completed equivalent; design must align with TaskStatus), move to backlog by setting `sprintId=null`, `sprintPosition=null`, and assigning backlog `position` append-after-max (stable deterministic); if moving to next sprint, validate same project, status PLANNED, set `sprintId=nextSprintId`, assign sprintPosition append. Completed/approved tasks retain sprint membership for history. Audit `sprint.completed` with counts and destination.

## 3. Sprints Optional Per Project

**Enum:** `ProjectWorkflowMode { SPRINTS, BACKLOG_ONLY }`.

**Defaults / creation behavior:**
- **New projects:** choose `workflowMode` at creation (`SPRINTS` or `BACKLOG_ONLY`); default is `SPRINTS` when omitted. **Justification:** new projects can opt into sprint planning from day one, while the project creator/manager can explicitly select `BACKLOG_ONLY` for simpler kanban/backlog workflows.
- **Existing projects at deploy:** get `BACKLOG_ONLY` by column default/backfill. **Justification:** current production behavior has no sprint entities/routes; tasks are ordered by `position` and managed in backlog/board style. Keeping existing projects `BACKLOG_ONLY` preserves observable behavior exactly and keeps sprint routes disabled until a manager/admin explicitly enables SPRINTS.

**Who may change:** project manager and workspace admin only (same authority level as `project.update` / project settings management). Capability check: require authenticated active account, workspace access, and project permission equivalent to `ProjectPermission.Update` (`project.update`); deny viewers/collaborators/members without manage permission. Every change is audited with `project.workflow_mode_changed` including actor, project/workspace, old mode, new mode, confirmation flag, affected active sprint id/counts, timestamp, IP/user-agent.

**Mode meaning**
| Area | SPRINTS | BACKLOG_ONLY |
|---|---|---|
| Backlog | Tasks with `sprintId=null` are backlog; reorder backlog positions | All non-deleted tasks are backlog-ordered by `position`; no sprint assignment |
| Boards | Sprint board + backlog/kanban views available | Kanban/backlog board only; sprint board hidden/disabled |
| Reports | Burndown/velocity/sprint reports available for sprint history | Sprint reports hidden from default UI; retained completed sprint reports read-only via `GET /sprints/history` for managers/admins (§5) |
| Task fields | `sprintId`, `sprintPosition` visible/editable where permitted | Sprint fields read-only/hidden; attempts to set return 409 `SPRINTS_DISABLED_FOR_PROJECT` |

## 4. Switching Rules

### a. SPRINTS -> BACKLOG_ONLY
- If an ACTIVE sprint exists, request must carry explicit confirmation (e.g. `confirmActiveSprintCompletion=true`). Without it, return `409 ACTIVE_SPRINT_EXISTS` with `{ code, message, sprintId, openTaskCount }`.
- With confirmation, in **one transaction**: lock project row (`FOR UPDATE`) and active sprint row if present; recheck mode and active sprint; complete ACTIVE sprint (`COMPLETED`, `completedAt`, `completedById=actor`), move unfinished tasks to backlog (`sprintId=null`, `sprintPosition=null`) appending backlog positions after current max in deterministic order (e.g. sprintPosition asc, id asc); mark PLANNED sprints as `ARCHIVED` (**chosen**) because they cannot be started in BACKLOG_ONLY and leaving them PLANNED would create ambiguous dormant state; preserve all sprint records, sprint-task historical membership for completed tasks, and audit history; then set `project.workflowMode=BACKLOG_ONLY`. **Justification for ARCHIVED:** retains data, prevents accidental start, makes state explicit; ARCHIVED sprints remain ARCHIVED until explicitly restored by `POST /workspaces/:wid/projects/:pid/sprints/:sid/restore` (manager/admin only, SPRINTS mode).
- Sprint data is never deleted. Sprints, history, and completed-task membership remain stored, read-only, hidden from default views.

### b. BACKLOG_ONLY -> SPRINTS
- In one transaction lock project: set `workflowMode=SPRINTS`. Retained sprints become visible again; no sprint auto-started; PLANNED/ARCHIVED sprints retain prior state. ARCHIVED sprints stay ARCHIVED until explicitly restored via `POST /workspaces/:wid/projects/:pid/sprints/:sid/restore` (manager/admin only, SPRINTS mode only). Existing tasks stay in backlog (`sprintId=null`).

### c. Concurrency
- Two simultaneous switches, or switch racing sprint start/complete/task sprint mutation, must resolve to one result. Use DB transaction with row locks on `Project` (and Sprint row when relevant) and/or partial unique index for active sprint. For switch, `SELECT ... FOR UPDATE` project; perform checks/writes; commit. Competing switch gets serialized result (idempotent if same mode, or 409/200 based on final state). Sprint start/complete also lock project + sprint rows and revalidate `workflowMode=SPRINTS`.

### d. Audit events and notifications
- **Audit action:** `project.workflow_mode_changed` on every successful switch. Metadata includes actor, `projectId`, `workspaceId`, `oldMode`, `newMode`, `confirmation`, `activeSprintId?`, `openTaskCount?`, `plannedSprintsArchivedCount?`, timestamp, and request context (IP/user-agent). If an ACTIVE sprint is completed due to the switch, also emit `sprint.completed` with `reason='WORKFLOW_MODE_SWITCH'`.
- **Notification:** in-app notification type `PROJECT_WORKFLOW_MODE_CHANGED` (in-app preference-aware) on every successful switch. **Recipients:** project owner, project managers, and workspace admins (deduped, capped) who have effective project/workspace access. No fanout to all project members; no email by default unless existing project-settings notification policy includes it. Payload includes `projectId`, `workspaceId`, `oldMode`, `newMode`, `actorId`, and `activeSprintId?`.

## 5. API Behaviour

**BACKLOG_ONLY 409 contract**
- In `BACKLOG_ONLY` projects, every sprint route (list, create, update, start, complete, add/remove tasks, reorder sprint tasks, sprint board/report endpoints) returns `409` with code `SPRINTS_DISABLED_FOR_PROJECT` and clear message: "Sprints are disabled for this project." Include `projectId`, `workflowMode`.
- **Read-only retained history exception:** `GET /workspaces/:wid/projects/:pid/sprints/history` (manager/admin only, read-only) returns `200` with retained COMPLETED/ARCHIVED sprint metadata for audit/report continuity in both modes; it does not enable sprint operations. All other sprint routes in BACKLOG_ONLY return `409 SPRINTS_DISABLED_FOR_PROJECT`.

**Task sprint fields**
- Task create/update that sets sprint assignment/`sprintId`/`sprintPosition` in BACKLOG_ONLY returns `409 SPRINTS_DISABLED_FOR_PROJECT`.
- In SPRINTS, setting `sprintId` requires task update permission, sprint in same project, and project mode SPRINTS. Setting a task's sprint to a `COMPLETED` or `ARCHIVED` sprint is not allowed and returns `422 SPRINT_NOT_ASSIGNABLE` with a clear message (e.g. "Completed or archived sprints cannot accept task assignments").

**Backlog routes**
- Backlog/task list/reorder routes work in both modes. In SPRINTS, backlog means `sprintId=null`.

**IDOR / 403 vs 404**
- All routes are workspace/project scoped. Resolve project within workspace; if project missing or not accessible, return `404 PROJECT_NOT_FOUND` to avoid existence leak. If accessible but lacking permission, return `403`. If sprintId/taskId belongs to another project/workspace, `404`. Never accept workspace/project ownership from body.

**Route behavior table**

| Route (design) | SPRINTS | BACKLOG_ONLY |
|---|---|---|
| `GET /projects/:pid/sprints` | 200 list active/planned/completed as permitted | 409 `SPRINTS_DISABLED_FOR_PROJECT` |
| `POST /projects/:pid/sprints` | 201 create PLANNED | 409 `SPRINTS_DISABLED_FOR_PROJECT` |
| `PATCH /projects/:pid/sprints/:sid` | 200 update PLANNED/metadata | 409 `SPRINTS_DISABLED_FOR_PROJECT` |
| `POST /projects/:pid/sprints/:sid/start` | 200 set ACTIVE; enforces single ACTIVE | 409 `SPRINTS_DISABLED_FOR_PROJECT` |
| `POST /projects/:pid/sprints/:sid/complete` | 200 complete, move unfinished tasks | 409 `SPRINTS_DISABLED_FOR_PROJECT` |
| `POST /projects/:pid/sprints/:sid/restore` | 200 restore ARCHIVED -> PLANNED (manager/admin only) | 409 `SPRINTS_DISABLED_FOR_PROJECT` |
| `POST /projects/:pid/sprints/:sid/tasks` | 200 assign/move tasks | 409 `SPRINTS_DISABLED_FOR_PROJECT` |
| `DELETE /projects/:pid/sprints/:sid/tasks/:taskId` | 200 remove to backlog | 409 `SPRINTS_DISABLED_FOR_PROJECT` |
| `GET /projects/:pid/sprints/:sid/board` | 200 | 409 `SPRINTS_DISABLED_FOR_PROJECT` |
| `GET /projects/:pid/sprints/:sid/reports/*` | 200 | 409 `SPRINTS_DISABLED_FOR_PROJECT` |
| `GET /projects/:pid/sprints/history` | 200 read-only retained history (manager/admin only) | 200 read-only retained history (manager/admin only) |
| `PATCH /projects/:pid` `workflowMode` | 200 with rules | 200 with rules |
| Task create/update with sprint fields | 200/validation; COMPLETED/ARCHIVED sprint target returns 422 `SPRINT_NOT_ASSIGNABLE` | 409 `SPRINTS_DISABLED_FOR_PROJECT` |
| Backlog/task list/reorder | 200 | 200 |

## 6. Reports and Boards

| Feature | SPRINTS | BACKLOG_ONLY |
|---|---|---|
| Sprint board | Shows ACTIVE/selected sprint tasks by sprintPosition/status; drag/drop respects permissions | Hidden; direct route returns 409 |
| Burndown | Available for ACTIVE/COMPLETED sprints; computed from sprint task status transitions/snapshots (design detail) | Not available for operation; retained completed sprint burndown viewable via read-only `GET /sprints/history` for managers/admins, labeled “Archived sprint (before BACKLOG_ONLY)” |
| Velocity | Computed from completed sprints; excludes ARCHIVED-by-switch planned sprints with no work | Same retained-history rule via read-only history for managers/admins; labeled with mode-switch context |
| Backlog/kanban board | Available | Available (default) |
| History after switch | Sprint records remain; UI labels sprints completed during switch with reason | Hidden from default UI; managers/admins may access read-only `GET /sprints/history` |

## 7. Migration Plan (Design Only)

- **One additive migration**, named to sort after `20261121600000_repository_access`: `20261121800000_sprints_backlog`.
- **Expand-only:** create `ProjectWorkflowMode` enum; add `Project.workflowMode` with DB default `BACKLOG_ONLY` and NOT NULL (preserves all existing projects at deploy); create `Sprint` table, `SprintStatus` enum, `Task.sprintId` nullable FK, `Task.sprintPosition` nullable; add indexes and partial unique index for one ACTIVE sprint per project; add audit/notification enum values only through existing migration conventions if required. No bulk rewrite of existing tasks beyond defaults; no edits to existing migrations.
- **Backfill/defaults:** existing projects get `workflowMode=BACKLOG_ONLY` by column default. New projects created after deploy choose mode at creation and default to `SPRINTS` at the application layer when omitted; the DB default remains `BACKLOG_ONLY` for safety/backward compatibility. Existing tasks keep `sprintId=null`, `sprintPosition=null`.
- **Rollback:** code rollback can ignore new columns/tables if additive; DB rollback requires careful down migration only in dev/staging. Production: forward-fix preferred. Do not drop sprint history tables in rollback without backup/approval.

## 8. Frontend Impact

- Project settings: workflow mode toggle (`SPRINTS` / `BACKLOG_ONLY`) visible to project managers/workspace admins only. Switching SPRINTS->BACKLOG_ONLY shows confirm dialog when API returns 409 `ACTIVE_SPRINT_EXISTS`; dialog displays sprint name/id and open task count and submits confirmation.
- Hide sprint UI (sprint nav, create/start/complete actions, sprint field pickers, sprint boards/reports) when project is `BACKLOG_ONLY`; show read-only history entry for managers/admins via `GET /sprints/history`.
- Handle 409 codes: `SPRINTS_DISABLED_FOR_PROJECT` -> clear inline/banner message and disable sprint actions; `ACTIVE_SPRINT_EXISTS` -> confirmation flow.
- Empty states: BACKLOG_ONLY shows backlog/kanban; SPRINTS with no sprints shows “Create first sprint”.

## 9. Tests Plan

- **Switch matrix:** mode x active sprint present/absent x confirmation true/false x planned sprints present. Assert transaction atomicity and final state.
- **Atomicity:** simulate failure mid-switch; no partial mode/data change.
- **Concurrency:** two simultaneous switches; switch vs sprint start; switch vs sprint complete; switch vs task sprint assignment. Assert one winner, consistent final state.
- **409 on every sprint route:** table-driven tests for all sprint endpoints in BACKLOG_ONLY, including task create/update with sprint fields; verify `SPRINTS_DISABLED_FOR_PROJECT`.
- **History route:** manager/admin can `GET /sprints/history` in both modes (read-only retained history); non-manager/admin access denied as designed; other sprint routes remain 409 in BACKLOG_ONLY.
- **Permissions:** only project manager/workspace admin can change mode; others 403. Sprint operations require appropriate project/task permissions.
- **IDOR:** cross-project/cross-workspace sprint/task IDs return 404/403 as specified; no data leak.
- **Data retained:** after SPRINTS->BACKLOG_ONLY->SPRINTS, sprint records/history/completed-task membership retained; ARCHIVED planned sprints remain archived unless restored.

## 10. Open Questions (Recommended Defaults)

- **Unfinished task definition on sprint completion:** Default: tasks not in APPROVED/completed terminal state are unfinished; include IN_PROGRESS/SUBMITTED/UNDER_REVIEW/CHANGES_REQUESTED/ASSIGNED/AWAITING_CLARIFICATION as unfinished unless product defines otherwise.
- **Backlog position on return:** Default: append returned tasks after max backlog position in deterministic order (`sprintPosition asc, id asc`), preserving relative order.
- **ARCHIVED planned sprints on re-enable:** Decided: remain ARCHIVED; manager/admin can manually restore to PLANNED via `POST /workspaces/:wid/projects/:pid/sprints/:sid/restore` (SPRINTS mode only).
- **History endpoint in BACKLOG_ONLY:** Decided: `GET /workspaces/:wid/projects/:pid/sprints/history` (manager/admin only, read-only) is available in both modes; all other sprint routes return 409 in BACKLOG_ONLY.
- **Sprint field on tasks in BACKLOG_ONLY responses:** Default: omit or return null read-only fields; any write attempt 409 `SPRINTS_DISABLED_FOR_PROJECT`.
- **Notification type/scope:** Decided: audit `project.workflow_mode_changed`; in-app `PROJECT_WORKFLOW_MODE_CHANGED` to project owner, project managers, and workspace admins (deduped, capped, preference-aware); no broad member fanout.