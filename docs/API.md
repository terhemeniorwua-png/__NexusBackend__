# Nexus Backend API

This file is a human-readable index of the HTTP routes currently registered by
the backend. The OpenAPI contract is maintained in [`openapi.yaml`](./openapi.yaml).
Route behavior and schemas must be checked against the source modules; a route
listed here is not evidence that a roadmap phase is complete.

## Base path and conventions

- API base path: `/api/v1` (`apiPrefix` in `src/config/env.ts`).
- Success responses use the `{ "success": true, "data": ... }` envelope.
- Errors are handled centrally and use the project's `AppError` contract.
- Unless noted as public, authenticated routes require a valid bearer access
  token. Workspace operations also enforce the caller's membership and resource
  permissions in the service layer.
- Request bodies, route parameters, and query parameters are validated by the
  route schemas before service calls.

## Health

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | Public | Liveness information. |
| GET | `/health/live` | Public | Liveness probe. |
| GET | `/health/ready` | Public | Readiness and dependency status; returns 503 when not ready. |

## Authentication and account lifecycle

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/register` | Public, rate limited | Register an account. |
| POST | `/auth/verify-email` | Public, rate limited | Verify an email address. |
| POST | `/auth/resend-verification` | Public, rate limited | Resend email verification. |
| POST | `/auth/login` | Public, rate limited | Start an authenticated session. |
| POST | `/auth/reactivate` | Public, rate limited | Reactivate an eligible deactivated account. |
| POST | `/auth/refresh` | Public, refresh credential required | Rotate/refresh the session token. |
| POST | `/auth/logout` | Public, refresh credential required | Revoke the submitted session token. |
| POST | `/auth/logout-all` | Authenticated | Revoke all sessions for the caller. |
| GET | `/auth/sessions` | Authenticated | List the caller's sessions. |
| GET | `/auth/me` | Authenticated | Return the authenticated account. |
| POST | `/auth/password/forgot` | Public, rate limited | Request password reset. |
| POST | `/auth/password/reset` | Public, rate limited | Complete password reset. |
| POST | `/auth/password/change` | Authenticated | Change the caller's password. |
| POST | `/auth/email/change` | Authenticated | Request an email change. |
| POST | `/auth/email/change/confirm` | Public, rate limited | Confirm an email change. |
| POST | `/auth/deactivate` | Authenticated | Deactivate the caller's account. |
| POST | `/auth/delete` | Authenticated, rate limited | Request account deletion. |

## User profile

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/users/me` | Authenticated, active account | Read the caller's profile. |
| PATCH | `/users/me` | Authenticated, active account | Update the caller's profile. |

## Workspaces

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/workspaces` | Authenticated, active account | Create a workspace. |
| GET | `/workspaces` | Authenticated, active account | List the caller's workspaces. |
| GET | `/workspaces/{workspaceId}` | Workspace member | Read a workspace. |
| PATCH | `/workspaces/{workspaceId}` | Workspace member with permission | Update workspace details. |
| POST | `/workspaces/{workspaceId}/archive` | Workspace member with permission | Archive a workspace. |
| POST | `/workspaces/{workspaceId}/restore` | Workspace owner | Restore an archived workspace. |
| DELETE | `/workspaces/{workspaceId}` | Workspace member with permission | Delete a workspace where allowed. |
| POST | `/workspaces/{workspaceId}/switch` | Workspace member | Validate/switch the caller's active workspace. |
| PATCH | `/workspaces/{workspaceId}/owner/{userId}` | Workspace owner | Transfer workspace ownership. |
| GET | `/workspaces/{workspaceId}/members` | Workspace member | List workspace members. |
| POST | `/workspaces/{workspaceId}/members` | Workspace member with permission | Add a member. |
| PATCH | `/workspaces/{workspaceId}/members/{userId}` | Workspace member with permission | Change a member's role. |
| DELETE | `/workspaces/{workspaceId}/members/{userId}` | Workspace member with permission | Remove a member. |
| POST | `/workspaces/{workspaceId}/members/{userId}/suspend` | Workspace member with permission | Suspend a member. |
| POST | `/workspaces/{workspaceId}/members/{userId}/restore` | Workspace member with permission | Restore a suspended member. |
| GET | `/workspaces/{workspaceId}/departments` | Authorized workspace member | List visible departments. |
| POST | `/workspaces/{workspaceId}/departments` | Institution owner/admin | Create a department. |
| POST | `/workspaces/{workspaceId}/departments/{departmentId}/members` | Authorized workspace member | Assign a member to a department. |
| DELETE | `/workspaces/{workspaceId}/departments/{departmentId}/members/{targetUserId}` | Authorized workspace member | Remove a department assignment. |

Personal workspaces cannot be archived or removed through the ordinary
workspace lifecycle routes; account deletion owns that lifecycle.

Archiving an organization workspace expires pending invitations whose deadline
has passed and revokes the remaining pending invitations in the same
transaction. Archived workspaces cannot be switched into or used to create,
resend, or accept invitations. Restoring a workspace does not reactivate
invitations that were revoked during archival; administrators can issue new
invitations.

## Teams

All team routes are nested under a workspace and require an authenticated,
active account. Workspace membership and team-level permissions are enforced
by the team service; knowing a team or user ID does not grant access.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/workspaces/{workspaceId}/teams` | Authorized workspace member | List teams; `includeArchived=true` includes archived teams. |
| POST | `/workspaces/{workspaceId}/teams` | Authorized workspace member with create permission | Create a team and optionally assign its lead. |
| GET | `/workspaces/{workspaceId}/teams/{teamId}` | Authorized workspace/team member | Read a team. |
| PATCH | `/workspaces/{workspaceId}/teams/{teamId}` | Authorized team manager | Update the team name or description. |
| POST | `/workspaces/{workspaceId}/teams/{teamId}/archive` | Authorized team manager | Archive a team. |
| DELETE | `/workspaces/{workspaceId}/teams/{teamId}` | Authorized team manager | Soft-delete a team. |
| GET | `/workspaces/{workspaceId}/teams/{teamId}/members` | Authorized team member | List team members. |
| POST | `/workspaces/{workspaceId}/teams/{teamId}/members` | Authorized team manager | Add a workspace member to the team. |
| PATCH | `/workspaces/{workspaceId}/teams/{teamId}/members/{userId}` | Authorized team manager | Change a team member's role. |
| DELETE | `/workspaces/{workspaceId}/teams/{teamId}/members/{userId}` | Authorized team manager | Remove a member from the team. |
| PATCH | `/workspaces/{workspaceId}/teams/{teamId}/lead` | Authorized team manager | Assign or clear the team lead. |

## Invitations

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/workspaces/{workspaceId}/invitations` | Workspace member with permission | List invitations, optionally filtered by status. |
| POST | `/workspaces/{workspaceId}/invitations` | Workspace member with permission, rate limited | Create an invitation. |
| POST | `/workspaces/{workspaceId}/invitations/{invitationId}/resend` | Workspace member with permission, rate limited | Resend a pending invitation. |
| DELETE | `/workspaces/{workspaceId}/invitations/{invitationId}` | Workspace member with permission | Revoke an invitation. |
| GET | `/invitations` | Authenticated, active account | List invitations addressed to the caller. |
| GET | `/invitations/{token}` | Public, rate limited | Preview an invitation. |
| POST | `/invitations/{token}/accept` | Authenticated, active account | Accept an invitation addressed to the caller. |
| POST | `/invitations/{token}/decline` | Authenticated, active account | Decline an invitation addressed to the caller. |

## Workspace discovery and join requests

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/workspaces/discover` | Authenticated, active account | Discover joinable workspaces. |
| POST | `/workspaces/join` | Authenticated, active account, rate limited | Request to join using a join code. |
| GET | `/workspaces/join-requests/mine` | Authenticated, active account | List the caller's join requests. |
| POST | `/workspaces/{workspaceId}/join-requests` | Authenticated, active account, rate limited | Submit a workspace join request. |
| GET | `/workspaces/{workspaceId}/join-requests` | Workspace administrator | List workspace join requests, optionally filtered by status. |
| POST | `/workspaces/{workspaceId}/join-requests/{requestId}/approve` | Workspace administrator | Approve a join request. |
| POST | `/workspaces/{workspaceId}/join-requests/{requestId}/reject` | Workspace administrator | Reject a join request. |
| DELETE | `/workspaces/join-requests/{requestId}` | Request owner | Withdraw a pending join request. |
| POST | `/workspaces/{workspaceId}/join-code` | Workspace administrator | Rotate/enable a join code. |
| DELETE | `/workspaces/{workspaceId}/join-code` | Workspace administrator | Disable a join code. |

## Email provider webhooks

These routes are mounted at `/api/v1/webhooks` and authenticate provider
events using the configured signature or webhook token, not a user session.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/webhooks/email` | Provider verification required | Receive an email delivery event. |
| POST | `/webhooks/email/{token}` | Configured webhook token required | Receive an email event from providers without signed payloads. |

## Not exposed as HTTP APIs

The current application router does not expose billing, projects, tasks,
messaging, general notifications, files, documents, calendar, meetings, forms,
search, integrations, automation, or AI endpoints. Billing policy helpers and
authorization policies present in the source do not constitute those APIs.
Do not add endpoints to this reference or `openapi.yaml` until matching routes,
validation, authorization, service behavior, and response contracts exist.

## Updating this API reference

After each backend phase that adds, changes, or removes an externally visible
route or response contract, update this route index and `openapi.yaml` in the
same phase change. Verify both against the registered Express routers and
schemas. Do not document planned behavior as live API functionality. If a
phase changes no HTTP contract, record that no API update was required in the
phase completion notes.
