# Design Note: Repository-Level Access

**Status:** Design only (no code, no schema).  
**Base:** `origin/main` @ `cec9b279e9bfaec350fd7412eceaf7f4fa378e3c`.  
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

- Fields: `id`, `projectRepositoryId` (FK `ProjectRepository`, cascade), `projectId` (denormalized FK for query/indexing, cascade), `userId` (FK `User`), `level` enum `NONE | METADATA_ONLY | ACCESS | FULL`, `grantedById` (FK `User`, nullable/set-null for system backfill), `createdAt`, `updatedAt`.
- Constraints: unique `(projectRepositoryId, userId)`; index `(userId, projectId)`, `(projectRepositoryId, level)`.
- Role defaults: workspace/project admins and project managers get implicit effective `FULL` unless explicitly restricted; contributors/viewers/guests get no implicit repo access beyond project membership and need explicit grants, except migration backfill (see §3). Defaults are resolved in service policy, not trusted from client.
- Access rule: effective repo permission = `min(project/task permission, repository level, GitHub/GitLab installation ceiling)`. Project membership is required first; repo grant never elevates project access.

## 3. Migration / Backfill Safety

Current behavior: any project viewer can see all linked repos and browse provider data; any task updater can link any linked repo.

- **Backfill:** On migration, insert `ProjectRepositoryMember` rows for every active project member with effective project access, at `FULL` for members who currently can update/manage linked repos/tasks as applicable, otherwise `ACCESS` for viewers. Alternatively simpler and safer: backfill `FULL` for all current project members who have `project.view` on projects with linked repos, then tighten by admin action post-deploy. Preferred: backfill equivalent to current effective capability so no user loses access at deploy.
- **Deploy ordering:** expand schema, backfill, deploy code that reads new table but treats missing row as backfilled/default during rollout window only if explicitly chosen; then enforce. Do not drop old behavior before backfill verifies.
- **New restrictions:** after backfill, admins/managers can lower levels; changes apply immediately to read/browse endpoints. Existing dev-links remain stored; visibility is filtered/redacted per §4.
- **Idempotency:** backfill job keyed by `(projectRepositoryId,userId)` upsert; rerunnable.

## 4. Level Semantics

| Level | Linked repo metadata | Branches/commits/PR list/detail/files | Link repo to task | Task dev-links on a repo | Activity/feed |
|---|---:|---:|---:|---:|---|
| `NONE` | No | No | No | Hidden/redacted (see below) | No repo-detail events |
| `METADATA_ONLY` | Yes: name, provider, default branch, link status | No provider content | No | Redacted placeholder: linked exists, repo name hidden unless separately allowed; prefer “restricted repository link” | Metadata only |
| `ACCESS` | Yes | Yes, read-only | No | Yes for visible repos | Yes |
| `FULL` | Yes | Yes | Yes, if user also has `project.task.update` | Yes | Yes |

**Existing dev-link on inaccessible repo:** Do not delete. For list/detail responses, filter out `NONE` rows entirely from repo browsing. For task dev-links, return a redacted summary when the viewer can see the task but lacks repo access: omit `url`, `repositoryFullName`, refs/SHAs, provider detail as needed, include `accessLevel`/`restricted:true`. This avoids leaking private repo metadata through tasks. Mutations (unlink) require task update plus `FULL` on the link's repo, or a manager override rule explicitly decided.

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

**Route changes (design):**
- Keep existing route shapes. Add repo-member management endpoints under project repositories or a dedicated subresource, e.g. `GET/PUT/DELETE .../repositories/:repositoryId/members` (manager-only).
- Read routes (`branches`, `pull-requests`, commits, PR detail/files/commits): resolve repo, then require project view + repo level >= `ACCESS` + active connection.
- Task dev-link list: return only links for repos at `METADATA_ONLY+` as redacted/visible per level; never leak `NONE`.
- Task dev-link create: require task update + repo level `FULL`.
- Task dev-link delete: require task update + repo level `FULL` (or explicit admin override).

**403 vs 404:** Use `404` when the repository/resource is outside project/workspace or should be hidden from users without any project/repo visibility signal; use `403` when user can know the project/repo exists but lacks required level (e.g. manager viewing member settings, or METADATA_ONLY user hitting branches endpoint). Default for read-content endpoints: `404` for `NONE` to avoid repo existence leak; `403` for `METADATA_ONLY` attempting provider content if metadata is intentionally visible. Document chosen rule in API contract before implementation.

**Audit events (no extra routes):** `dev_integration.repository_access_granted`, `..._changed`, `..._revoked`, `dev_integration.repository_content_access_denied` (rate-limited/security log), include actor, workspace/project/repository, target user, old/new level, request id. Do not audit routine allowed reads.

## 7. Frontend Impact, Tests, Open Questions

**Frontend impact:** Repository picker/list must handle empty/partial results; task dev-link UI must render restricted placeholders; branch/PR browsers need 403/404 handling; repo settings need member-level management UI; task link creation must filter repos by `FULL`.

**Tests plan:** unit policy matrix (project role x repo level x endpoint); integration tests for backfill equivalence, no-access-loss deploy, 404/403 rules, task dev-link redaction, webhook sync unaffected, unlink/link permission checks; security tests for IDOR across projects/workspaces and provider ceiling not exceeded.

**Open questions:**
- Should `METADATA_ONLY` expose `repositoryFullName` or a masked label?
- Can project managers override repo restrictions they did not create? (recommended yes, with audit).
- How should unlink behave when user loses `FULL` after linking? (recommend deny unless manager override).
- Should activity feed show “restricted repo activity” placeholder or omit?
- Do we need per-user GitHub identity linking for parity-sensitive orgs? (future; not required for Nexus-level enforcement).
- Should connection-level available repos be filtered by any project repo grants? (currently workspace-view; likely keep but avoid leaking linked-project details).