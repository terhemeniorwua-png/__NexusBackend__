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

**Inventory notes:** Routes are mounted in `src/routes/index.ts`; webhook raw-body routes in `src/app.ts`. No frontend code in this repo; frontend impact is based on these API contracts. Task dev-links are read via the dedicated endpoint; BE-5b also emits `GITHUB_PR_MERGED` / `GITHUB_PR_REVIEW_RECEIVED` notifications with repo/PR metadata in structured notification data.

## 2. Proposed Model

Add `ProjectRepositoryMember` (name illustrative) keyed by repository and user:

- **Fields:** `id`, `projectRepositoryId` (FK `ProjectRepository`, cascade), `projectId` (denormalized FK for query/indexing, cascade), `userId` (FK `User`), `level` enum `NONE | METADATA | READ | LINK`, `grantedById` (FK `User`, nullable/set-null for system/audit context), `createdAt`, `updatedAt`.
- **Constraints:** unique `(projectRepositoryId, userId)`; index `(userId, projectId)`, `(projectRepositoryId, level)`.
- **Levels:**
  - `NONE` — no repository visibility or content access.
  - `METADATA` — may know a restricted repository link exists / see masked metadata as allowed by policy, but no provider content and no linking.
  - `READ` — may browse repository/provider content (branches, PRs/MRs, commits, files/detail) read-only.
  - `LINK` — may link repositories to tasks (and implies READ for repo content), subject to task/project permissions.
- **Role-default resolver (no per-member backfill rows required):** effective default level comes from project role:
  - viewer = `READ`
  - contributor and above = `LINK`
  - managers/admins = implicit `LINK`
- **`ProjectRepositoryMember` rows are explicit overrides only.** Members added after deploy receive the role-default level and keep today's effective access. No bulk backfill is needed. **Deploy changes no one's access.**
- **Access rule:** effective repo permission = `min(project/task permission, repository effective level, GitHub/GitLab installation ceiling)`. Project membership is required first; repo grant never elevates project access. Defaults/overrides are resolved server-side, never trusted from client.

## 3. Migration / Backfill Safety

Current behavior: any project viewer can see all linked repos and browse provider data; any task updater can link any linked repo.

- **Model:** role-default resolver + explicit override rows. No bulk backfill is needed. Existing and newly added project members get the same effective access they have today through project role defaults.
- **Deploy safety:** deploy changes no one's access. The migration introduces schema and resolver support; enforcement is rolled out by staged plan (§7). Missing override row means "use role default", not "deny".
- **New restrictions:** after enforcement is enabled, admins/managers can lower levels via explicit override rows; changes apply immediately to read/browse endpoints. Existing dev-links remain stored; visibility is filtered/redacted per §4 and §5.
- **Idempotency:** override writes keyed by `(projectRepositoryId,userId)` upsert; rerunnable. No backfill job required.

**Migration name:** `20261121600000_repository_access` (must sort after `20261121400000_github_sync`).

## 4. Level Semantics

| Level | Linked repo metadata | Branches/commits/PR list/detail/files | Link repo to task | Task dev-links on a repo | Activity/feed |
|---|---:|---:|---:|---:|---|
| `NONE` | No | No | No | Hidden/redacted | No repo-detail events |
| `METADATA` | Masked only (e.g. "Restricted repository"); no `repositoryFullName`, URL, refs, provider IDs | No | No | Redacted placeholder: linked exists, repo identity hidden | No repo-detail entries |
| `READ` | Yes | Yes, read-only | No | Yes for visible repos | Yes, subject to repo access |
| `LINK` | Yes | Yes | Yes, if user also has `project.task.update` | Yes | Yes, subject to repo access |

**Existing dev-link on inaccessible repo:** Do not delete. For repo browsing, `NONE` is hidden. For task dev-links, when viewer can see the task but lacks repo access: `NONE` rows are omitted/hidden as required to avoid existence leaks; `METADATA` returns a redacted placeholder with no `url`, `repositoryFullName`, refs/SHAs, PR title, or provider detail, and includes `accessLevel`/`restricted:true` as needed. Mutations: task dev-link create requires task update + repo level `LINK`; unlink requires `LINK` or manager/admin override (audited). Existing links remain stored/redacted.

**Activity/feed:** repo-linked activity/feed entries must carry `projectRepositoryId` and are filtered by effective repo access. Omit repo-detail entries the viewer cannot access; no “restricted repo activity” placeholder.

## 5. Notification and Other Leak Surfaces

This section is a decision surface for implementation; no access logic is added in this design-only change.

- **BE-5b notifications:** `GITHUB_PR_MERGED` / `GITHUB_PR_REVIEW_RECEIVED` currently carry repo/PR metadata in structured notification data. Rule: recipients without `READ` on the repo get a generic notification with no repo name, PR title, or URL. Recipients with `READ` may receive the detailed metadata allowed by policy.
- **Task dev-link responses:** dedicated dev-link endpoints and any future embedded task payloads must apply the same redaction/filtering rules as §4. Do not expose `repositoryFullName`, PR title, URL, refs, SHAs, or provider IDs to users without sufficient repo access.
- **Search results:** repository-aware search/index entries must include `projectRepositoryId`/access scope. Users without `READ` must not receive repo name, PR title, URL, or content snippets from repo-backed records; exclude or generically redact as appropriate.
- **Audit entries:** audit logs may retain full internal metadata for authorized audit consumers/admin flows, but user-facing activity/audit views must filter/redact repo details by effective repo access. Security/audit events for access changes are visible only to authorized managers/admins.
- **Activity feeds:** omit repo-detail entries the viewer cannot access; no placeholder that leaks metadata.
- **Webhooks/provider sync:** inbound webhooks remain signature/idempotency verified and continue updating existing `TaskDevLink` rows. Webhook processing must not bypass Nexus authorization when emitting user-visible notifications/feed/search projections.

## 6. GitHub Ceiling (Enforceable vs Not)

| Area | Enforceable | Not enforceable by Nexus alone |
|---|---|---|
| Installation scope | Nexus can only call GitHub APIs allowed by GitHub App installation/repo selection and token scopes. | Cannot grant access to repos outside installation. |
| Repo visibility to Nexus | Can limit to repos installation can see; can hide repos user lacks Nexus level for. | Cannot prove a Nexus user has GitHub account access to a private repo unless GitHub identity is connected and checked. |
| GitLab ceiling | Same principle with OAuth token scopes and project visibility to token. | Same identity limitation. |
| Per-user GitHub identity | Not connected today. | Nexus cannot enforce “user personally has GitHub read access”. Nexus repo access is an application-level authorization layer above project access and below provider installation ceiling. |

**Plain rule:** Nexus may deny or hide data it is allowed to fetch; it must never fetch/expose provider data beyond installation/token ceiling; it cannot guarantee GitHub-side per-user permission parity without per-user GitHub OAuth linkage.

## 7. Decisions, Routes, and Audit

### Decisions (recorded)
- **404 for `NONE`** on repository/content endpoints to avoid repo existence leaks.
- **403 for `METADATA`** on content endpoints (branches, PRs/MRs, commits, files/detail, and any provider-content endpoint) where the user can know a restricted link exists but lacks `READ`.
- **No bulk backfill.** Role defaults provide equivalent current access; explicit `ProjectRepositoryMember` rows are overrides only. Deploy changes no one's access.
- **Migration:** `20261121600000_repository_access` (must sort after `20261121400000_github_sync`).

### Route changes (design)
- Keep existing route shapes. Add repo-member management endpoints under project repositories or a dedicated subresource, e.g. `GET/PUT/DELETE .../repositories/:repositoryId/members` (manager-only).
- Read routes (`branches`, `pull-requests`, commits, PR detail/files/commits): resolve repo, then require project view + repo level >= `READ` + active connection. Return 404 for `NONE`, 403 for `METADATA`.
- Task dev-link list: filter/hide `NONE`; return redacted placeholder for `METADATA` when the viewer can see the task; return full allowed details for `READ`/`LINK`.
- Task dev-link create: require task update + repo level `LINK`.
- Task dev-link delete: require task update + repo level `LINK`, or explicit manager/admin override (audited).

### Audit events (no extra routes)
- `dev_integration.repository_access_granted`, `..._changed`, `..._revoked`, `dev_integration.repository_content_access_denied` (rate-limited/security log).
- Include actor, workspace/project/repository, target user, old/new level, request id. Do not audit routine allowed reads.

## 8. Staged Plan

1. **Stage 1 — Schema and role-default resolver**
   - Add migration `20261121600000_repository_access` (after `20261121400000_github_sync`).
   - Introduce `ProjectRepositoryMember` override table and `NONE|METADATA|READ|LINK` enum.
   - Implement server-side role-default resolver (viewer=READ, contributor and above=LINK, managers/admins implicit LINK). No bulk backfill; missing override row uses role default. Deploy changes no one's access.

2. **Stage 2 — Enforcement on repo and task dev-link routes**
   - Enforce effective repo level on repository browse/content routes and task dev-link list/create/delete.
   - Apply 404 for `NONE`, 403 for `METADATA` on content endpoints.
   - Apply dev-link redaction/filtering and BE-5b notification/search/activity/feed leak-surface rules.

3. **Stage 3 — Manager endpoints and audit events**
   - Add manager-only repo member override endpoints.
   - Emit audit events for grant/change/revoke/denied-access security logging.
   - Add UI/API contract support for restricted placeholders and manager override management.

## 9. Frontend Impact, Tests, Defaults

**Frontend impact:** Repository picker/list must handle empty/partial results; task dev-link UI must render restricted placeholders; branch/PR browsers need 403/404 handling; repo settings need member-level management UI; task link creation must filter repos by `LINK`; notification UI must handle generic/redacted repo notifications.

**Tests plan:** unit policy matrix (project role x repo level x endpoint); integration tests for role-default equivalence, no-access-loss deploy, 404/403 rules, task dev-link redaction, webhook sync unaffected, unlink/link permission checks; security tests for IDOR across projects/workspaces, provider ceiling not exceeded, and notification/search/activity/feed leak surfaces.

**Defaults (selected):**
- `METADATA` exposes a masked label (e.g. “Restricted repository”), not `repositoryFullName`, URL, refs, or provider IDs.
- Project managers/admins can override repo restrictions they did not create; every grant/change/revoke is audited.
- If a user loses `LINK`, task-dev-link create is denied; unlink requires `LINK` or manager/admin override (audited). Existing links remain stored/redacted.
- Activity/feed omits repo-detail entries the viewer cannot access; no “restricted repo activity” placeholder (avoids metadata leak).
- Per-user GitHub identity linking is deferred/future; not required for Nexus-level enforcement. Document parity limitation plainly.
- Connection-level available-repo listing remains workspace-view scoped and does not expose project-repo grant details; project linking UI filters selectable repos by repos the actor can manage/link.
