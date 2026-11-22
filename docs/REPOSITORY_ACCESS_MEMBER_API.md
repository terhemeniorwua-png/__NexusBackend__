# Repository Access Member API (BE-9 Stage 3)

Base: `/workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId/members`  
Auth: `requireAuth` + `requireActiveAccount` + project repository manager permission (`ProjectPermission.Update`, same gate as repository link/unlink).

Levels: `NONE | METADATA | READ | LINK` only. Old names `METADATA_ONLY`, `ACCESS`, `FULL` are rejected.

## Existing response field (BE-9 #159, unchanged)

`effectiveAccessLevel` is present on:
- Project repository list items: `LinkedProjectRepository.effectiveAccessLevel: 'NONE' | 'METADATA' | 'READ' | 'LINK'`
- Task dev-link list items: `TaskDevLinkSummary.effectiveAccessLevel: 'NONE' | 'METADATA' | 'READ' | 'LINK' | null` — `null` when `projectRepositoryId` is null (no linked repository attached).

## GET /workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId/members

Lists users with effective project access and their repository access level.

**Params**
- `workspaceId` (uuid)
- `projectId` (uuid)
- `repositoryId` (uuid)

**Response 200** (`data`): `RepositoryAccessMember[]`

`RepositoryAccessMember`:
- `userId`: string (uuid)
- `effectiveAccessLevel`: `'NONE' | 'METADATA' | 'READ' | 'LINK'`
- `defaultLevel`: `'NONE' | 'METADATA' | 'READ' | 'LINK'`
- `isOverride`: boolean
- `overrideLevel`: `'NONE' | 'METADATA' | 'READ' | 'LINK' | null`
- `inheritedWorkspaceAccess`: boolean — `true` when the user has project access through inherited workspace access (no direct `ProjectMembership` row; e.g. workspace admin/team/department/workspace-visible access source). UI can use this to explain why the user appears.
- `user`: `{ id: string; name: string | null; email: string }`

**Errors**
- `401 AUTHENTICATION_REQUIRED` / auth middleware errors
- `403 PERMISSION_DENIED` — caller lacks manager permission
- `404 PROJECT_REPOSITORY_NOT_FOUND` — repository missing/not in project/workspace
- `404 PROJECT_NOT_FOUND` / project access errors from authorization as applicable

## PUT /workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId/members/:userId

Sets an explicit repository access override for a target user.

**Params**
- `workspaceId` (uuid)
- `projectId` (uuid)
- `repositoryId` (uuid)
- `userId` (uuid, target user)

**Body**
```json
{ "level": "NONE" | "METADATA" | "READ" | "LINK" }
```

**Response 200** (`data`): `RepositoryAccessMember` (resulting state, `isOverride=true`, `overrideLevel=level`, `effectiveAccessLevel=level`)

**Errors**
- `400 VALIDATION_ERROR` — invalid body/params; `level` must be one of `NONE,METADATA,READ,LINK` (old names `METADATA_ONLY,ACCESS,FULL` rejected)
- `401 AUTHENTICATION_REQUIRED`
- `403 PERMISSION_DENIED` — caller lacks manager permission
- `404 PROJECT_REPOSITORY_NOT_FOUND`
- `404 PROJECT_MEMBER_NOT_FOUND` — target is not an active project-access member (includes inherited workspace access resolution)

**Audit**
- `dev_integration.repository_access_override_set` (targetType `ProjectRepositoryMember`, targetId repositoryId). Metadata: `projectId, repositoryId, targetUserId, oldOverrideLevel, newOverrideLevel, oldEffectiveLevel, newEffectiveLevel`. No repo name or PR data.

## DELETE /workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId/members/:userId

Removes explicit override; returns user to default level. **Idempotent:** returns 200 with resulting default state whether or not an override existed.

**Params**
- `workspaceId` (uuid)
- `projectId` (uuid)
- `repositoryId` (uuid)
- `userId` (uuid, target user)

**Response 200** (`data`): `RepositoryAccessMember` (resulting default state, `isOverride=false`, `overrideLevel=null`, `effectiveAccessLevel=defaultLevel`)

**Errors**
- `401 AUTHENTICATION_REQUIRED`
- `403 PERMISSION_DENIED` — caller lacks manager permission
- `404 PROJECT_REPOSITORY_NOT_FOUND`
- `404 PROJECT_MEMBER_NOT_FOUND` — target is not an active project-access member

**Audit**
- `dev_integration.repository_access_override_removed` only when an override existed. Metadata: `projectId, repositoryId, targetUserId, oldOverrideLevel, newOverrideLevel:null, oldEffectiveLevel, newEffectiveLevel`. No repo name or PR data.

## Behavior notes (unchanged by Stage 3)
- NONE: browse/content 404 `PROJECT_REPOSITORY_NOT_FOUND`; repo omitted from project repo list; task dev-links omitted.
- METADATA: repo listed masked (`fullName="Restricted repository"`, `externalRepoId="restricted"`, `defaultBranch=null`); browse 404 same as NONE; task dev-links redacted to masked name and state only.
- READ: read endpoints allowed; link/unlink 403 `PERMISSION_DENIED`.
- LINK: READ plus link/unlink, requiring `project.task.update`.
- Defaults: VIEWER or workspace-wide read with no project role => READ; other project roles => LINK; explicit override wins.
- A project manager who overrides themselves to NONE can still call these management endpoints (gated by project update permission, not repository access level).
