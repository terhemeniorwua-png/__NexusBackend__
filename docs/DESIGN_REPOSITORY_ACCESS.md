# Design Note: Repository-Level Access

**Status:** Stage 1 schema/resolver and Stage 2 enforcement implemented (see PRs #157, #158). Stage 3 repository access member API implemented (contract: [REPOSITORY_ACCESS_MEMBER_API.md](./REPOSITORY_ACCESS_MEMBER_API.md)); later stages (backfill, broader audit routes) remain design/follow-up.  
**Base:** `origin/main` (post-#158).  
**Scope:** Project-linked repositories (`ProjectRepository`), repository browsing, and task dev-links (`TaskDevLink`).

## 1. Current Inventory

| Surface | Route / Service | Current check | Data exposed today |
|---|---|---|---|
| List workspace connections | `GET /workspaces/:wid/dev-integrations/connections` → `listConnections` | `WorkspaceCapability.ViewWorkspace` (active membership) | Connection status/account metadata; no secrets |
| Start GitHub/GitLab connect | `GET .../github/start`, `.../gitlab/start` → `start*Connect` | `WorkspaceCapability.UpdateWorkspace` (workspace manager) | OAuth/install URL |
| Disconnect connection | `DELETE .../connections/:connectionId` → `disconnect` | `WorkspaceCapability.UpdateWorkspace` | Disconnect result |
| List available repos for connection | `GET .../connections/:connectionId/repos` → `listAvailableRepositories` | `WorkspaceCapability.ViewWorkspace` + connection in workspace/ACTIVE | Provider repos/projects visible to installation/OAuth token |
| List linked project repos | `GET /workspaces/:wid/projects/:pid/repositories` → `listProjectRepositories` | `requireProjectViewer` (`project.view`) | Linked `ProjectRepository` rows |
| Link repo to project | `POST .../repositories` → `linkRepository` | `requireProjectRepoManager` (`project.update`) | Created link; validates active connection in workspace |
| Unlink repo | `DELETE .../repositories/:repositoryId` → `unlinkRepository` | `requireProjectRepoManager` (`project.update`) | `{ok:true}` |
| Browse branches | `GET .../repositories/:repositoryId/branches` → `listRepositoryBranches` | `getActiveLinkedRepository` = `project.view` + repo in project/workspace + connection ACTIVE | Branch names/SHA/protected/url from provider |
| Browse PRs/MRs | `GET .../repositories/:repositoryId/pull-requests` → `listRepositoryPullRequests` | same as above | PR/MR summary from provider |
| PR detail/files/commits | `GET .../pull-requests/:number`, `/files`, `/commits` | same as above | Provider PR detail, changed files/patches, commits |
| Repo commits / commit detail | `GET .../repositories/:repositoryId/commits`, `/commits/:sha` | same as above | Provider commit list/detail/files |
| List task dev-links | `GET .../tasks/:taskId/dev-links` → `listTaskDevLinks` | `requireTaskViewer` (`project.view` + task in project/workspace) | All task `TaskDevLink` rows, including `repositoryFullName`, URL, refs, review/merge state |
| Create task dev-link | `POST .../tasks/:taskId/dev-links` → `linkTaskDevLink` | `requireTaskUpdater` (`project.task.update`) + repo in project/workspace + connection ACTIVE | Created dev-link |
| Delete task dev-link | `DELETE .../tasks/:taskId/dev-links/:devLinkId` → `unlinkTaskDevLink` | `requireTaskUpdater` (`project.task.update`) | `{ok:true}` |
| Inbound webhooks | `POST /api/v1/webhooks/github`, `/gitlab` | Signature/secret verification, delivery idempotency; no user session | Updates existing `TaskDevLink` rows by provider/external id; GitHub merge may move task to SUBMITTED with audit |

**Inventory notes:** Routes are mounted in `src/routes/index.ts`; webhook raw-body routes in `src/app.ts`. No frontend code in this repo; frontend impact is based on these API contracts. No task/search/notification response currently embeds full dev-link lists beyond notification metadata; task dev-links are read via the dedicated endpoint.

## 2. Proposed Model

Add `ProjectRepositoryMember` (name illustrative) keyed by repository and user:

- Fields: `id`, `projectRepositoryId` (FK `ProjectRepository`, cascade), `projectId` (denormalized FK for query/indexing, cascade), `userId` (FK `User`), `level` enum `NONE | METADATA | READ | LINK`, `grantedById` (FK `User`, nullable/set-null for system backfill), `createdAt`, `updatedAt`.
- Constraints: unique `(projectRepositoryId, userId)`; index `(userId, projectId)`, `(projectRepositoryId, level)`.
- Role defaults: workspace/project admins and project managers get implicit effective `LINK` unless explicitly restricted; contributors/viewers/guests get no implicit repo access beyond project membership and need explicit grants, except migration backfill (see §3). Defaults are resolved in service policy, not trusted from client.
- Access rule: effective repo permission = `min(project/task permission, repository level, GitHub/GitLab installation ceiling)`. Project membership is required first; repo grant never elevates project access.

## 3. Migration / Backfill Safety

Current behavior: any project viewer can see all linked repos and browse provider data; any task updater can link any linked repo.

- **Backfill:** On migration, insert `ProjectRepositoryMember` rows for every active project member with effective project access, at `LINK` for members who currently can update/manage linked repos/tasks as applicable, otherwise `READ` for viewers. Alternatively simpler and safer: backfill `LINK` for all current project members who have `project.view` on projects with linked repos, then tighten by admin action post-deploy. Preferred: backfill equivalent to current effective capability so no user loses access at deploy.
- **Deploy ordering:** expand schema, backfill, deploy code that reads new table but treats missing row as backfilled/default during rollout window only if explicitly chosen; then enforce. Do not drop old behavior before backfill verifies.
- **New restrictions:** after backfill, admins/managers can lower levels; changes apply immediately to read/browse endpoints. Existing dev-links remain stored; visibility is filtered/redacted per §4.
- **Idempotency:** backfill job keyed by `(projectRepositoryId,userId)` upsert; rerunnable.

## 4. Level Semantics

Stage 1 enum is authoritative: `NONE | METADATA | READ | LINK`.

| Level | Linked repo metadata | Branches/commits/PR list/detail/files | Link/unlink repo to task | Task dev-links on a repo | Repo-derived notifications |
|---|---|---|---|---|---|
| `NONE` | No (behave as missing) | No (404 missing-repo shape) | No (404 missing-repo shape) | Omitted from task dev-link lists | None |
| `METADATA` | Yes: masked name only (no real `repositoryFullName`), provider/default branch/link status as allowed by masking rule | No; browse endpoints return 404 missing-repo shape | No (403 forbidden convention) | Redacted: masked repo name and state only; omit URL, refs, SHAs, PR title/number detail as needed | None containing repo name/PR title; NONE/METADATA users receive no repo-derived notification |
| `READ` | Yes (full metadata) | Yes, read-only | No (403 forbidden convention) | Full dev-link fields | Allowed by normal notification rules, no repo name/PR title in title/body |
| `LINK` | Yes (full metadata) | Yes, read-only | Yes, still requires `project.task.update` | Full dev-link fields | Allowed by normal notification rules, no repo name/PR title in title/body |

**Stage 2 defaults (where the old note is silent):**
- `NONE`: behave as if the repository does not exist (same 404 shape as a missing repo). Omit from repository lists and task dev-link lists. No repo-derived notifications.
- `METADATA`: list repository with masked name. No branches, PRs, commits, files, URLs, refs, or PR titles. Task dev-links appear with masked repo name and state only. Browse endpoints return the NONE/missing-repo 404 shape.
- `READ`: all read endpoints and full dev-link fields. Link and unlink return 403 with existing forbidden convention.
- `LINK`: READ plus link and unlink, still requiring `project.task.update`.

**Existing dev-link on inaccessible repo:** Do not delete. `NONE` links are omitted from task dev-link list responses. `METADATA` links are returned redacted (masked repo name/state only; no URL/refs/PR title/number leakage). Mutations (unlink) require task update plus `LINK`; READ/METADATA get 403 forbidden, NONE gets missing-repo 404 shape.

**Activity feed:** repo-linked activity entries must carry `projectRepositoryId`; feed queries filter by effective repo access.

## 5. GitHub Ceiling (Enforceable vs Not)

| Area | Enforceable | Not enforceable by Nexus alone |
|---|---|---|
| Installation scope | Nexus can only call GitHub APIs allowed by GitHub App installation/repo selection and token scopes. | Cannot grant access to repos outside installation. |
| Repo visibility to Nexus | Can limit to repos installation can see; can hide repos user lacks Nexus level for. | Cannot prove a Nexus user has GitHub account access to a private repo unless GitHub identity is connected and checked. |
| GitLab ceiling | Same principle with OAuth token scopes and project visibility to token. | Same identity limitation. |
| Per-user GitHub identity | Not connected today. | Nexus cannot enforce “user personally has GitHub read access”. Design must state Nexus repo access is an application-level authorization layer above project access and below provider installation ceiling. |

**Plain rule:** Nexus may deny or hide data it is allowed to fetch; it must never fetch/expose provider data beyond installation/token ceiling; it cannot guarantee GitHub-side per-user permission parity without per-user GitHub OAuth linkage.

## 6. Routes, 403 vs 404, Audit

**Route changes (design/Stage 2 enforcement):**
- Keep existing route shapes. Repo-member management endpoints are out of Stage 2 scope.
- Project repo read routes (`listProjectRepositories`): require project view; omit NONE repos; return METADATA repos with masked name and no provider content.
- Repository content/browse routes (`branches`, `pull-requests`, PR detail/files/commits, commits, commit detail): resolve repo access; READ/LINK allowed; NONE/METADATA return the same 404 shape as a missing repository. Never leak repo name, PR title, URL, or branch in errors.
- Task dev-link list: require task view; omit NONE links; return METADATA links redacted (masked repo name/state only).
- Task dev-link create: require task update + repo level `LINK`; READ/METADATA return 403 forbidden convention; NONE returns 404 missing-repo shape.
- Task dev-link delete: require task update + repo level `LINK`; READ/METADATA return 403 forbidden convention; NONE returns 404 missing-repo shape.

**Response field (Stage 2 item 3, authorized exception):** `effectiveAccessLevel` is returned on project repository list items (`LinkedProjectRepository.effectiveAccessLevel: 'NONE' | 'METADATA' | 'READ' | 'LINK'`) and task dev-link list items (`TaskDevLinkSummary.effectiveAccessLevel: RepositoryAccessLevel | null`; `null` only when no `projectRepositoryId` is attached). The frontend uses it to hide link/unlink controls for READ and METADATA. No other response field additions.

**Stage 3 member API contract:** See [REPOSITORY_ACCESS_MEMBER_API.md](./REPOSITORY_ACCESS_MEMBER_API.md) for method/path/request/response/error codes.

**403 vs 404:** Follow existing codebase convention. Stage 2 defaults: NONE behaves as missing (404 missing-repo shape). METADATA browse/content endpoints return 404 missing-repo shape (no leakage). READ/METADATA mutations that are forbidden by level return 403 with existing forbidden convention. Never leak repo name/PR title/URL/branch in errors.

**Audit events (no extra routes):** `dev_integration.repository_access_granted`, `..._changed`, `..._revoked`, `dev_integration.repository_content_access_denied` (rate-limited/security log) are future; Stage 2 does not add new audit routes. Existing audit behavior remains.

**Out of scope for Stage 2:** Workspace-level "available repositories" listing (`GET /workspaces/:wid/dev-integrations/connections/:connectionId/repos`) is connection-level, not project-repo access-level. Leave unchanged and flag as follow-up.

## 7. Frontend Impact, Tests, Open Questions

**Frontend impact:** Repository picker/list must handle empty/partial results; task dev-link UI must render restricted placeholders; branch/PR browsers need 403/404 handling; repo settings need member-level management UI; task link creation must filter repos by `LINK`.

**Tests plan:** unit policy matrix (project role x repo level x endpoint); integration tests for backfill equivalence, no-access-loss deploy, 404/403 rules, task dev-link redaction, webhook sync unaffected, unlink/link permission checks; security tests for IDOR across projects/workspaces and provider ceiling not exceeded.

**Stage 2 decisions / defaults:**
- Level names are `NONE | METADATA | READ | LINK` (Stage 1 authoritative). Old note mapping: `METADATA_ONLY->METADATA`, `ACCESS->READ`, `FULL->LINK`.
- `NONE`: missing-repo 404 shape; omitted from repo/dev-link lists; no repo-derived notifications.
- `METADATA`: masked repo name only; no branches/PRs/commits/files/URLs/refs/PR titles; task dev-links masked repo name + state only; browse/content endpoints return missing-repo 404 shape; link/unlink return 403 forbidden convention.
- `READ`: full read/browse/dev-link fields; link/unlink return 403 forbidden convention.
- `LINK`: READ plus link/unlink, still requires `project.task.update`.
- Response field name: `effectiveAccessLevel` on project repository list and task dev-link list items (see §6).

**Deliberate choices (Stage 2):**
- **METADATA browse returns 404 (not 403).** METADATA users may see masked repo metadata in the project repo list, but browse/content endpoints return the same 404 `PROJECT_REPOSITORY_NOT_FOUND` shape as NONE to avoid leaking repo existence/content surface through provider-content routes.
- **NONE dev-links are omitted.** Task dev-links for repositories with effective NONE are omitted from task dev-link list responses (not redacted) as the missing-repo/no-leak behavior.

**Known follow-up:**
- Workspace-level available repositories listing (`GET /workspaces/:wid/dev-integrations/connections/:connectionId/repos`) is connection-level, not project-repo access-level. It remains unchanged and needs a follow-up decision/implementation.
