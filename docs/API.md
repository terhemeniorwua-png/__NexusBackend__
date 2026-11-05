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

| Method | Path            | Access | Purpose                                                      |
| ------ | --------------- | ------ | ------------------------------------------------------------ |
| GET    | `/health`       | Public | Liveness information.                                        |
| GET    | `/health/live`  | Public | Liveness probe.                                              |
| GET    | `/health/ready` | Public | Readiness and dependency status; returns 503 when not ready. |

## Authentication and account lifecycle

| Method | Path                         | Access                              | Purpose                                                                                                                                |
| ------ | ---------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/register`             | Public, rate limited                | Register an account.                                                                                                                   |
| POST   | `/auth/verify-email`         | Public, rate limited                | Verify an email address.                                                                                                               |
| POST   | `/auth/resend-verification`  | Public, rate limited                | Resend email verification.                                                                                                             |
| POST   | `/auth/login`                | Public, rate limited                | Start an authenticated session.                                                                                                        |
| POST   | `/auth/reactivate`           | Public, rate limited                | Reactivate a deactivated account or cancel a pending deletion during its 30-day recovery period.                                                      |
| POST   | `/auth/refresh`              | Public, refresh credential required | Rotate/refresh the session token.                                                                                                      |
| POST   | `/auth/logout`               | Public, refresh credential required | Revoke the submitted session token.                                                                                                    |
| POST   | `/auth/logout-all`           | Authenticated                       | Revoke all sessions for the caller.                                                                                                    |
| GET    | `/auth/sessions`             | Authenticated                       | List the caller's sessions.                                                                                                            |
| GET    | `/auth/me`                   | Authenticated                       | Return the authenticated account.                                                                                                      |
| POST   | `/auth/password/forgot`      | Public, rate limited                | Request password reset.                                                                                                                |
| POST   | `/auth/password/reset`       | Public, rate limited                | Complete password reset.                                                                                                               |
| POST   | `/auth/password/change`      | Authenticated                       | Change the caller's password.                                                                                                          |
| POST   | `/auth/email/change`         | Authenticated                       | Request an email change.                                                                                                               |
| POST   | `/auth/email/change/confirm` | Public, rate limited                | Confirm an email change.                                                                                                               |
| POST   | `/auth/deactivate`           | Authenticated                       | Deactivate the caller's account.                                                                                                       |
| POST   | `/auth/delete`               | Authenticated, rate limited         | Schedule deletion 30 days later; access and sessions are revoked immediately, and the account can be recovered before the deadline. |

### Account deletion request and frontend behavior

`POST /api/v1/auth/delete` accepts `{ "currentPassword": string, "confirmation": string }`, where `confirmation` must exactly match the signed-in account email. A successful response is HTTP 202 with `{ "success": true, "data": { "status": "PENDING_DELETION", "scheduledDeletionAt": "ISO-8601 timestamp" } }`. The response clears session cookies; the access token is also revoked server-side. Show the deadline and explain that recovery requires the same email and password before it. Recovery uses `POST /api/v1/auth/reactivate` with `{ "email": string, "password": string }`; success returns the user but does not create a session.

The frontend should explain that a workspace without an accepted ownership transfer will be suspended at the deletion request and remains suspended until a successor accepts. Owners may start a transfer during the 30-day recovery period. Initiate with `PATCH /api/v1/workspaces/{workspaceId}/owner/{userId}`; the actual response is `{ "transferId": "uuid", "status": "PENDING" }`. The intended recipient can list transfers with `GET /api/v1/workspaces/owner-transfers/incoming?limit=50&offset=0`, then accept with `POST /api/v1/workspaces/{workspaceId}/owner-transfers/{transferId}/accept` or reject with `/reject` (no body). Acceptance returns `workspaceId` and `billingAcceptanceRequired`. When that value is true, the new owner must separately accept billing with `POST /api/v1/workspaces/{workspaceId}/owner-transfers/{transferId}/billing-acceptance` (no body). Billing acceptance cannot be inferred from workspace ownership. The inbox contains only unexpired pending transfers where the caller remains an active member and the initiator still owns the workspace. These operations require an authenticated active account; backend services validate owner, recipient, workspace, transfer status and billing state.

The backend does not provide frontend screens, notifications or workflow orchestration for these steps. The separate frontend must add: a deletion confirmation and recovery-deadline view; a workspace ownership/suspension summary; recipient acceptance actions; distinct billing-responsibility consent; and recovery/sign-in guidance. The frontend must not claim deletion is final at request time.

## User profile

| Method | Path        | Access                        | Purpose                      |
| ------ | ----------- | ----------------------------- | ---------------------------- |
| GET    | `/users/me` | Authenticated, active account | Read the caller's profile.   |
| PATCH  | `/users/me` | Authenticated, active account | Update the caller's profile. |

## Workspaces

| Method | Path                                                                          | Access                                     | Purpose                                        |
| ------ | ----------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| POST   | `/workspaces`                                                                 | Authenticated, active account              | Create a workspace.                            |
| GET    | `/workspaces`                                                                 | Authenticated, active account              | List the caller's workspaces.                  |
| GET    | `/workspaces/{workspaceId}`                                                   | Workspace member                           | Read a workspace.                              |
| PATCH  | `/workspaces/{workspaceId}`                                                   | Workspace member with permission           | Update workspace details.                      |
| POST   | `/workspaces/{workspaceId}/archive`                                           | Workspace member with permission           | Archive a workspace.                           |
| POST   | `/workspaces/{workspaceId}/restore`                                           | Workspace owner                            | Restore an archived workspace.                 |
| DELETE | `/workspaces/{workspaceId}`                                                   | Workspace member with permission           | Delete a workspace where allowed.              |
| POST   | `/workspaces/{workspaceId}/switch`                                            | Workspace member                           | Validate/switch the caller's active workspace. |
| PATCH  | `/workspaces/{workspaceId}/owner/{userId}`                                    | Workspace owner                            | Transfer workspace ownership.                  |
| POST   | `/workspaces/{workspaceId}/owner-transfers/{transferId}/accept`              | Intended active workspace member           | Accept a pending ownership transfer.           |
| GET    | `/workspaces/owner-transfers/incoming`                                       | Authenticated, active recipient             | List only the caller's eligible, unexpired pending transfer offers (`limit`, `offset`). |
| POST   | `/workspaces/{workspaceId}/owner-transfers/{transferId}/reject`              | Intended active workspace member           | Reject a pending transfer; expired offers are marked expired and return `409`. |
| POST   | `/workspaces/{workspaceId}/owner-transfers/{transferId}/billing-acceptance`   | New workspace owner                        | Explicitly accept subscription billing responsibility. |
| POST   | `/workspaces/{workspaceId}/admin-owner/{userId}`                             | Platform administrator                    | Assign an owner after final deletion; workspace remains suspended. |
| GET    | `/workspaces/{workspaceId}/members`                                           | Workspace member                           | List workspace members.                        |
| POST   | `/workspaces/{workspaceId}/members`                                           | Workspace member with permission           | Add a member.                                  |
| PATCH  | `/workspaces/{workspaceId}/members/{userId}`                                  | Workspace member with permission           | Change a member's role.                        |
| DELETE | `/workspaces/{workspaceId}/members/{userId}`                                  | Workspace member with permission           | Remove a member.                               |
| POST   | `/workspaces/{workspaceId}/members/{userId}/suspend`                          | Workspace member with permission           | Suspend a member.                              |
| POST   | `/workspaces/{workspaceId}/members/{userId}/restore`                          | Workspace member with permission           | Restore a suspended member.                    |
| GET    | `/workspaces/{workspaceId}/departments`                                       | Authorized workspace member                | List visible departments.                      |
| POST   | `/workspaces/{workspaceId}/departments`                                       | Institution owner/admin                    | Create a department.                           |
| PATCH  | `/workspaces/{workspaceId}/departments/{departmentId}`                        | Department head or institution owner/admin | Rename a department.                           |
| POST   | `/workspaces/{workspaceId}/departments/{departmentId}/members`                | Authorized workspace member                | Assign a member to a department.               |
| DELETE | `/workspaces/{workspaceId}/departments/{departmentId}/members/{targetUserId}` | Authorized workspace member                | Remove a department assignment.                |

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

| Method | Path                                                        | Access                                             | Purpose                                                                   |
| ------ | ----------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| GET    | `/workspaces/{workspaceId}/teams`                           | Authorized workspace member                        | List teams; `includeArchived=true` includes archived teams.               |
| POST   | `/workspaces/{workspaceId}/teams`                           | Authorized workspace member with create permission | Create a team and optionally assign its lead.                             |
| GET    | `/workspaces/{workspaceId}/teams/{teamId}`                  | Authorized workspace/team member                   | Read a team.                                                              |
| PATCH  | `/workspaces/{workspaceId}/teams/{teamId}`                  | Authorized team manager                            | Update team details or associate the team with an institution department. |
| POST   | `/workspaces/{workspaceId}/teams/{teamId}/archive`          | Authorized team manager                            | Archive a team.                                                           |
| DELETE | `/workspaces/{workspaceId}/teams/{teamId}`                  | Authorized team manager                            | Soft-delete a team.                                                       |
| GET    | `/workspaces/{workspaceId}/teams/{teamId}/members`          | Authorized team member                             | List team members.                                                        |
| POST   | `/workspaces/{workspaceId}/teams/{teamId}/members`          | Authorized team manager                            | Add a workspace member to the team.                                       |
| PATCH  | `/workspaces/{workspaceId}/teams/{teamId}/members/{userId}` | Authorized team manager                            | Change a team member's role.                                              |
| DELETE | `/workspaces/{workspaceId}/teams/{teamId}/members/{userId}` | Authorized team manager                            | Remove a member from the team.                                            |
| PATCH  | `/workspaces/{workspaceId}/teams/{teamId}/lead`             | Authorized team manager                            | Assign or clear the team lead.                                            |

Project organizational access is a Phase 7 integration only; project CRUD remains
outside the registered API.

| Method | Path                                                                   | Access                                                 | Purpose                                                           |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| PATCH  | `/workspaces/{workspaceId}/projects/{projectId}/organizational-access` | Project manager and authorized team/department manager | Associate a project with a same-workspace team and/or department. |

## Organization profiles and institution groups

Company and institution profiles are separate workspace-scoped records. Profile
reads require workspace membership; updates require the owner or organization
administrator. Profile schemas are distinct. Logos are private PNG, JPEG, or
WebP objects (maximum 2 MB) and are served through authenticated endpoints.
Logo upload accepts raw image bytes with the matching `Content-Type`; GET returns
raw image bytes (not the standard JSON envelope). The object-storage bucket must
block public access. Logo APIs return 503 until storage is configured.

| Method | Path                                                                      | Access                                          | Purpose                                         |
| ------ | ------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- |
| GET    | `/workspaces/{workspaceId}/company-profile`                               | Company workspace member                        | Read the company profile.                       |
| PATCH  | `/workspaces/{workspaceId}/company-profile`                               | Company owner/admin                             | Update company profile fields.                  |
| POST   | `/workspaces/{workspaceId}/company-profile/logo`                          | Company owner/admin                             | Upload or replace the private company logo.     |
| GET    | `/workspaces/{workspaceId}/company-profile/logo`                          | Company workspace member                        | Read the private company logo.                  |
| DELETE | `/workspaces/{workspaceId}/company-profile/logo`                          | Company owner/admin                             | Remove the company logo.                        |
| GET    | `/workspaces/{workspaceId}/institution-profile`                           | Institution workspace member                    | Read the institution profile.                   |
| PATCH  | `/workspaces/{workspaceId}/institution-profile`                           | Institution owner/admin                         | Update institution profile fields.              |
| POST   | `/workspaces/{workspaceId}/institution-profile/logo`                      | Institution owner/admin                         | Upload or replace the private institution logo. |
| GET    | `/workspaces/{workspaceId}/institution-profile/logo`                      | Institution workspace member                    | Read the private institution logo.              |
| DELETE | `/workspaces/{workspaceId}/institution-profile/logo`                      | Institution owner/admin                         | Remove the institution logo.                    |
| GET    | `/workspaces/{workspaceId}/institution-groups`                            | Institution member; groups scoped to membership | List visible institution groups.                |
| POST   | `/workspaces/{workspaceId}/institution-groups`                            | Institution owner/admin                         | Create a group and optionally assign its lead.  |
| PATCH  | `/workspaces/{workspaceId}/institution-groups/{groupId}`                  | Institution owner/admin                         | Update the group name, description, or lead.    |
| DELETE | `/workspaces/{workspaceId}/institution-groups/{groupId}`                  | Institution owner/admin                         | Delete a group and its membership records.      |
| GET    | `/workspaces/{workspaceId}/institution-groups/{groupId}/members`          | Group member or institution owner/admin         | List group members.                             |
| POST   | `/workspaces/{workspaceId}/institution-groups/{groupId}/members`          | Institution owner/admin                         | Add a workspace member to a group.              |
| PATCH  | `/workspaces/{workspaceId}/institution-groups/{groupId}/members/{userId}` | Institution owner/admin                         | Change the member's group role.                 |
| DELETE | `/workspaces/{workspaceId}/institution-groups/{groupId}/members/{userId}` | Institution owner/admin                         | Remove a member from a group.                   |

Institution groups are independent from departments. They do not grant access
to departments, teams, projects, or channels by themselves.

Notification preferences are scoped to the authenticated member and workspace.
All in-app notification types are enabled by default; a member can update
selected types. These preferences do not affect email or message unread state.

| Method | Path                                                 | Access           | Purpose                                                                |
| ------ | ---------------------------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| GET    | `/workspaces/{workspaceId}/notification-preferences` | Workspace member | Read the caller's in-app notification preferences, including defaults. |
| PATCH  | `/workspaces/{workspaceId}/notification-preferences` | Workspace member | Update selected in-app notification type preferences.                  |

## Invitations

| Method | Path                                                          | Access                                         | Purpose                                          |
| ------ | ------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| GET    | `/workspaces/{workspaceId}/invitations`                       | Workspace member with permission               | List invitations, optionally filtered by status. |
| POST   | `/workspaces/{workspaceId}/invitations`                       | Workspace member with permission, rate limited | Create an invitation.                            |
| POST   | `/workspaces/{workspaceId}/invitations/{invitationId}/resend` | Workspace member with permission, rate limited | Resend a pending invitation.                     |
| DELETE | `/workspaces/{workspaceId}/invitations/{invitationId}`        | Workspace member with permission               | Revoke an invitation.                            |
| GET    | `/invitations`                                                | Authenticated, active account                  | List invitations addressed to the caller.        |
| GET    | `/invitations/{token}`                                        | Public, rate limited                           | Preview an invitation.                           |
| POST   | `/invitations/{token}/accept`                                 | Authenticated, active account                  | Accept an invitation addressed to the caller.    |
| POST   | `/invitations/{token}/decline`                                | Authenticated, active account                  | Decline an invitation addressed to the caller.   |

## Workspace discovery and join requests

| Method | Path                                                          | Access                                      | Purpose                                                      |
| ------ | ------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/workspaces/discover`                                        | Authenticated, active account               | Discover joinable workspaces.                                |
| POST   | `/workspaces/join`                                            | Authenticated, active account, rate limited | Request to join using a join code.                           |
| GET    | `/workspaces/join-requests/mine`                              | Authenticated, active account               | List the caller's join requests.                             |
| POST   | `/workspaces/{workspaceId}/join-requests`                     | Authenticated, active account, rate limited | Submit a workspace join request.                             |
| GET    | `/workspaces/{workspaceId}/join-requests`                     | Workspace administrator                     | List workspace join requests, optionally filtered by status. |
| POST   | `/workspaces/{workspaceId}/join-requests/{requestId}/approve` | Workspace administrator                     | Approve a join request.                                      |
| POST   | `/workspaces/{workspaceId}/join-requests/{requestId}/reject`  | Workspace administrator                     | Reject a join request.                                       |
| DELETE | `/workspaces/join-requests/{requestId}`                       | Request owner                               | Withdraw a pending join request.                             |
| POST   | `/workspaces/{workspaceId}/join-code`                         | Workspace administrator                     | Rotate/enable a join code.                                   |
| DELETE | `/workspaces/{workspaceId}/join-code`                         | Workspace administrator                     | Disable a join code.                                         |

## Email provider webhooks

These routes are mounted at `/api/v1/webhooks` and authenticate provider
events using the configured signature or webhook token, not a user session.

| Method | Path                      | Access                            | Purpose                                                        |
| ------ | ------------------------- | --------------------------------- | -------------------------------------------------------------- |
| POST   | `/webhooks/email`         | Provider verification required    | Receive an email delivery event.                               |
| POST   | `/webhooks/email/{token}` | Configured webhook token required | Receive an email event from providers without signed payloads. |

## Billing

Billing routes are mounted below `/api/v1/billing`. Read routes require an
authenticated active account and workspace membership. Mutations require the
workspace owner. USD checkout is available only when the merchant has enabled
USD in Paystack and the server is configured. Prices, seat counts, transaction
references, and payment outcomes are server-owned.

| Method | Path                                         | Access           | Purpose                                                              |
| ------ | -------------------------------------------- | ---------------- | -------------------------------------------------------------------- |
| GET    | `/billing/plans`                             | Public           | Read the approved USD plan and seat catalog.                         |
| GET    | `/billing/workspaces/{workspaceId}`          | Workspace member | Read subscription, active seats, pending changes, and renewal date.  |
| GET    | `/billing/workspaces/{workspaceId}/payments` | Workspace member | Read recent billing history.                                         |
| POST   | `/billing/workspaces/{workspaceId}/checkout` | Workspace owner  | Initialize hosted Paystack checkout for plan and cadence.            |
| POST   | `/billing/workspaces/{workspaceId}/verify`   | Workspace owner  | Verify a transaction reference server-side and fulfill its checkout. |
| POST   | `/billing/workspaces/{workspaceId}/change`   | Workspace owner  | Schedule a plan downgrade or seat reduction at renewal.              |
| POST   | `/billing/workspaces/{workspaceId}/cancel`   | Workspace owner  | Cancel renewal at the end of the paid period.                        |

`GET /billing/workspaces/{workspaceId}/payments` returns persisted payment
history. There is no invoice model or workspace-to-invoice ownership mapping in
the current database, and the backend does not create Paystack Payment Request
invoices. An invoice-list endpoint is therefore not available yet: mapping all
Paystack customer invoices to a workspace would risk exposing financial records
from another workspace. Product/billing must define invoice creation, workspace
mapping, payer access after ownership transfer, and provider synchronization
before the frontend can safely integrate invoice listing. Outstanding invoice
records already represented by the existing billing system remain payable; no
automatic refund is issued.

## Privacy requests and redaction

Privacy-request routes require a verified active account for submissions and
own-request reads. Review, decision, completion, and redaction routes require an
active platform administrator (`isPlatformAdmin`). Requests support `ACCESS`,
`CORRECTION`, `ERASURE`, and `REDACTION`; redaction currently targets a task
comment because this backend has no Message, Conversation, or Channel model.
Reviewers approve or reject requests. Approved non-redaction requests are
completed by recording the outcome after the reviewer performs the approved
work. An approved comment redaction replaces only exact selected text, keeps
the rest of the comment, and atomically completes the request with restricted
audit metadata. Request descriptions and reviewer notes should not contain
unnecessary sensitive details.

| Method | Path | Access | Purpose |
| ------ | ---- | ------ | ------- |
| POST | `/privacy-requests` | Verified active account | Submit an access, correction, erasure, or comment-redaction request. |
| GET | `/privacy-requests/mine` | Active account | List only the caller's requests; supports `limit`, `cursor`, and `status`. |
| GET | `/privacy-requests/mine/{requestId}` | Request owner | Read the caller's status, decision, and outcome. |
| GET | `/privacy-requests/review` | Platform privacy reviewer | List requests for review; supports `limit`, `cursor`, and `status`. |
| POST | `/privacy-requests/{requestId}/review` | Platform privacy reviewer | Claim a submitted request for review. |
| POST | `/privacy-requests/{requestId}/decision` | Platform privacy reviewer | Approve or reject a submitted/in-review request. |
| POST | `/privacy-requests/{requestId}/complete` | Platform privacy reviewer | Record completion outcome for an approved non-redaction request. |
| POST | `/privacy-requests/{requestId}/redactions` | Platform privacy reviewer | Apply an approved exact-text replacement to its task comment target. |

The backend does not yet expose messages, channel discussions, general project
updates, or privacy-specific document export. Legal review must still define
response deadlines, appeals, exceptions, reviewer separation of duties, and
jurisdiction-specific retention. These constraints keep Phase 7 in progress.

The signed payment webhook is `POST /api/v1/webhooks/paystack`. It verifies
Paystack's timestamped `Paystack-Signature` using the raw request body and the
server-only `PAYSTACK_WEBHOOK_SECRET` (`whsec_...`). During secret rotation,
`PAYSTACK_WEBHOOK_PREVIOUS_SECRET` may hold the prior key. The old
`x-paystack-signature` header remains accepted only as a migration fallback
when the timestamped header is absent. Events are deduplicated and accepted
events return `{ "success": true, "data": { "received": true } }`.

## Other APIs not exposed

The current application router does not expose general project CRUD, tasks, messaging,
general notifications, files, documents, calendar, meetings, forms, search,
integrations, automation, or AI endpoints. Department routes cover listing,
creation, renaming, and member assignment or removal; department deletion and
department-settings routes are not registered.
Do not document planned behavior as live API functionality.

## Channel access (Phase 7)

Channels expose access metadata only; message storage and delivery are not part
of this API. All routes require an authenticated active account and an active
workspace membership. `WORKSPACE` channels are visible to active members except
collaborators; `TEAM`, `DEPARTMENT`, and `PROJECT` channels inherit current
parent membership dynamically. `PRIVATE` channels require explicit
`ChannelMembership`; workspace managers do not implicitly read them.
Archived channels are excluded from non-manager lists and are hidden from
non-managers on every channel operation. Workspace owners and project managers
may read and archive or delete archived channels; they cannot update metadata
or change channel membership after archival. Private channels still require
explicit membership for reads, including for workspace managers.

| Method | Path | Contract |
| --- | --- | --- |
| POST | `/workspaces/{workspaceId}/channels` | Create `{type,name,description?,teamId?,departmentId?,projectId?}`; returns channel summary. Private creator receives `ADMIN`. |
| GET | `/workspaces/{workspaceId}/channels?cursor=&limit=` | Stable cursor page `{items,nextCursor}` filtered by channel access. `memberCount` is an integer for private channels and `null` otherwise. |
| GET | `/workspaces/{workspaceId}/channels/{channelId}` | Read an accessible channel summary; inaccessible channels return 404. |
| PATCH | `/workspaces/{workspaceId}/channels/{channelId}` | Update `{name?,description?}`. |
| POST | `/workspaces/{workspaceId}/channels/{channelId}/archive` | Archive channel. |
| DELETE | `/workspaces/{workspaceId}/channels/{channelId}` | Soft-delete channel; workspace owner/project manager only. Deleted names are reusable. |
| POST | `/workspaces/{workspaceId}/channels/{channelId}/members` | Private channel only; request `{userId}`; server assigns `MEMBER`. |
| DELETE | `/workspaces/{workspaceId}/channels/{channelId}/members/{userId}` | Remove private-channel membership. |

Workspace owners and project managers manage channel lifecycle. Team leads may
create/update/archive channels attached to their own active team; department
heads have the corresponding rights for their own department. A private-channel
`ADMIN` may update metadata, archive, and manage its own membership. No one
other than workspace owners/project managers may delete a channel. Parent team,
department, or project archival/deletion revokes ordinary channel access;
workspace managers retain archive/delete actions for those parent-inaccessible
channels.

## Updating this API reference

After each backend phase that adds, changes, or removes an externally visible
route or response contract, update this route index and `openapi.yaml` in the
same phase change. Verify both against the registered Express routers and
schemas. Do not document planned behavior as live API functionality. If a
phase changes no HTTP contract, record that no API update was required in the
phase completion notes.
