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
| GET    | `/health/workers` | Public | Background worker liveness and durable queue depth; returns 503 when a worker is failing or stale. |

### Background processing (Phase 24)

Each background worker claims rows from a PostgreSQL-backed queue with
`FOR UPDATE SKIP LOCKED`, applies bounded exponential backoff, and records
failures for inspection. PostgreSQL is the durable queue; Redis is never the
only record of a job or message. Workers run inside the API process and stop
during graceful shutdown.

`GET /health/workers` returns `status` (`ok` or `degraded`), per-worker
liveness (`state`, `stale`, `consecutiveFailures`, `lastSuccessAt`,
`lastFailureAt`, `lastErrorCode`), and queue depth (`pending`, `failed`) for
email, outbox webhooks, automation runs and integration sync jobs. Worker
liveness is process-local, so a load balancer should probe each instance.
The response never contains job payloads, recipient addresses or raw error
messages.

Redis cache entries use the `CACHE_NAMESPACE` prefix and always have a TTL.
Cache reads and writes degrade to cache misses when Redis is unavailable; the
cache never makes a request fail. Invalidation of an entity prefix uses
`SCAN`, not `KEYS`, so it cannot block the Redis server.

## Authentication and account lifecycle

| Method | Path                         | Access                              | Purpose                                                                                                                                |
| ------ | ---------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/register`             | Public, rate limited                | Register an account.                                                                                                                   |
| POST   | `/auth/email/verify`         | Public, rate limited                | Verify an email address with `{ email, code }`.                                                                                       |
| POST   | `/auth/email/resend`         | Public, rate limited                | Request a verification code; response does not reveal account existence.                                                              |
| POST   | `/auth/login`                | Public, rate limited                | Start an authenticated session.                                                                                                        |
| GET    | `/auth/google`               | Public, rate limited                | Redirect the browser to Google OpenID Connect.                               |
| GET    | `/auth/google/callback`      | Public, rate limited                | Validate Google's callback and redirect to the frontend with a one-time code. |
| POST   | `/auth/google/exchange`      | Public, rate limited                | Exchange the one-time code for the normal Nexus session response.             |
| POST   | `/auth/2fa/challenge`         | Public, rate limited                | Exchange a short-lived MFA challenge and TOTP/recovery code for a normal session.                                                       |
| POST   | `/auth/2fa/setup`             | Authenticated, active account       | Start or restart unverified TOTP enrollment; returns an `otpauth://` URI valid for ten minutes.                                        |
| POST   | `/auth/2fa/confirm`           | Authenticated, active account       | Confirm the first TOTP code and return ten single-use recovery codes once.                                                              |
| POST   | `/auth/2fa/disable`           | Authenticated, active account       | Disable 2FA after current password and TOTP/recovery-code verification.                                                                 |
| POST   | `/auth/2fa/recovery-codes`    | Authenticated, active account       | Replace all recovery codes after current password or TOTP/recovery-code verification.                                                   |
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

### Continue with Google contract

The backend uses `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the existing
case-sensitive `redirect_URL` value as the Google callback URL.
`GOOGLE_CALLBACK_URL` is only a fallback when `redirect_URL` is absent; its
current dotenv value points to the frontend and is not the backend callback.
The initiation endpoint is a browser navigation (`GET /api/v1/auth/google`),
not a fetch request. Start it at the Render backend origin so its short-lived,
HttpOnly `nexus_google_oauth_state` cookie is scoped to the same host that
receives Google's callback. The backend requests only `openid`, `email`, and
`profile`; it stores a hashed, single-use state and nonce and signs the state
into that cookie before redirecting to Google. The callback requires both the
database state and its matching browser cookie; state expires after ten minutes.

With the current deployment URLs, register this exact Google Authorized
redirect URI: `https://nexusbackend-1-0ffo.onrender.com/api/auth/google/callback`.
Register `https://nexus-frontend-six-lilac.vercel.app` as the Authorized
JavaScript origin. For local frontend development, also add
`http://localhost:3000` as an authorized origin and use a matching local
`redirect_URL` in the Google OAuth client configuration.

Google returns to the configured backend callback path with `code` and `state`
(or an OAuth `error`). The backend exchanges and verifies the ID token, then
redirects to the fixed frontend path `/auth/google/callback` on the first origin
in `FRONTEND_URL`. Success appends a short-lived, single-use `code` query
parameter; cancellation and failures append a stable, generic `error` code to
that same allowlisted frontend URL. The callback never accepts a redirect URL
from the request. The frontend must immediately POST `{ "code": "..." }` to
`POST /api/v1/auth/google/exchange` with `credentials: "include"`. Prefer the
Vercel same-origin `/api/backend/...` proxy for this exchange; the browser then
stores the returned host-only session cookies for the frontend origin. The response
uses the normal auth success envelope and contains `user`, `accessToken`,
`tokenType`, `expiresIn`, `csrfToken`, and `session`; it sets the existing
httpOnly `nexus_rt` and readable `nexus_csrf` cookies. The frontend should
remove the one-time code from browser history after exchange. If 2FA is enabled,
exchange returns the existing `twoFactorRequired` challenge and the regular
`POST /api/v1/auth/2fa/challenge` flow completes login.

Errors on the frontend callback use stable codes including
`OAUTH_CANCELLED`, `OAUTH_STATE_INVALID`, `GOOGLE_CALLBACK_INVALID`,
`GOOGLE_TOKEN_INVALID`, and `GOOGLE_SIGN_IN_FAILED`. They do not reveal whether
an email already belongs to a Nexus account. API exchange validation errors use
the standard `{ "success": false, "error": { "code": string,
"message": string } }` shape. OAuth-specific codes include
`GOOGLE_AUTH_UNAVAILABLE` and `OAUTH_CODE_INVALID`. An existing Nexus email is
never linked automatically; the user must first authenticate normally and use
a future authenticated linking flow. This avoids taking over an account based
on an email match. Verified
Google email activates the account but creates only the private personal
workspace. Company/institution workspace choice and setup remain the normal
onboarding steps and are not inferred from Google profile data.

The Vercel page and Render API are different sites. Requests sent through the
Vercel `/api/backend/*` proxy are same-origin from the browser; direct browser
requests to Render are cross-site. The OAuth start must still navigate directly
to Render so the state cookie is returned to the Render callback. Use the Vercel
proxy for the exchange and later cookie-authenticated calls, and verify that the
proxy forwards both `Set-Cookie` headers without adding a `Domain` attribute.
With this proxy path, keep session cookies `Secure` in production,
`SameSite=Lax`, and host-only (`AUTH_COOKIE_DOMAIN` empty). If the frontend calls
Render directly instead, configure the exact frontend origin in
`CORS_ORIGINS`/`FRONTEND_URL`, set `CORS_CREDENTIALS=true`,
`AUTH_COOKIE_SAME_SITE=none`, and `AUTH_COOKIE_SECURE=true`, and send
`credentials: "include"`. Never set a cookie domain shared by Vercel and
Render; they do not share a parent domain. Cookie-authenticated refresh/logout
requests must send the readable `nexus_csrf` value in `X-CSRF-Token`. Render
must also set `TRUST_PROXY=true` so Express derives the rate-limit client IP
from the trusted hosting proxy; verify the deployed setting and forwarded-IP
behavior before relying on per-IP OAuth limits.

### Account deletion request and frontend behavior

`POST /api/v1/auth/delete` accepts `{ "currentPassword": string, "confirmation": string }`, where `confirmation` must exactly match the signed-in account email. A successful response is HTTP 202 with `{ "success": true, "data": { "status": "PENDING_DELETION", "scheduledDeletionAt": "ISO-8601 timestamp" } }`. The response clears session cookies; the access token is also revoked server-side. Show the deadline and explain that recovery requires the same email and password before it. Recovery uses `POST /api/v1/auth/reactivate` with `{ "email": string, "password": string }`; success returns the user but does not create a session.

The frontend should explain that a workspace without an accepted ownership transfer will be suspended at the deletion request and remains suspended until a successor accepts. Owners may start a transfer during the 30-day recovery period. Initiate with `PATCH /api/v1/workspaces/{workspaceId}/owner/{userId}`; the actual response is `{ "transferId": "uuid", "status": "PENDING" }`. The intended recipient can list transfers with `GET /api/v1/workspaces/owner-transfers/incoming?limit=50&offset=0`; each item includes `workspace` (id, name, type, status) and `initiatedBy` (id, name) so the frontend can display who is offering the transfer. The recipient then accepts with `POST /api/v1/workspaces/{workspaceId}/owner-transfers/{transferId}/accept` or rejects with `/reject` (no body). Acceptance returns `workspaceId` and `billingAcceptanceRequired`. When that value is true, the new owner must separately accept billing with `POST /api/v1/workspaces/{workspaceId}/owner-transfers/{transferId}/billing-acceptance` (no body). Billing acceptance cannot be inferred from workspace ownership. The inbox contains only unexpired pending transfers where the caller remains an active member and the initiator still owns the workspace. These operations require an authenticated active account; backend services validate owner, recipient, workspace, transfer status and billing state.

The backend does not provide frontend screens, notifications or workflow orchestration for these steps. The separate frontend must add: a deletion confirmation and recovery-deadline view; a workspace ownership/suspension summary; recipient acceptance actions; distinct billing-responsibility consent; and recovery/sign-in guidance. The frontend must not claim deletion is final at request time.

## User profile

| Method | Path        | Access                        | Purpose                      |
| ------ | ----------- | ----------------------------- | ---------------------------- |
| GET    | `/users/me` | Authenticated, active account | Read the caller's profile.   |
| PATCH  | `/users/me` | Authenticated, active account | Update the caller's profile. `avatarUrl` is rejected; use the server-managed upload route. |
| GET    | `/users/me/avatar` | Authenticated, active account | Read the caller's private profile image. |
| POST   | `/users/me/avatar` | Authenticated, active account, per-user rate limited | Upload a JPEG, PNG, or WebP avatar as multipart field `avatar`. |
| DELETE | `/users/me/avatar` | Authenticated, active account, per-user rate limited | Remove the caller's profile image. |

Avatar uploads are limited by `AVATAR_MAX_FILE_SIZE_BYTES` (5 MiB by default),
`AVATAR_MAX_DIMENSION` (4096 pixels per side), and `AVATAR_MAX_PIXELS` (16
million pixels). File type is detected from its signature and the image is
decoded, orientation-corrected, re-encoded, and stripped of metadata. Client
filenames and declared MIME types are ignored. The private object key is
server-generated; reads are authenticated and scoped to the signed-in user.
Replacing/removing an avatar updates profile metadata first; storage deletion
failures are logged and are non-fatal. Legacy stored `avatarUrl` values remain
readable for compatibility, but clients can no longer set them; uploading a new
image replaces the legacy URL.

TOTP uses 6-digit SHA-1 codes with a 30-second period and ±1 period drift. Setup
URIs and recovery codes are returned only during setup/rotation. Recovery codes
are 32-character random hexadecimal values, stored only as hashes, and usable
once. MFA challenges expire after five minutes, are single-use, and are not
access tokens. Five failed MFA proofs lock the account/IP buckets for 15
minutes. Password reset revokes all sessions while preserving enabled 2FA, so
resetting a password never bypasses the second factor. Encryption uses
`TOTP_ENCRYPTION_KEY`; rotate by deploying a controlled re-encryption job that
decrypts each stored `v1` secret with the old key and re-encrypts it with the
new key before replacing the environment value. Never log either key or a
decrypted secret. Setup, confirmation, disable, and recovery-code rotation
require an active authenticated account; disabling also requires the current
password and a valid TOTP/recovery code.
Enabling/disabling 2FA, regenerating recovery codes, and failed verification
attempts write security audit events and send a security notification email.

MFA failures use `MFA_CHALLENGE_INVALID` (expired, malformed or consumed
challenge), `MFA_CODE_INVALID` (incorrect/replayed/used proof), `MFA_LOCKED`
(five failed proofs within 15 minutes), `MFA_RATE_LIMITED` (challenge route IP
limit), `TWO_FACTOR_SETUP_REQUIRED`, `TWO_FACTOR_ALREADY_ENABLED`, and
`TWO_FACTOR_NOT_ENABLED`. Avatar errors include `AVATAR_REQUIRED`,
`AVATAR_TOO_LARGE`, `AVATAR_DIMENSIONS_TOO_LARGE`, `AVATAR_TYPE_UNSUPPORTED`,
`AVATAR_IMAGE_INVALID`, `AVATAR_RATE_LIMITED`, and `OBJECT_STORAGE_UNAVAILABLE`.

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
| GET    | `/workspaces/{workspaceId}/teams/{teamId}/invitations?status=PENDING` | Team manager | List invitations for that team. |
| POST   | `/workspaces/{workspaceId}/teams/{teamId}/invitations`       | Team manager, rate limited                         | Invite an existing active workspace member by `{ targetUserId }`.         |
| DELETE | `/workspaces/{workspaceId}/teams/{teamId}/invitations/{invitationId}` | Team manager | Revoke a team invitation. |
| PATCH  | `/workspaces/{workspaceId}/teams/{teamId}/members/{userId}` | Authorized team manager                            | Change a team member's role.                                              |
| DELETE | `/workspaces/{workspaceId}/teams/{teamId}/members/{userId}` | Authorized team manager                            | Remove a member from the team.                                            |
| PATCH  | `/workspaces/{workspaceId}/teams/{teamId}/lead`             | Authorized team manager                            | Assign or clear the team lead.                                            |

Team invitation acceptance uses the shared `/invitations/{token}` preview,
verification and accept/decline routes. Only an already active workspace
member can receive a team invitation. Accepting adds `TeamMembership` only;
it does not create, change or reactivate workspace membership. Invitations
expire according to `WORKSPACE_INVITATION_TTL_SECONDS`, are single use, and
are audited. The raw token is sent through the existing team-invitation email
template and stored only as a hash. Workspace invitation management routes list,
resend and revoke only `WORKSPACE` invitation records.

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
All notification types are enabled by default for both the in-app and email
channels; a member can update selected types per channel. These preferences do
not affect message unread state. Transactional emails (join-request decisions,
billing receipts, failed-payment warnings, subscription changes) are always
sent and are not gated by preference channels.

| Method | Path                                                 | Access           | Purpose                                                                |
| ------ | ---------------------------------------------------- | ---------------- | ---------------------------------------------------------------------- |
| GET    | `/workspaces/{workspaceId}/notification-preferences` | Workspace member | Read the caller's notification preferences, including defaults.        |
| PATCH  | `/workspaces/{workspaceId}/notification-preferences` | Workspace member | Update selected notification type preferences for the in-app and email |

## Invitations

| Method | Path                                                          | Access                                         | Purpose                                          |
| ------ | ------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| GET    | `/workspaces/{workspaceId}/invitations`                       | Workspace member with permission               | List invitations, optionally filtered by status. |
| POST   | `/workspaces/{workspaceId}/invitations`                       | Workspace member with permission, rate limited | Create an invitation.                            |
| POST   | `/workspaces/{workspaceId}/invitations/{invitationId}/resend` | Workspace member with permission, rate limited | Resend a pending invitation.                     |
| DELETE | `/workspaces/{workspaceId}/invitations/{invitationId}`        | Workspace member with permission               | Revoke an invitation.                            |
| GET    | `/invitations`                                                | Authenticated, active account                  | List invitations addressed to the caller.        |
| GET    | `/invitations/{token}`                                        | Public, rate limited                           | Preview an invitation without accepting it.      |
| GET    | `/invitations/{token}/verify`                                 | Authenticated, active account, rate limited    | Verify the invitation for the signed-in account. |
| POST   | `/invitations/{token}/accept`                                 | Authenticated, active account                  | Accept an invitation addressed to the caller.    |
| POST   | `/invitations/{token}/decline`                                | Authenticated, active account                  | Decline an invitation addressed to the caller.   |

### Workspace invitation acceptance contract

The invitation link is a frontend route built from `FRONTEND_URL` and
`WORKSPACE_INVITATION_LINK_PATH` with the raw token appended as `?token=...`.
The raw token is never stored; the database keeps only its SHA-256 digest.

Opening the link must call `GET /invitations/{token}` first. That endpoint is
public, validates the token, returns the invited workspace, inviter, role,
expiry and masked recipient address, and never creates membership or changes
the invitation status. It returns `404 INVITATION_NOT_FOUND` for an unknown
token and `410` for an expired, revoked, accepted or unavailable invitation.

When a user is signed in, the frontend must call
`GET /invitations/{token}/verify` before showing the accept or decline action.
The response adds a `viewer` object with `emailMatches`, `alreadyMember`,
`membershipRole`, `canAccept`, `canDecline` and a `reason`. A terminal
invitation is reported with HTTP 200 and its real status, so the frontend can
render "already accepted", "declined", "revoked", "expired", "wrong account"
or "already a member" without treating those states as server errors.

Accepting requires the signed-in account to be the intended recipient: the
invitation is either bound to that account or addressed to its verified email.
The service rechecks workspace availability, the token digest, the pending
state and the deadline inside one transaction, creates the membership and marks
the invitation `ACCEPTED` atomically, and records the audit event and inviter
notification. A second or concurrent acceptance receives `409
INVITATION_ALREADY_ACCEPTED` and never creates a second membership. Declining
requires the same recipient check, moves a pending invitation to `DECLINED`
without creating or deleting membership, and clears the pending-invitation
slot so the address can be invited again.

Invitation statuses are `PENDING`, `ACCEPTED`, `DECLINED`, `REVOKED` and
`EXPIRED`. Only `PENDING` is actionable. Expiry is enforced on every read and
write, and the stored status is updated to `EXPIRED` when the deadline passes.

The complete frontend contract, including request/response examples and
redirect behavior, is maintained in
[`frontend-workspace-invitation-contract.md`](./frontend-workspace-invitation-contract.md).

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

## Global search (Phase 18)

Search routes are mounted at `/api/v1/search` and are user-scoped. Every query
is filtered by the caller's current workspace membership and resource
visibility before results are returned. `data` is an array; pagination
metadata is returned in `meta`.

| Method | Path | Access | Purpose |
| ------ | ---- | ------ | ------- |
| GET | `/search` | Authenticated, active account | Search authorised content. Supports `q`, `category`, `workspaceId`, `page`, `limit`, and `sort` (`relevance` or `recent`). |
| GET | `/search/suggestions` | Authenticated, active account | Return up to eight lightweight ranked suggestions for `q`. |
| GET | `/search/recent` | Authenticated, active account | List the caller's recent search history. History is private and deduplicated. |
| DELETE | `/search/recent` | Authenticated, active account | Clear the caller's recent search history, optionally scoped to a workspace. |

Categories are `all`, `people`, `workspaces`, `teams`, `departments`,
`projects`, `tasks`, `messages`, `conversations`, `files`, `documents`,
`meetings`, `channels`, and `announcements`. The `announcements` category
returns no results until an announcement model exists. Search runs at query
time, so permission and content changes take effect immediately. Uploaded text,
DOCX, and PDF content is extracted into `FileAttachment.extractedText` and is
searchable; legacy binary `.doc` and scanned image-only PDFs are not parsed.

## Integrations (Phase 19)

Integration routes are mounted at `/api/v1/integrations`. Connection records
never return access or refresh tokens. The common connect endpoint currently
supports providers that do not have a dedicated OAuth flow; Slack, Google
Drive, Dropbox, GitHub, Google Calendar, and Gmail tokens are rejected there
and must use their OAuth routes. Gmail, GitHub, and Google Calendar connections
are personal (`workspaceId: null`); a supplied `workspaceId` query parameter is
accepted for frontend compatibility but does not make them workspace-shared.

| Method | Path | Access | Purpose |
| ------ | ---- | ------ | ------- |
| GET | `/integrations` | Authenticated, active account | List the caller's personal connections and, when `workspaceId` is supplied, visible workspace connections. Disconnected rows are omitted. |
| POST | `/integrations` | Authenticated, active account | Save a connection for providers without a dedicated OAuth flow. Workspace-scoped connections require workspace access. |
| PATCH | `/integrations/{integrationId}` | Connection owner; workspace manager for workspace connections | Enable or disable an integration without deleting it. |
| DELETE | `/integrations/{integrationId}` | Connection owner; workspace manager for Slack | Disconnect an integration. The provider token is revoked when the provider supports revocation; provider-side data is never deleted. |
| POST | `/integrations/{integrationId}/refresh` | Connection owner; workspace manager for workspace connections | Refresh an expiring access token through the provider adapter and record `lastRefreshedAt`. |
| POST | `/integrations/{integrationId}/sync` | Connection owner; workspace manager for workspace connections | Queue a durable sync job for the integration. |
| GET | `/integrations/{integrationId}/sync-jobs` | Connection owner; workspace manager for workspace connections | List sync job history. |
| POST | `/integrations/{integrationId}/sync-jobs/{jobId}/retry` | Connection owner; workspace manager for workspace connections | Reset a failed sync job to pending. |
| GET | `/integrations/gmail/authorize` | Authenticated, active account | Return a Google consent URL for the caller's personal Gmail account. |
| GET | `/integrations/gmail/callback` | Public OAuth callback | Consume the single-use state, exchange the Google code, persist encrypted credentials, then redirect to the frontend with `integration=gmail` and a status. |
| GET | `/integrations/google-drive/authorize` | Workspace manager | Return a Google Drive consent URL for the selected workspace. |
| GET | `/integrations/google-drive/callback` | Public OAuth callback | Consume state, exchange the Google code, persist encrypted credentials, and redirect with status. |
| GET | `/integrations/dropbox/authorize` | Authenticated workspace member | Return a Dropbox consent URL for the selected workspace. |
| GET | `/integrations/dropbox/callback` | Public OAuth callback | Consume state, exchange the Dropbox code, persist encrypted credentials, and redirect with status. |
| GET | `/integrations/github/authorize` | Authenticated, active account | Return a GitHub App consent URL for the caller. |
| GET | `/integrations/github/callback` | Public OAuth callback | Consume state, exchange the GitHub code, persist encrypted credentials, and redirect with status. |
| GET | `/integrations/google-calendar/authorize` | Authenticated, active account | Return a Google Calendar consent URL for the caller. |
| GET | `/integrations/google-calendar/callback` | Public OAuth callback | Consume state, exchange the Google code, persist encrypted credentials, and redirect with status. |
| GET | `/integrations/slack/authorize` | Workspace manager | Return a Slack OAuth URL for the selected workspace. |
| GET | `/integrations/slack/callback` | Public OAuth callback | Consume state, exchange the Slack code, persist encrypted credentials, and redirect with status. |
| GET | `/integrations/{integrationId}/slack/channels` | Workspace manager | List public Slack channels the connected bot can post to. |
| GET | `/workspaces/{workspaceId}/integrations/google-calendar/calendars` | Workspace manager | List Google calendars the connected Google Calendar account can read. Expired tokens are refreshed; unusable tokens return a reconnect-required error. |
| GET | `/workspaces/{workspaceId}/integrations/slack/channels` | Workspace manager | List public Slack channels the connected Slack bot can post to, with private flag and membership. Expired tokens are refreshed; unusable tokens return a reconnect-required error. |

A saved `googleCalendarId` or `slackChannelId` must be one the matching picker endpoint currently returns for that connection; the config update path validates this before persisting.

OAuth state is signed and single use, with a ten-minute lifetime. Integration
tokens are encrypted at rest using `INTEGRATION_ENCRYPTION_KEY`. Gmail requests
`gmail.readonly`, `gmail.send`, `gmail.compose`, and `gmail.modify`, plus
`openid` and `email`; Google must have these Gmail scopes enabled for the OAuth
client. The callback redirects to the frontend integrations page and does not
expose credentials in the redirect.

Phase 19 also adds `enabled`, `lastError`, `lastRefreshedAt`, `lastSyncedAt`,
and `revokedAt` to `Integration`, plus the durable `IntegrationSyncJob` queue.
The sync worker refreshes an expiring token when a refresh token exists and
records `lastSyncedAt`; provider-specific data import remains a later
integration stage. Live OAuth and revocation still require provider
credentials and callback configuration, so external provider verification is
environment-dependent.

## SCIM provisioning

SCIM 2.0 Users and Groups provisioning is mounted at `/scim/v2` and is
authenticated exclusively with per-workspace bearer tokens (not Nexus sessions).
A SCIM token is bound to exactly one workspace, is hashed at rest, is shown
once at creation, is revocable, and is rate limited per token. Every SCIM
operation is implicitly scoped to that workspace.

Endpoints:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/scim/v2/ServiceProviderConfig` | SCIM service provider metadata |
| GET | `/scim/v2/ResourceTypes` | SCIM resource types (User, Group) |
| GET | `/scim/v2/Schemas` | SCIM resource schemas |
| GET | `/scim/v2/Users` | List SCIM users (paginated) |
| POST | `/scim/v2/Users` | Create (provision) a SCIM user |
| GET | `/scim/v2/Users/{id}` | Get a SCIM user |
| PATCH | `/scim/v2/Users/{id}` | Update a SCIM user |
| DELETE | `/scim/v2/Users/{id}` | Deactivate a SCIM user |
| GET | `/scim/v2/Groups` | List SCIM groups (paginated) |
| POST | `/scim/v2/Groups` | Create a SCIM group |
| GET | `/scim/v2/Groups/{id}` | Get a SCIM group |
| PATCH | `/scim/v2/Groups/{id}` | Update a SCIM group |
| DELETE | `/scim/v2/Groups/{id}` | Delete a SCIM group |

SCIM users map to Nexus users within the workspace (`User` + `WorkspaceMembership`);
SCIM groups map to Nexus teams. Creating a SCIM user provisions a Nexus account and
workspace membership. Deactivating a SCIM user sets the account to `DEACTIVATED`,
suspends the workspace membership, and revokes all of the user's sessions, SCIM
tokens, and workspace integration tokens. Data is never deleted on deactivate unless
`hardDelete` is explicitly requested. Token creation, revocation, user
provisioning/deactivation, and group changes are recorded as security audit events.
### Slack notifications

Slack is a workspace-level integration. A message is only queued when the
workspace has an ACTIVE, enabled Slack connection, a `slackChannelId` in
`Integration.config`, and notifications are not disabled. Queued messages are
stored as durable `OUTBOUND_EVENT` jobs, deduplicated by a stable event key, and
retried with bounded exponential backoff; Slack `Retry-After` is honoured.

Events: task assigned, task due soon, task overdue, form submitted, and the
`SEND_SLACK_MESSAGE` automation action. `POST_MESSAGE` remains an internal chat
action. Messages contain only the item title, status and deep link (forms: form
name and link). Descriptions, comments, attachments, form answers, actor and
assignee names, and automation error text are never sent. The form deep link is
`{FRONTEND_URL}/app/forms/{encodedFormId}`; it resolves only when the
recipient's active workspace matches the form's workspace.

When Slack rejects the stored token, the integration is marked
`needsReconnect`, pending outbound jobs fail without retry, and every ACTIVE
workspace member receives one in-app `INTEGRATION_RECONNECT_REQUIRED`
notification. Reconnecting clears the state.

## Outbound webhooks

Workspace webhook subscriptions are mounted at
`/api/v1/workspaces/{workspaceId}/webhooks`. Only workspace OWNER /
PROJECT_MANAGER roles may create, update, delete, or retry a delivery; any
active workspace member may list subscriptions and delivery history. The
signing secret is returned only when a subscription is created or its secret is
rotated.

| Method | Path | Access | Purpose |
| ------ | ---- | ------ | ------- |
| GET | `/workspaces/{workspaceId}/webhooks` | Active workspace member | List webhook subscriptions. Secrets are never returned. |
| POST | `/workspaces/{workspaceId}/webhooks` | Workspace manager | Create a subscription. Returns the generated or supplied signing secret once. |
| PATCH | `/workspaces/{workspaceId}/webhooks/{webhookId}` | Workspace manager | Update the URL, event list, description, enabled flag, or rotate the secret. |
| DELETE | `/workspaces/{workspaceId}/webhooks/{webhookId}` | Workspace manager | Delete a subscription and its delivery history. |
| GET | `/workspaces/{workspaceId}/webhooks/{webhookId}/deliveries` | Active workspace member | List delivery attempts and outcomes. |
| POST | `/workspaces/{workspaceId}/webhooks/{webhookId}/deliveries/{deliveryId}/retry` | Workspace manager | Reset a failed delivery to pending. |

Deliveries are written to PostgreSQL before the network call, signed with
HMAC-SHA256 in `x-nexus-signature`, sent only to HTTPS endpoints that pass the
SSRF guard, and retried with bounded exponential backoff. Supported event names
are `task.created`, `task.completed`, `member.joined`, and `*` for every
workspace event.

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

## Additional registered APIs

The following routers are mounted by the current application router. They
require authentication and an active account unless noted otherwise. These
are route-family summaries; consult route schemas and handlers for exact
request and response fields. Paths below are relative to `/api/v1`.

| Area | Registered path | Supported operations |
| --- | --- | --- |
| Tasks | `/workspaces/{workspaceId}/projects/{projectId}/tasks` | List/create/get/update/delete tasks; manage assignees, dependencies, comments, and activity. |
| Channels and messages | `/workspaces/{workspaceId}/channels` and `/workspaces/{workspaceId}/channels/{channelId}/messages` | Manage channels and membership; create/list/update/delete messages, replies, reactions, pins, and read state. |
| Notifications | `/notifications` | List notifications and unread counts; mark read; read activity and manage workspace notification preferences. |
| Files | `/workspaces/{workspaceId}/files` | List/upload files, obtain authorized download access, and delete files. File versions and version feedback are documented in the BE-3 section below. Storage configuration is required for uploads. |
| Documents | `/workspaces/{workspaceId}/documents` | Create/list/get/update/delete documents; read revisions and comments; add or remove comments. Project-bound documents inherit project visibility. |
| Calendar | `/workspaces/{workspaceId}/events` | Create/list/get/update/cancel/delete events; manage invitations and responses. |
| Meetings | `/workspaces/{workspaceId}/meetings` | Create/list/get/update/delete meetings; join/leave and manage participants. This API stores meeting state but does not provide a calling SDK. |
| Forms | `/workspaces/{workspaceId}/forms` | Create/list/get/update/delete forms; manage fields and submit/list responses. All current routes require an authenticated active account. |
| Search | `/search` | Unified search across people, workspaces, teams, departments, projects, tasks, messages, conversations, files, documents, meetings, and channels. Supports category, workspace, page/limit, and relevance/recent filters, suggestions, and per-user recent-search history. Every result is permission-filtered. |
| Integrations | `/integrations` | List/manage personal and workspace integrations, OAuth connections, enable/disable, token refresh, provider revocation on disconnect, and durable sync jobs. Live connections require provider credentials and callback configuration. |
| Outbound webhooks | `/workspaces/{workspaceId}/webhooks` | Manage workspace webhook subscriptions and inspect/retry durable HMAC-signed deliveries. |
| Automations | `/workspaces/{workspaceId}/automations` | Create/list/get/update/delete automation definitions; read execution history; retry a failed run. Triggers cover task created/completed/status-changed/assigned/due-date-passed, member joined, form submitted, and daily/weekly schedules. Actions cover notifications, task creation, signed outbound webhooks, field updates, assignment, and channel messages. The Redis-backed worker re-checks the owner's permissions at execution time, applies conditions, and records durable run history with bounded retries and idempotency. |
| AI | `/ai` | Conversations and streamed answers, workspace-aware authorised context, usage limits, writing analysis/rewrite/summarize/translate, task generation with preview/confirm, summarization, project intelligence, personal productivity, knowledge search, meeting transcript summarization, and approval-gated AI actions. Runs in-process via OpenRouter when `AI_ENABLED=true` and `AI_PROVIDER=openrouter` (requires `AI_MODEL` and `OPENROUTER_API_KEY`); `AI_PROVIDER=service` keeps the optional Python/FastAPI service. Degrades with a clear 503 when unconfigured. |
| Audit | `/workspaces/{workspaceId}/audit` | Read workspace audit events subject to authorization. Use `?securityEvent=true` to show only security-relevant changes. |
| Analytics | `/analytics` | Return permission-filtered aggregated workspace metrics (activity, projects, tasks, members, meetings, files, subscription). Results are cached for a short TTL. Scoped aggregates under `/analytics/tasks/*` and `/analytics/time-logged` support workspace and optional project filters; project scope requires project visibility, and private projects never leak into workspace-wide totals. |

Task comment creation accepts `{ body, parentId?, mentionedUserIds? }`.
`mentionedUserIds` is an optional array of up to 50 distinct user IDs. Each
recipient must be an active workspace member with access to the task's
project; invalid or inaccessible recipients receive the generic
`INVALID_MENTION_RECIPIENT` error. The author is silently excluded from
mentions. Valid mentions are persisted with the comment and create a general
`MENTION` notification. A post-commit email is attempted through the existing
idempotent email outbox and cannot roll back the comment.

Department routes cover listing, creation, renaming, and member assignment or
removal; department deletion and department-settings routes are not
registered. The OpenAPI document does not yet describe all these registered
route families and is incomplete relative to the running router.

## File attachment versions (BE-3)

File versions apply to `FileAttachment` only (not `ResourceFile`). Creating a
file with `POST /workspaces/{workspaceId}/files` still creates a new attachment
and its v1 version; `POST /workspaces/{workspaceId}/files/{fileId}/versions`
never infers a version from the filename. The legacy
`FileAttachment.storageKey` remains the v1 object key and is never used for
downloads. `FileAttachment.fileName`, `mimeType` and `sizeBytes` mirror the
current version and are updated in the same transaction as upload,
make-current, delete-promote and attachment deletion. `FileSummary` is
unchanged and does not expose a storage key.

All routes below are relative to `/api/v1`, require authentication and an
active account, and return `{ "success": true, "data": ... }` on success.
Cursor pagination uses `limit` (1-100, default 25) and `cursor`, ordered by
`(createdAt, id)`.

| Method | Path | Response data | Notes |
| --- | --- | --- | --- |
| `GET` | `/workspaces/{workspaceId}/files/{fileId}/versions` | `{ items, nextCursor }` | Live versions only. |
| `POST` | `/workspaces/{workspaceId}/files/{fileId}/versions` | `{ version }` (201) | Multipart `file`; optional `changeNote`. |
| `GET` | `/workspaces/{workspaceId}/files/{fileId}/versions/{versionId}` | `{ version }` | Live version only. |
| `GET` | `/workspaces/{workspaceId}/files/{fileId}/versions/{versionId}/download` | Raw bytes | `Content-Type` is the stored version `mimeType`. |
| `POST` | `/workspaces/{workspaceId}/files/{fileId}/versions/{versionId}/make-current` | `{ version }` | 200 no-op if already current. IDs and storage keys never change. |
| `DELETE` | `/workspaces/{workspaceId}/files/{fileId}/versions/{versionId}` | `{ ok: true }` | 409 `LAST_VERSION` for the last live version; deleting the current version promotes the highest remaining live version. |
| `GET` | `/workspaces/{workspaceId}/files/{fileId}/versions/{versionId}/feedback` | `{ items, nextCursor }` | Feedback on any live version. |
| `POST` | `/workspaces/{workspaceId}/files/{fileId}/versions/{versionId}/feedback` | `{ feedback }` (201) | Body `body` (1-4000 non-blank characters). |
| `PATCH` | `/workspaces/{workspaceId}/files/{fileId}/versions/{versionId}/feedback/{feedbackId}` | `{ feedback }` | Author only; live feedback. Sets `editedAt`. |
| `DELETE` | `/workspaces/{workspaceId}/files/{fileId}/versions/{versionId}/feedback/{feedbackId}` | `{ ok: true }` | Author or project/workspace admin. |

`AttachmentVersionSummary` fields: `id`, `attachmentId`, `versionNumber`,
`isCurrent`, `fileName`, `mimeType`, `sizeBytes`, `uploadedById`, `changeNote`,
`createdAt` (ISO-8601). Storage keys are not exposed in summaries.

`FeedbackSummary` fields: `id`, `attachmentVersionId`, `authorId`, `body`,
`createdAt`, `updatedAt`, `editedAt` (ISO-8601 or `null`).

Permission matrix (server-side): outsiders and wrong-workspace requests are
403/404 as for existing attachment routes; private or invisible projects are
404; project reads require `project.view`; project version/feedback writes and
make-current require `file.upload`; workspace-level writes reject `VIEWER`
with 403 `INSUFFICIENT_ROLE`. Soft-deleted attachments, versions and feedback
return 404. Feedback is visible to anyone who can view its version.

`sizeBytes` is always derived from the bytes actually put into private object
storage; client-declared sizes are ignored. Download reads use explicit
`allowedContentTypes` (`ALLOWED_MIME_TYPES`) and
`maxReadBytes = min(version.sizeBytes, MAX_FILE_SIZE_BYTES)`, leaving storage
adapter defaults for avatars and logos untouched. Deleting a version or an
attachment removes only the objects referenced by version rows, best effort.

Audit events are written in the same transaction as the mutation:
`file.version.created`, `file.version.made_current`, `file.version.deleted`,
`file.feedback.created`, `file.feedback.updated`, `file.feedback.deleted`.
BE-3 writes the audit events only; the `ATTACHMENT_VERSION_ADDED` in-app row
for a new project version is created by BE-5 in the same transaction.

Known limitations: a crash between object put and commit leaves an orphaned
object; soft-deleted objects are retained until a separate retention task;
signed/direct uploads, streaming and content sniffing are out of scope.

## Project checklists (BE-4)

A checklist is workspace/project-scoped and owns an ordered list of live items
plus a `revision` counter. BE-2 binds a review to a checklist by storing the
stable `Checklist.id` together with the observed `revision`, so an approval is
pinned to one exact item state; editing an approved checklist starts a new
review there. BE-4 itself adds no `taskId` link and no roll-up to task
progress. Templates (`ChecklistTemplate`, `ChecklistTemplateItem`) are
deferred and are not present in this schema.

All routes below are under `/api/v1`, require authentication and an active
account, and return `{ "success": true, "data": ... }` on success. Checklist
listing and feedback listing use cursor pagination (`limit` 1-100, default 25,
ordered by `(createdAt, id)`). Checklist items are **not** paginated: a
checklist holds at most 200 live items, ordered by dense `position`.

| Method | Path | Response data | Notes |
| --- | --- | --- | --- |
| `GET` | `/workspaces/{workspaceId}/projects/{projectId}/checklists` | `{ items, nextCursor }` | Cursor-paginated live checklists. |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/checklists` | `{ checklist }` (201) | Body `title` (1-200 non-blank) and optional `description` (0-2000 or `null`). |
| `GET` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}` | `{ checklist }` | Live checklist only. |
| `PATCH` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}` | `{ checklist }` | Body `title` and/or `description`; does not change `revision`. |
| `DELETE` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}` | `{ ok: true }` | Soft-deletes the checklist and its live items. |
| `GET` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}/items` | `{ items }` | All live items by `position`. |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}/items` | `{ item, revision }` (201) | Body `text` (1-500 non-blank). Appends at `position = live count`; 409 `CHECKLIST_ITEM_LIMIT` at 200. |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}/items/reorder` | `{ items, revision }` | Body `itemIds`: the complete ordered list of live item ids. Extras, missing or duplicate ids give 409 `CHECKLIST_ITEMS_MISMATCH`. |
| `PATCH` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}/items/{itemId}` | `{ item, revision }` | Body `text` only; `position` is not client-writable. |
| `DELETE` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}/items/{itemId}` | `{ ok: true, revision }` | Soft-deletes the item and renumbers remaining live items densely. |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}/items/{itemId}/complete` | `{ item, revision }` | Conditional update; already completed is a 200 no-op with no audit event. |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}/items/{itemId}/uncomplete` | `{ item, revision }` | 409 `ITEM_SIGNED_OFF` if signed off; completer or manager/admin only. |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}/items/{itemId}/sign-off` | `{ item, revision }` | Requires completion, `submission.approve`, and a signer different from the completer; already signed is a 200 no-op. |
| `DELETE` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}/items/{itemId}/sign-off` | `{ item, revision }` | Original signer or project/workspace admin; leaves `completed` unchanged; no-op when unsigned. |
| `GET` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}/items/{itemId}/feedback` | `{ items, nextCursor }` | Feedback on one live item. |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}/items/{itemId}/feedback` | `{ feedback }` (201) | Body `body` (1-4000 non-blank). |
| `PATCH` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}/items/{itemId}/feedback/{feedbackId}` | `{ feedback }` | Author only; sets `editedAt`. |
| `DELETE` | `/workspaces/{workspaceId}/projects/{projectId}/checklists/{checklistId}/items/{itemId}/feedback/{feedbackId}` | `{ ok: true }` | Author or project/workspace admin. |

`ChecklistSummary` fields: `id`, `workspaceId`, `projectId`, `title`,
`description`, `revision`, `createdById`, `createdAt`, `updatedAt` (timestamps
are ISO-8601). `ChecklistItemSummary` fields: `id`, `checklistId`, `position`,
`text`, `completed`, `completedById`, `completedAt`, `signedOffById`,
`signedOffAt` (timestamps ISO-8601 or `null`).
`ChecklistItemFeedbackSummary` fields: `id`, `checklistItemId`, `authorId`,
`body`, `createdAt`, `updatedAt`, `editedAt` (ISO-8601 or `null`).

Permission rules (server-side, same 403/404 order as other project routes):
outsiders get 403, wrong-workspace checklist ids and private/invisible
projects get 404, and `VIEWER` gets 403 on every write. Reads require
`project.update`-independent `project.view`; checklist creation/edit/delete and
all item create/edit/delete/reorder/complete/feedback writes require
`project.update` (held by `PROJECT_MANAGER` and workspace admins — a plain
`MEMBER` does **not** hold it). `uncomplete` is additionally allowed for the
completer or a project manager/admin; a non-completer `MEMBER` gets 403.
Sign-off requires `submission.approve` (`PROJECT_MANAGER` and workspace
`OWNER`/`PROJECT_MANAGER` admins, not `MEMBER`/`COLLABORATOR`/`VIEWER`) and a
signer different from the completer (403 `SELF_REVIEW_FORBIDDEN`). Sign-off
removal is allowed for the original signer or a project manager/admin, with no
signer-differs check. Feedback is visible to anyone who can view its item;
editing requires the author, deletion requires the author or an admin.
Soft-deleted checklists, items and feedback return 404.

Ordering and concurrency: `position` is dense and server-assigned. New items
append at `position = live count`; deleting an item renumbers the remaining
live items densely in the same transaction. `Checklist ... FOR UPDATE`
serializes reorder, item create/delete and every revision-changing write, so
concurrent reorders cannot produce duplicate or sparse positions. `revision`
starts at 1 and is incremented with an atomic `UPDATE ... SET revision =
revision + 1` inside the same transaction on every real item create, edit,
delete, reorder, complete, uncomplete, sign-off or sign-off removal. No-ops and
feedback writes do not change `revision` and emit no audit event; real state
conflicts return 409. Complete and sign-off use conditional `updateMany`
statements with no separate item lock.

The migration `20261120150000_be4_checklists` adds three tables (no backfill,
no edits to applied migrations) with raw-SQL CHECKs: `position >= 0`, item text
1-500 non-blank, feedback body 1-4000 non-blank, `signedOffAt` requires
`completedAt`, and `completedById`/`signedOffById` present if and only if their
timestamp is. The actor FKs use `ON DELETE RESTRICT`, matching BE-3.

Audit events are written in the same transaction as the mutation:
`checklist.created`, `checklist.updated`, `checklist.deleted`,
`checklist_item.created`, `checklist_item.updated`, `checklist_item.deleted`,
`checklist_item.reordered`, `checklist_item.completed`,
`checklist_item.uncompleted`, `checklist_item.signed_off`,
`checklist_item.sign_off_removed`, `checklist_item.feedback_created`,
`checklist_item.feedback_updated`, `checklist_item.feedback_deleted`. BE-4
writes the audit events only; the `CHECKLIST_SIGNED_OFF` in-app row is created
by BE-5 in the same transaction.

Owner-confirmed amendments that override the earlier design note on conflict:
(1) complete and sign-off use conditional `updateMany` only, with no separate
item lock; the `Checklist FOR UPDATE` lock is for reorder, item create, item
delete and any revision change. (2) Deleting an item renumbers remaining live
items densely in the same transaction under the `Checklist` lock — "position
changes only by reorder" is amended to "only by reorder or by item
delete/create", with new items appended at `position = live count`. (3)
Uncomplete is allowed for the completer or a project manager/admin (workspace
admins included) and a non-completer `MEMBER` gets 403; create, edit and delete
of items stay on `project.update`.

## Submission reviews (BE-2)

A shared review binds to exactly one typed target — an attachment version or a
checklist — and records status, round and a decision log. There is no
polymorphic `resourceId`. A checklist review pins the observed
`Checklist.revision`, so an approval applies to one exact item state; edits that
advance the revision leave the review stale until it is resubmitted. New rows
start in `SUBMITTED` at round 1. `SUBMITTED` and `UNDER_REVIEW` are open states;
`APPROVED` is terminal. `reject` and `request-changes` both set
`CHANGES_REQUESTED`, distinguishable by the decision log. Assignment is
optional/advisory: any holder of the decision permission may decide. BE-2
writes the audit events; BE-5 creates the review in-app rows in the same
transaction as each lifecycle change.

All routes below are under `/api/v1`, require authentication and an active
account, and return `{ "success": true, "data": ... }` on success. Listing uses
cursor pagination (`limit` 1-100, default 25, `cursor` a review id), ordered by
`(createdAt, id)`. Reads require `project.view`; writes require the submission
permission named below. Project visibility applies to the target as usual, and
a soft-deleted target hides its reviews with 404.

| Method | Path | Response data | Notes |
| --- | --- | --- | --- |
| `GET` | `/workspaces/{workspaceId}/projects/{projectId}/reviews` | `{ items, nextCursor }` | Filters `targetKind`, `targetId`, `status`, `assigneeId`, `cursor`, `limit`. Requires `project.view`. |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/reviews` | `{ review }` (201) | Body has exactly one of `attachmentVersionId` or `checklistId`, plus optional `assigneeId`. Requires `submission.submit`. |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/reviews/{reviewId}/assign` | `{ review }` | Body `{ assigneeId }`; assignee must be a project member with `submission.review` and differ from the submitter. Requires `submission.review`. |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/reviews/{reviewId}/start` | `{ review }` | No body. Requires `submission.review`. |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/reviews/{reviewId}/resubmit` | `{ review }` | Body `{ round }`; reopens a `CHANGES_REQUESTED` review on the same row. Requires `submission.submit`. |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/reviews/{reviewId}/approve` | `{ review, decision }` | Body `{ round, note? }`; requires `submission.approve`. Direct `SUBMITTED → APPROVED` is allowed. |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/reviews/{reviewId}/reject` | `{ review, decision }` | Body `{ round, note }` (note required); requires `submission.reject`. |
| `POST` | `/workspaces/{workspaceId}/projects/{projectId}/reviews/{reviewId}/request-changes` | `{ review, decision }` | Body `{ round, note }` (note required); requires `submission.request_revision`. |
| `GET` | `/workspaces/{workspaceId}/projects/{projectId}/reviews/{reviewId}` | `{ review }` | Requires `project.view`. |

**Request shapes.** The list query accepts `targetKind` (`attachmentVersion` or
`checklist`), `targetId` (uuid), `status` (`SUBMITTED`, `UNDER_REVIEW`,
`APPROVED`, `CHANGES_REQUESTED`), `assigneeId` (uuid), `cursor` (uuid) and
`limit` (1-100, default 25). Create takes exactly one of `attachmentVersionId`
or `checklistId` (uuid) and an optional `assigneeId` (uuid). `assign` takes
`{ assigneeId: uuid }`; `start` takes no body. `resubmit`, `approve`, `reject`
and `request-changes` take a positive integer `round`; `approve` allows an
optional `note` (1-2000 non-blank characters) while `reject` and
`request-changes` require it.

**Response shapes.** `ReviewView`: `id`, `workspaceId`, `projectId`, `resource`
(`{ kind: "attachmentVersion"|"checklist", id, revision? }`, where `revision`
appears only for checklists), `status`, `round`, `assigneeId` (uuid or `null`),
`submittedById`, `submittedAt`, `checklistRevision` (integer or `null`),
`lastDecision` (`ReviewDecisionView` or `null`), `stale` (boolean), `createdAt`,
`updatedAt` (timestamps ISO-8601). `ReviewDecisionView`: `id`, `reviewId`,
`round`, `decision` (`APPROVED`|`REJECTED`|`CHANGES_REQUESTED`), `note` (string
or `null`), `decidedById`, `decidedAt` (ISO-8601).

**Rules and concurrency.** Decision and resubmit bodies must carry the current
`round`; a mismatch returns 409 `STALE_ROUND`, and a decided round returns 409
`REVIEW_ALREADY_DECIDED`. Submitting a checklist requires at least one live item
with every live item completed, otherwise 409 `CHECKLIST_NOT_READY` (create and
resubmit). The checklist revision is pinned on the review; deciding or
resubmitting against a newer revision returns 409 `CHECKLIST_REVISION_STALE`.
Resubmit reopens the same `Review` row (it never creates a new one). An existing
`APPROVED` review for the same attachment version, or the same checklist at the
same revision, returns 409 `REVIEW_ALREADY_APPROVED`; an open review for the same
target returns 409 `REVIEW_ALREADY_OPEN`. Assigning the same assignee and
starting an already `UNDER_REVIEW` review are 200 no-ops. Soft-deleted targets
hide their reviews with 404 `REVIEW_TARGET_NOT_FOUND` (or `REVIEW_NOT_FOUND`
when addressed by review id).

Audit events are written in the same transaction as the mutation:
`review.created`, `review.assigned`, `review.started`, `review.resubmitted`,
`review.approved`, `review.rejected`, `review.changes_requested`. BE-2 adds no
`NotificationType` values and creates no notifications.

| Error code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Malformed target/assignee ids, body or query; invalid round or note. |
| `AUTHENTICATION_REQUIRED` | 401 | No valid bearer access token. |
| `PERMISSION_DENIED` | 403 | Caller lacks the required project/submission permission. |
| `SELF_REVIEW_FORBIDDEN` | 403 | Assignee or decision maker is the submitter. |
| `WORKSPACE_ACCESS_DENIED` | 403 | Caller is not an active member of the workspace. |
| `REVIEW_NOT_FOUND` | 404 | Review id is unknown or its target is soft-deleted. |
| `REVIEW_TARGET_NOT_FOUND` | 404 | The referenced attachment version or checklist does not exist in the project or is soft-deleted. |
| `PROJECT_NOT_FOUND` | 404 | Project is missing or invisible to the caller. |
| `REVIEW_ALREADY_OPEN` | 409 | An open review already exists for this target. |
| `REVIEW_ALREADY_APPROVED` | 409 | This target already has an approved review (checklist: same pinned revision). |
| `CHECKLIST_NOT_READY` | 409 | Checklist has no live items or some live item is incomplete. |
| `CHECKLIST_REVISION_STALE` | 409 | Checklist revision advanced past the pinned revision. |
| `STALE_ROUND` | 409 | Body `round` does not match the review's current round. |
| `REVIEW_ALREADY_DECIDED` | 409 | This review round was already decided. |
| `REVIEW_NOT_OPEN` | 409 | Assignment requires an open (`SUBMITTED`/`UNDER_REVIEW`) review. |
| `INVALID_STATUS_TRANSITION` | 409 | Resubmit is not allowed from the review's current status. |

## Projects and project visibility (Phase 8 — in progress)

Project records are workspace-scoped. All project-scoped routes enforce access
in this order: authenticate → active workspace membership → effective project
access/visibility → project permission → resource-specific special rules.

### Visibility and access sources

- `WORKSPACE`: visible to active workspace members. Members without explicit
  project membership receive read-only base access (`project.view`,
  `task.view`) with `accessSource = "workspace_member"`; writes require an
  explicit project membership.
- `DEPARTMENT_TEAM`: inherited base read access comes from active team
  membership when a team is linked, otherwise from active department
  membership. Team linkage narrows scope over department membership. Inherited
  access is read-only with `accessSource = "team_member"` or
  `"department_member"` unless the caller has explicit project membership.
- `PRIVATE`: requires explicit project membership or project ownership. No
  inherited visibility.

Cross-workspace, missing, or inaccessible restricted project IDs return
`404 PROJECT_NOT_FOUND` (no existence leak). When a caller can see the project
but lacks the required permission, the server returns
`403 PERMISSION_DENIED` with the standard error envelope and
`error.requiredPermission` set to the missing permission.

### Project type

`Project.type` is a classification with values `GENERAL` (the default),
`ENGINEERING`, `DESIGN`, `OPERATIONS`, `MARKETING` and `HR`. It is accepted on
project create and update and returned in project list and detail responses.
The value only selects which environment renders the project; it grants no
access and does not change visibility, membership or project permissions.
Existing clients that omit `type` receive `GENERAL` and keep their current
behavior.

### Project roles and permission catalog

Project roles: `PROJECT_MANAGER`, `MEMBER`, `COLLABORATOR`, `VIEWER`.
`project.delete` is not granted by the project-manager role; project deletion
is reserved for workspace administrators and the project owner.

- **Workspace administrators (legacy implicit access):** workspace `OWNER` or
  `PROJECT_MANAGER` memberships **without** an organization role receive
  implicit full project permissions for workspace projects, including
  `project.delete`, with `accessSource = "workspace_admin"` and effective
  project role `PROJECT_MANAGER`. Organization owners/admins (organization-role
  members) do **not** receive implicit private-project access and must hold
  explicit project membership.
- **Explicit project members / project owners:** permissions come from the
  project role (`accessSource = "project_member"`). The project owner always
  holds the `PROJECT_MANAGER` role.
- **Institution role mapping (single source):** Department Head and
  Lecturer/Staff are project-manager capable (ceiling `PROJECT_MANAGER`);
  Student ceiling `MEMBER`; Collaborator/Viewer ceilings match their roles.
- **Role ceiling:** workspace `VIEWER` → `VIEWER` only; `COLLABORATOR` →
  `COLLABORATOR`/`VIEWER`; `MEMBER` and above → any role up to their ceiling.
  Actors cannot grant roles above their own effective project role or above the
  target member’s ceiling, and users cannot change their own project role.

Special rules enforced in authorization/services: no self approval/review/
reject/request-revision of own submissions; a project must retain at least one
project manager; project owners cannot be removed or demoted below
`PROJECT_MANAGER` (transfer ownership first); added members must be active
workspace members. `task.update` never implies submission approval/review.
Submission permissions exist in the catalog/matrix for future submission
resources; task status transitions to `APPROVED`/`UNDER_REVIEW`/
`CHANGES_REQUESTED` currently enforce the corresponding submission permissions
and self-review protection.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/workspaces/{workspaceId}/projects` | Active workspace member | Cursor-paginated visible projects; supports `status`, `visibility`, `teamId`, `departmentId`, `search`, and `includeArchived`. |
| POST | `/workspaces/{workspaceId}/projects` | Workspace role with project creation capability | Create project; body includes `name`, `key`, optional `description`, `category`, `labels`, `type`, `visibility`, `teamId`, `departmentId`, `startDate`, `dueDate`. `type` defaults to `GENERAL`. Owner and initial PROJECT_MANAGER membership are server-assigned. |
| GET | `/workspaces/{workspaceId}/project-roles` | Active workspace member | Project role catalog: `{ items: [{ role, label, description, permissions }] }`. |
| GET | `/workspaces/{workspaceId}/projects/{projectId}` | Project reader (`project.view`) | Read an authorized project. |
| GET | `/workspaces/{workspaceId}/projects/{projectId}/permissions` | Active workspace member with project visibility | Effective permissions: `{ projectId, workspaceRole, projectRole, accessSource, permissions: string[], assignableRoles: string[] }`. |
| PATCH | `/workspaces/{workspaceId}/projects/{projectId}` | `project.update` | Update metadata, scope, visibility, category/type/labels, lifecycle status (excluding ARCHIVED), and dates. |
| POST | `/workspaces/{workspaceId}/projects/{projectId}/transfer-ownership` | Current project owner or workspace OWNER/PROJECT_MANAGER (including organization owner/admin) | Immediately transfer ownership. Body: `{newOwnerId, previousOwnerRole?}` where prior role is `MANAGER` (default), `MEMBER`, or `REMOVE`. No notification is sent. |
| DELETE | `/workspaces/{workspaceId}/projects/{projectId}` | `project.delete` (workspace admin or project owner) | Soft-delete project. |
| POST | `/workspaces/{workspaceId}/projects/{projectId}/archive` | `project.archive` | Archive project. |
| POST | `/workspaces/{workspaceId}/projects/{projectId}/restore` | `project.archive` | Restore archived project to its prior status (or PLANNING if no archive record exists). |
| GET | `/workspaces/{workspaceId}/projects/{projectId}/members` | `project.view` | List project members. |
| POST | `/workspaces/{workspaceId}/projects/{projectId}/members` | `project.member.manage` | Add/update member role (`PROJECT_MANAGER`, `MEMBER`, `COLLABORATOR`, `VIEWER`) for an active workspace member (audited). |
| PATCH | `/workspaces/{workspaceId}/projects/{projectId}/members/{userId}` | `project.member.manage` | Change project role (audited). |
| DELETE | `/workspaces/{workspaceId}/projects/{projectId}/members/{userId}` | `project.member.manage` | Remove project membership (audited; owner/last manager safeguards apply). |
| GET | `/workspaces/{workspaceId}/projects/{projectId}/activity` | `project.view` | Read cursor-paginated project audit activity. |
| GET/POST | `/workspaces/{workspaceId}/projects/{projectId}/milestones` | `project.view` / `project.update` | List milestones or create one (`name`, optional `description`, `dueDate`, `position`). |
| PATCH/DELETE | `/workspaces/{workspaceId}/projects/{projectId}/milestones/{milestoneId}` | `project.update` | Update or delete a milestone. Completion is represented by `completedAt`; update accepts `completed: boolean`. |

Project mutations and membership/milestone changes write audit records in the
same database transaction. Membership addition/role change/removal, archive,
delete and relevant task submission decisions are audited with actor, target,
before/after metadata and project/workspace context. Project-level settings
remain deferred; no settings API is invented. Task, file and other project-
scoped routes must enforce the shared project authorization policy. Phase 8
remains in progress until all roadmap settings and related-resource
integration criteria are verified.

Project mutations and membership/milestone changes write audit records in the
same database transaction. Membership addition also creates an in-app
notification. Task, message, file, and meeting APIs are not currently exposed;
their own phases must use the shared `requireProjectAccess` policy before
exposing project-associated resources. Phase 8 remains in progress until all
roadmap settings and related-resource integration criteria are verified.

Ownership transfer is an exception to ordinary project-manager authority:
project-level managers cannot force-transfer ownership. Workspace owners,
workspace project managers/admins, and organization owners/admins can force
transfer, but only if they can already view the project. The recipient must be
an active workspace member with an eligible organization role. PRIVATE project
recipients may be added to the project in the transfer transaction. For
DEPARTMENT_TEAM projects, a team link takes precedence over department scope;
the recipient must belong to the active linked team, or, for a department-only
project, to the linked department. This is an OR between the supported parent
scope alternatives, not an AND when a team belongs to a department. The old
owner's resulting role is applied atomically, and exactly one transfer activity
record identifies actor, old/new owner, resulting role, and forced-admin flag.
Archived projects may transfer; soft-deleted projects return 404. Errors use
400 for self-transfer, 403 for a visible unauthorized caller, 404 for an
invisible project, 409 for a concurrent owner change or manager invariant, and
422 for an ineligible recipient.

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

## AI service (Phases 21–23)

All AI routes require an authenticated active account. Paths are relative to
`/api/v1`. When the optional Python/FastAPI service is disabled or
misconfigured, AI endpoints return HTTP 503 `AI_NOT_CONFIGURED`; they never
break non-AI features. Express performs every permission check and prepares
the only context the AI service receives. The AI service never writes to the
Nexus database and never executes a mutation itself.

### Conversations

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/ai/health` | Report configuration and AI service health (`configured`, `status`, `latencyMs`, optional `version`). |
| POST | `/ai/chat` | Ask a question. Body: `{workspaceId?,conversationId?,query,projectId?,taskId?,documentId?,meetingId?,contextType?,contextId?}`. Returns `{conversationId,answer,references,model,usage,sources}`. |
| POST | `/ai/chat/stream` | Same body; responds with server-sent events `conversation`, `token`, `references`, `done`, or `error`. |
| GET | `/ai/conversations?workspaceId=&cursor=&limit=` | Stable cursor page of the caller's conversations. |
| GET | `/ai/conversations/{conversationId}` | Read one owned conversation and its messages. |
| DELETE | `/ai/conversations/{conversationId}` | Delete an owned conversation and its messages. |
| GET | `/ai/usage?workspaceId=` | Daily request and monthly token usage against configured limits. |
| POST | `/ai/tasks/generate` | Return a validated task preview (title, description, status, priority, category, labels, dueDate) for a project. Saves nothing; confirm separately. Body: `{workspaceId,projectId,prompt}`. |
| POST | `/ai/tasks/generate/confirm` | Create a task from a preview through the existing task service after re-checking permissions. Body: `{workspaceId,projectId,preview:{...}}`. |
| POST | `/ai/summarize` | Summarise a channel (with optional `from`/`to` date range), project, task, document or meeting. Context is permission-checked before any text reaches the AI service. Body: `{workspaceId,contextType,contextId?,channelId?,from?,to?,maxMessages?}`. |
| POST | `/ai/projects/intelligence` | Return DB-computed project health numbers (overdue, blocked, unassigned, completed tasks and per-assignee workload) plus a model explanation. Body: `{workspaceId,projectId}`. |
| GET | `/ai/personal/tasks` | Tasks assigned to the caller in a workspace. Query: `?workspaceId=`. |
| POST | `/ai/personal/daily-plan` | Propose a concise daily plan from the caller's assigned tasks. Body: `{workspaceId}`. |
| POST | `/ai/personal/weekly-report` | Write a weekly report from the caller's tasks. Body: `{workspaceId}`. |
| POST | `/ai/knowledge/search` | Answer a question from permission-filtered search results, citing sources as `[type:id]`. Body: `{workspaceId,query,category?,limit?}`. |
| POST | `/ai/meetings/{meetingId}/summarize` | Summarize an existing meeting transcript for a participant or creator. Path: `meetingId`. |

Context is limited to workspaces, projects, tasks, documents and meetings the
caller may currently access. Private projects, hidden documents and meetings
the caller is not part of are excluded before any text reaches the AI service.
Returned citations are filtered against the authorised source set. Usage rows
are written for successful and failed calls.

### Nexus Write

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/ai/writing/analyze` | Analyse text. Body: `{workspaceId?,text,features[],language?,toneTarget?}`; returns `{sessionId,suggestions,detectedTone,summary,usage,expiresAt}`. |
| POST | `/ai/writing/rewrite` | Rewrite text from `{workspaceId?,text,instruction,tone?}`; returns the rewritten `text` and explanation. |
| POST | `/ai/writing/summarize` | Summarise text using the rewrite contract with a summarisation instruction. |
| POST | `/ai/writing/translate` | Translate text using the rewrite contract with a translation instruction. |
| POST | `/ai/writing/sessions/{sessionId}/accept` | Apply selected `{suggestionIds[]}`. Returns the resulting `text`; the caller's editor decides whether to save it. |
| POST | `/ai/writing/sessions/{sessionId}/dismiss` | Discard a writing session and its retained original text. |

Analysis never modifies a document, message or comment. Original text is
retained only until the session is accepted, dismissed or expires (default 60
minutes) and is cleared afterwards.

### Approval-gated actions

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/ai/actions/proposals` | Create a proposal. Body: `{workspaceId,actionType,payload,conversationId?,title?,summary?,idempotencyKey?,sourceReferences?}`. |
| GET | `/ai/actions/proposals?workspaceId=&status=&cursor=&limit=` | List the caller's proposals in a workspace. |
| GET | `/ai/actions/proposals/{proposalId}` | Read one proposal. |
| POST | `/ai/actions/proposals/{proposalId}/approve` | Approve a proposed action (`{note?}`). |
| POST | `/ai/actions/proposals/{proposalId}/reject` | Reject a proposed or approved action (`{note?}`). |
| POST | `/ai/actions/proposals/{proposalId}/cancel` | Cancel a proposed or approved action. |
| POST | `/ai/actions/proposals/{proposalId}/execute` | Execute an approved action after re-checking permissions. |

Supported `actionType` values are `CREATE_TASK`, `ADD_TASK_COMMENT`,
`COMPLETE_TASK`, `CREATE_DOCUMENT` and `SEND_NOTIFICATION`. A proposal is
inert until approved. Approval and execution both re-evaluate the caller's
current workspace/project permissions. Execution uses a conditional
`APPROVED → EXECUTING` transition so concurrent requests cannot apply the same
action twice. Proposals expire after the configured approval TTL (default 15
minutes). Propose, approve, reject, execute and failure events are audited.
Providing the same `idempotencyKey` for the same user and workspace returns the
existing proposal instead of creating a duplicate.

## Task working environment (Phase 3)

All routes require an authenticated, active account and are mounted under
`/api/v1/workspaces/{workspaceId}/projects/{projectId}/tasks`.
Project/task access is enforced server-side through `authorizeProject` and the
project permission catalog; hidden/inaccessible projects return 404. Permission
denials return 403 `PERMISSION_DENIED` with `requiredPermission` where applicable.

### Workspace aggregate

| Method | Path | Request | Success response | Errors | Required permission |
| --- | --- | --- | --- | --- | --- |
| GET | `/{taskId}/workspace` | Path params: `workspaceId`, `projectId`, `taskId` | `200 { success, data: { task, subtasks, progress, people, schedule, recentActivity } }`. `task`/`subtasks` are task summaries including `weight` (positive integer, default 1; meaningful for subtasks), `requiresApproval`, `expectedDeliverables`, `submissionSummary`, `submittedAt`, `submittedById`, `submittedBy`, `reviewFeedback`, `reviewedAt`, `reviewedById`, `reviewedBy`, `subTaskCount`, `commentCount`, `attachmentCount`, assignees/dependencies/blockers. `progress` is **server-computed only** from subtasks: `{ percent, completed, total }` where `completed`/`total` are subtask counts and `percent = round((sum of weights of APPROVED subtasks / sum of weights of all subtasks) * 100)` (0% when there are no subtasks; only `APPROVED` subtasks contribute to completed progress; equal weights produce the same results as the Phase 3 count-based progress). `people`: `{ assignees, assignedBy, reviewer }`. `schedule`: `{ startDate, dueDate, overdue }`. `recentActivity`: newest-first last 5 audit events for the task. | 401 unauthenticated, 403/404 project/task access denied or not found (`PROJECT_ACCESS_DENIED`/`PROJECT_NOT_FOUND`/`TASK_NOT_FOUND`) | `task.view` |

### Task activity timeline

| Method | Path | Request | Success response | Errors | Required permission |
| --- | --- | --- | --- | --- | --- |
| GET | `/{taskId}/activity` | Query: `cursor?` (audit log id), `limit?` (1-100, default 25) | `200 { success, data: { items, nextCursor } }` newest-first, cursor-paginated audit events relevant to the task (task/comment/assignee/dependency actions). Each item: `{ id, action, actorId, metadata, createdAt }`. | 401, 403/404 access/not found | `task.view` |

### Submission and review

| Method | Path | Request | Success response | Errors | Required permission |
| --- | --- | --- | --- | --- | --- |
| POST | `/{taskId}/submit` | Body: `{ "workSummary": string(1-10000) }` | `200 { success, data: <task summary> }` with `status: SUBMITTED`, submission metadata set, review feedback cleared. Requires task in submittable state and (assignee or authorized updater); tasks with required deliverables must include work summary. | 400 `DELIVERABLES_REQUIRED`, 403 `PERMISSION_DENIED`, 404 `TASK_NOT_FOUND`, 409 `TASK_SUBMIT_NOT_ALLOWED` | `submission.submit` |
| POST | `/{taskId}/review` | Body: `{ "decision": "START_REVIEW"|"APPROVE"|"REQUEST_CHANGES", "feedback"?: string }` (`feedback` required for `REQUEST_CHANGES`) | `200 { success, data: <task summary> }` with status `UNDER_REVIEW`/`APPROVED`/`CHANGES_REQUESTED` and review metadata/audit recorded. Self-review of own submission is forbidden. | 400 validation, 403 `PERMISSION_DENIED`/`SELF_REVIEW_NOT_ALLOWED`, 404 `TASK_NOT_FOUND` | `submission.review` (`START_REVIEW`), `submission.approve` (`APPROVE`), `submission.request_revision` (`REQUEST_CHANGES`) |

### Subtask completion (approval-gated)

| Method | Path | Request | Success response | Errors | Required permission |
| --- | --- | --- | --- | --- | --- |
| POST | `/{taskId}/subtasks/{subtaskId}/complete` | Body: `{ "workSummary"?: string }` | `200 { success, data: { subtask, progress, requiresApproval, submissionCreated } }`. If subtask or parent task `requiresApproval=true`, creates submission for review instead of immediate approval: subtask becomes `SUBMITTED` with submission metadata (`submissionCreated: true`); otherwise subtask becomes `APPROVED`/completed (`submissionCreated: false`). `progress` is recomputed server-side for the parent from subtasks as `{ percent, completed, total }` using weighted approved progress: `percent = round((sum of weights of APPROVED subtasks / sum of weights of all subtasks) * 100)` (0% when none; only `APPROVED` counts as completed). Allowed for assigned member or authorized collaborator (collaborators only for subtasks assigned to them). | 401, 403 `PERMISSION_DENIED`, 404 `TASK_NOT_FOUND`/`SUBTASK_NOT_FOUND` | `task.complete` (on subtask context) |

### Task progress updates (BE-8)

| Method | Path | Request | Success response | Errors | Required permission |
| --- | --- | --- | --- | --- | --- |
| POST | `/{taskId}/progress-updates` | Body: `{ "note": string(1-2000 trimmed), "percent"?: number(0-100), "clientRequestId"?: string(<=64) }` | `201 { success, data: { update } }` where `update: { id, taskId, authorId, note, percent, clientRequestId, createdAt }`. Repeating the same `clientRequestId` by the same author on the same task returns the existing row with `200` instead of duplicating (idempotent no-op). Only a live task assignee may post, only while `task.status` is `IN_PROGRESS` or `CHANGES_REQUESTED`; archived or deleted tasks return 404. Audit-only (`task.progress_updated`): the self-reported `percent` never changes `computeProgress`, project progress, analytics, or task status. | 400 validation (`note` length, `percent` range), 403 `NOT_TASK_ASSIGNEE`, 404 `TASK_NOT_FOUND`, 409 `PROGRESS_UPDATE_NOT_ALLOWED` | `task.view` + live assignee |
| GET | `/{taskId}/progress-updates` | Query: `cursor?` (update id), `limit?` (1-100, default 25) | `200 { success, data: { items, nextCursor } }` newest-first, cursor-paginated. Each item: `{ id, taskId, authorId, note, percent, clientRequestId, createdAt }`. | 401, 403/404 access or not found | `task.view` |

### Task model additions (additive)

Tasks may include: `weight` (positive integer, default 1), `requiresApproval` (boolean, default false), `expectedDeliverables` (JSON array of `{id?,label,required?}` or null), `submissionSummary`, `submittedAt`, `submittedById`, `submittedBy`, `reviewFeedback`, `reviewedAt`, `reviewedById`, `reviewedBy`.

**Subtask weight & progress (Phase 4D, additive):**
- `weight` applies to **subtasks** (tasks with `parentTaskId`). It must be a positive integer (>=1); zero, negative, decimal, or invalid values are rejected. Default is 1.
- Only users with appropriate task-management permissions (task create/update) may set or modify subtask weights. Ordinary assignees do not automatically receive weight-management privileges. Weight changes are rejected for non-subtask (parent) tasks.
- Progress is **computed exclusively on the backend** from subtasks as `{ percent, completed, total }` where `completed`/`total` are subtask counts and `percent = round((sum of weights of APPROVED subtasks / sum of weights of all subtasks) * 100)`.
- A subtask contributes to completed progress **only when its status is `APPROVED`** (per existing submission/review workflow). `SUBMITTED`/`UNDER_REVIEW`/merely completed-not-approved states do not count as approved.
- When a task has **no subtasks**, progress is `0%` (`{ percent:0, completed:0, total:0 }`).
- When all subtasks have **equal weights**, progress produces exactly the same results as the existing Phase 3 count-based implementation.
- The frontend must display backend-calculated progress only (no separate client-side progress calculation).

**Migration (Phase 3, not applied to production by this change):** `20261115120000_task_workspace_approval_submission_flow` adds earlier additive task columns/relations. Apply only in a controlled environment after verification.

**Migration (Phase 4D, additive, local dev applied after verification; not applied to production):** `20261116180000_task_subtask_weight` adds `Task.weight INTEGER NOT NULL DEFAULT 1`. Production steps (ordered): 1) backup DB and verify migration state/order (including prior unapplied Phase 3/4A/4B/4C as applicable), 2) deploy code containing migration, 3) in a controlled maintenance window run `npx prisma migrate deploy` (or apply reviewed SQL in order) in staging then production after verification, 4) run `prisma generate` in build, restart, and smoke-test subtask weight create/update permissions/validation and weighted progress (approved-only, no-subtasks 0%, equal-weights parity). **Never `prisma migrate deploy` outside controlled rollout; never reset; never mutate applied migrations; never touch production outside this process.**

### Task work documents (Phase 4A)

All routes require an authenticated, active account and are mounted under
`/api/v1/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}/work-documents`.
Task/project access is enforced server-side (workspace membership + project/task
visibility; collaborators must be assigned to the task where task resource scope
requires it). Existing generic `Document`/`DocumentRevision` models and routes
are unchanged.

| Method | Path | Request | Success response | Errors | Required permission |
| --- | --- | --- | --- | --- | --- |
| GET | `/` | Path: `workspaceId`, `projectId`, `taskId` | `200 { success, data: { items: TaskDocumentSummary[] } }` (non-deleted docs, newest updated first). `TaskDocumentSummary`: `{ id, taskId, title, createdById, createdBy:{id,name}, currentVersion, createdAt, updatedAt }`. | 401, 403/404 access denied or task not found | `task.view` (on task) |
| POST | `/` | Body: `{ "title": string(1-200), "content"?: TipTapJSONDoc }` (content defaults to empty doc, sanitized) | `201 { success, data: { ...summary, content } }` (version 1 created). | 400 `VALIDATION_ERROR`/`DOCUMENT_TOO_LARGE`, 401, 403 `PERMISSION_DENIED`, 404 | `task.update` on task **or** task assignee |
| GET | `/{documentId}` | Path includes `documentId` | `200 { success, data: { ...summary, content } }` (current version content). | 401, 403/404, 404 `WORK_DOCUMENT_NOT_FOUND` | `task.view` |
| PATCH | `/{documentId}` | Body: `{ "baseVersion": number>=1, "content": TipTapJSONDoc, "title"?: string(1-200), "mode"?: "autosave"|"manual" (default manual) }` | `200 { success, data: { ...summary, content, throttled?: boolean } }`. On success with version advance, persists sanitized content and creates a new version; updates title if provided. If `mode="autosave"` and the same user saved the current version within 60s, content/title are coalesced into the latest version (no new version number, `throttled:true`) to enforce ≤1 version/min/user/document while never discarding content. | 400 `DOCUMENT_TOO_LARGE`/validation, 401, 403 `PERMISSION_DENIED`, 404 `WORK_DOCUMENT_NOT_FOUND`, 409 `WORK_DOCUMENT_CONFLICT` | `task.update` on task **or** task assignee |
| GET | `/{documentId}/versions` | Path includes `documentId` | `200 { success, data: { items: {id,version,savedById,savedBy:{id,name},createdAt}[], currentVersion } }` newest-first. | 401, 403/404, 404 `WORK_DOCUMENT_NOT_FOUND` | `task.view` |
| GET | `/{documentId}/versions/{version}` | Path includes `documentId`, `version>=1` | `200 { success, data: { id, version, savedBy:{id,name}, createdAt, content } }`. | 401, 403/404, 404 `WORK_DOCUMENT_NOT_FOUND`/`WORK_DOCUMENT_VERSION_NOT_FOUND` | `task.view` |
| POST | `/{documentId}/versions/{version}/restore` | Empty body `{}` | `200 { success, data: { ...summary, content } }` creates a new version with restored content (append-only history). | 401, 403 `PERMISSION_DENIED`, 404 `WORK_DOCUMENT_NOT_FOUND`/`WORK_DOCUMENT_VERSION_NOT_FOUND` | `task.update` on task **or** task assignee |
| DELETE | `/{documentId}` | — | `200 { success, data: { id, deleted: true } }` (soft delete). | 401, 403 `PERMISSION_DENIED`, 404 `WORK_DOCUMENT_NOT_FOUND` | `task.update` on task (permission-controlled; assignee-only without `task.update` cannot delete) |

**Conflict handling:** if `baseVersion !== currentVersion`, the server returns
`409 { success:false, error:{ code:"WORK_DOCUMENT_CONFLICT", message, details:{ currentVersion, latestContent, document } } }`
and never overwrites silently. Clients must let the user reload latest or copy
local content.

**Content/security:** server sanitizes TipTap/ProseMirror JSON to an allowlist of
nodes/marks (`doc, paragraph, text, heading, bulletList, orderedList, listItem,
table, tableRow, tableCell, tableHeader, hardBreak, blockquote, codeBlock,
horizontalRule` and `bold, italic, link, strike, code, underline`; links
restricted to `http(s):`/`mailto:`). Maximum serialized content size is 2 MB
(`DOCUMENT_TOO_LARGE`).

**Audit:** create/update/restore/delete emit `task.work_document.{created,updated,restored,deleted}`
audit events with task/project/document/version metadata.

**Migration (additive, local dev applied after verification per request; not applied to production):**
`20261116120000_task_work_documents` creates `TaskDocument` and
`TaskDocumentVersion` tables (+ indexes/foreign keys). Existing generic
`Document`/`DocumentRevision` tables are untouched. Production steps (ordered):
1) backup DB, 2) deploy code containing migration, 3) in a maintenance window run
`npx prisma migrate deploy` (or apply the reviewed SQL) in staging then
production after verification, 4) run `prisma generate` as part of build and
smoke-test task work-document endpoints and permissions. Do not use
`prisma migrate deploy` outside controlled rollout; never reset/mutate
previously applied migrations.

### Task blockers (Phase 4B)

All routes require an authenticated, active account and are mounted under
`/api/v1/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/blockers`.
These are **reported blockers/issues** (`TaskBlocker`, OPEN/RESOLVED) and are
additive to existing dependency blockers (`task.blockers` / `TaskDependency`
relations remain unchanged). Task summaries/workspace payloads now also include
additive `reportedBlockers` and `hasOpenBlocker`.

| Method | Path | Request | Success response | Errors | Required permission / rule |
| --- | --- | --- | --- | --- | --- |
| GET | `/` | — | `200 { success, data: { items: ReportedBlocker[], hasOpenBlocker: boolean } }` (newest first). `ReportedBlocker`: `{ id, taskId, status:"OPEN"\|"RESOLVED", description, reportedById, reportedBy:{id,name}, notifyUserId, notifyUser, resolvedAt, resolvedById, resolvedBy, createdAt, updatedAt }`. | 401, 403/404 access/task not found | `task.view` |
| POST | `/` | Body: `{ "description": string(1-2000), "notifyUserId"?: uuid\|null }` | `201 { success, data: <ReportedBlocker> }` (OPEN). Notifies task owner (task creator) and chosen `notifyUser` (if active workspace member, excluding reporter) with `TASK_BLOCKER_REPORTED`; records audit `task.blocker.reported`. | 400 validation, 401, 403 `PERMISSION_DENIED` (not an assigned member), 404 `TASK_NOT_FOUND`/`USER_NOT_FOUND` | **Assigned member only** (task assignee) with task view access |
| POST | `/:blockerId/resolve` | Empty body `{}` | `200 { success, data: <ReportedBlocker> }` (RESOLVED, `resolvedAt`/`resolvedById` set). Notifies reporter (if different from resolver) with `TASK_BLOCKER_RESOLVED`; records audit `task.blocker.resolved`. Idempotent if already resolved. | 401, 403 `PERMISSION_DENIED`, 404 `TASK_NOT_FOUND`/`TASK_BLOCKER_NOT_FOUND` | Reporter, task owner (task creator), or PM/admin with task management authority (`task.update`/manage or workspace admin) |

**Migration (additive, local dev applied after verification per request; not applied to production):**
`20261116140000_task_blockers` creates enum `TaskBlockerStatus`, adds
`NotificationType` values `TASK_BLOCKER_REPORTED`/`TASK_BLOCKER_RESOLVED`, and
creates `TaskBlocker` table (+ indexes/FKs). Production steps (ordered):
1) backup DB, 2) deploy code containing migration, 3) in a maintenance window run
`npx prisma migrate deploy` (or apply the reviewed SQL) in staging then
production after verification, 4) run `prisma generate` as part of build and
smoke-test blocker list/report/resolve, permissions, notifications, and workspace
blocked indicators. Never `prisma migrate deploy` outside controlled rollout.

### Task time tracking (Phase 4C)

Time tracking is gated by the workspace setting `timeTrackingEnabled` (default `false`).
All time-entry endpoints are **rejected when time tracking is off** with
`409 { code: "TIME_TRACKING_DISABLED" }`. `Workspace` responses now include
additive `timeTrackingEnabled: boolean`; it can be toggled via the existing
workspace update endpoint `PATCH /api/v1/workspaces/:workspaceId` with body
`{ "timeTrackingEnabled": true|false }` (requires workspace update permission).

Routes are mounted under
`/api/v1/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/time-entries`
and require an authenticated, active account.

| Method | Path | Request | Success response | Errors | Required permission / rule |
| --- | --- | --- | --- | --- | --- |
| GET | `/` | — | `200 { success, data: { items: TimeEntry[], totalMinutes: number } }` (newest first). `TimeEntry`: `{ id, taskId, userId, user:{id,name}, startedAt, durationMinutes, note, createdAt, updatedAt }`. | 401, 403/404 access/task not found, 409 `TIME_TRACKING_DISABLED` | `task.view` (and time tracking enabled) |
| POST | `/` | Body: `{ "startedAt": ISO datetime, "durationMinutes": int(1..1440), "note"?: string\|null(max 2000) }` | `201 { success, data: <TimeEntry> }` (logged for current user). Audit `task.time_entry.logged`. | 400 validation, 401, 403 `PERMISSION_DENIED`, 404 `TASK_NOT_FOUND`, 409 `TIME_TRACKING_DISABLED` | Task assignee **or** user with task update/manage permission (logs own time); time tracking enabled |
| PATCH | `/:entryId` | Body: `{ "startedAt"?, "durationMinutes"?, "note"? }` (at least one field) | `200 { success, data: <TimeEntry> }`. Audit `task.time_entry.updated`. | 400 validation, 401, 403 `PERMISSION_DENIED` (not owner), 404 `TIME_ENTRY_NOT_FOUND`/`TASK_NOT_FOUND`, 409 `TIME_TRACKING_DISABLED` | **Edit own only**; time tracking enabled |
| DELETE | `/:entryId` | — | `200 { success, data: { id, deleted: true } }`. Audit `task.time_entry.deleted`. | 401, 403 `PERMISSION_DENIED` (not owner), 404 `TIME_ENTRY_NOT_FOUND`/`TASK_NOT_FOUND`, 409 `TIME_TRACKING_DISABLED` | **Delete own only**; time tracking enabled |

**Migration (additive, local dev applied after verification per request; not applied to production):**
`20261116160000_task_time_tracking` adds `Workspace.timeTrackingEnabled` (boolean,
default `false`) and creates `TaskTimeEntry` table (+ indexes/FKs). Production
steps (ordered): 1) backup DB, 2) deploy code containing migration, 3) in a
maintenance window run `npx prisma migrate deploy` (or apply the reviewed SQL)
in staging then production after verification, 4) run `prisma generate` as part
of build and smoke-test workspace toggle, time-entry log/list/edit/delete-own,
and rejection when disabled. Never `prisma migrate deploy` outside controlled
rollout.

### Task deadline notifications (Phase 4E)

A background polling worker (`task-deadline-notification`, in-process, same
`start/stop/runOnce(now)` pattern as other workers) notifies **current task
assignees** about approaching and overdue deadlines using existing in-app
notification creation and notification preferences.

**Notification types (additive):** `TASK_DUE_SOON`, `TASK_OVERDUE`.

**Eligibility:** task must have `dueDate != null`, not be deleted or archived,
have at least one assignee, and be actionable (`status != APPROVED` and
`completedAt == null`). Submitted tasks awaiting review are not approved and may
be eligible per existing workflow/status. Only current assignees are notified
and existing in-app notification preferences are respected.

**Rules:**
- **Due soon (`TASK_DUE_SOON`)**: sent once per task when `now >= dueDate - 24h`
  and `now < dueDate`.
- **Overdue (`TASK_OVERDUE`)**: sent once per task when `now >= dueDate`.
- A task may receive at most one due-soon and one overdue notification total
  (tracked by additive task markers `dueSoonNotifiedAt`, `overdueNotifiedAt`);
  never repeated across runs/restarts/concurrent executions. If a due date
  changes after a notification type was sent, that same type is not resent.

**Idempotency/concurrency:** each threshold is claimed atomically in a database
transaction (conditional update on marker/eligibility) and notifications are
created within the same transaction, so concurrent workers cannot duplicate and
a crash cannot persist a sent marker without committed notifications.

**Configuration:** `TASK_DEADLINE_NOTIFICATION_POLL_INTERVAL_MS` (default
`300000` ms). Worker is registered with health monitoring and stopped cleanly
on shutdown.

**Migration (additive, local dev applied after verification; not applied to production):**
`20261116200000_task_deadline_notifications` adds `NotificationType` values
`TASK_DUE_SOON`, `TASK_OVERDUE` and `Task.dueSoonNotifiedAt` /
`Task.overdueNotifiedAt` (nullable). Production steps (ordered): 1) backup DB
and verify migration state/order and unapplied migrations, 2) deploy code
containing migration, 3) in a controlled maintenance window run
`npx prisma migrate deploy` (or apply reviewed SQL in order) in staging then
production after verification, 4) run `prisma generate`, restart services, and
smoke-test deadline notifications, preferences, and worker health. **Never
`prisma migrate deploy` outside controlled rollout; never reset/drop/recreate
DB; never mutate applied migrations; never touch production outside this
process.**

## Dev/source-control integrations (Phase 5, workspace source control)

Workspace-level source control connections behind a provider abstraction (`IntegrationConnection.provider`: `GITHUB` GitHub App, `GITLAB` GitLab OAuth). Nexus links to providers and shows repository/project development status; it does **not** host, edit, or store source code. Linked repositories are associated with projects and tasks.

**Connection model (additive):** `IntegrationConnection` (workspace-scoped, provider `GITHUB|GITLAB`, status `PENDING|ACTIVE|DISCONNECTED|ERROR`, external account metadata, encrypted credentials at rest, `createdById`) with unique `(workspaceId, provider)`. `ProjectRepository` links a project to a connection/repo. `TaskDevLink` links tasks to branches/pull/merge requests/commits. `GitHubWebhookDelivery`/`GitLabWebhookDelivery` provide inbound webhook idempotency.

**Security:** OAuth/install authorization uses signed, Redis-backed one-time state bound to the authenticated user and workspace (validated/consumed on callback). Credentials/tokens are encrypted at rest using `INTEGRATION_ENCRYPTION_KEY` (AES-256-GCM); no tokens/secrets/private keys are returned in API responses or logged. Outbound provider API calls use timeouts and graceful error handling. Rotated GitLab OAuth access tokens are persisted (encrypted) when refreshed. Disconnect removes/revokes stored credentials best-effort and marks the connection disconnected. Inbound webhooks verify authenticity (GitHub HMAC-SHA256 `X-Hub-Signature-256`, GitLab secret token `X-Gitlab-Token`) with constant-time comparison and are idempotent by provider delivery id. Backend authorization is authoritative.

### Workspace dev-integration routes

Mounted at `/api/v1/workspaces/:workspaceId/dev-integrations` (authenticated, active account).

| Method | Path | Request | Success response | Errors | Required permission |
| --- | --- | --- | --- | --- | --- |
| GET | `/connections` | — | `200 { success, data: DevConnectionSummary[] }` (no secrets) | 401, 403 workspace access/suspended | Active workspace membership (`workspace:view`) |
| GET | `/github/start` | — | `200 { success, data: { url } }` (GitHub App install/authorization URL) | 401, 403 insufficient role, 503 not configured | Workspace manager (`workspace:update`, e.g. OWNER/PROJECT_MANAGER) |
| GET | `/gitlab/start` | — | `200 { success, data: { url } }` (GitLab OAuth authorization URL) | 401, 403 insufficient role, 503 not configured | Workspace manager (`workspace:update`) |
| DELETE | `/connections/:connectionId` | — | `200 { success, data: { ok: true, providerRevoked?: boolean } }` (stored credentials removed/revoked best-effort) | 401, 403, 404 not found | Workspace manager (`workspace:update`) |
| GET | `/connections/:connectionId/repos` | — | `200 { success, data: DevRepositorySummary[] }` (repos/projects available to the connection) | 401, 403, 404, 409 not active, 502 provider unavailable | Active workspace membership (`workspace:view`) |

**`DevConnectionSummary`**: `{ id, provider, workspaceId, status, externalAccount:{id,login,name}, scopes, createdById, lastError, createdAt, updatedAt }`.

**`DevRepositorySummary`**: `{ externalRepoId, fullName, name?, ownerLogin?, defaultBranch, private?, htmlUrl? }` (GitLab `fullName` is project path with namespace).

### OAuth/install callbacks

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/v1/dev-integrations/github/callback` (and optional alias mounted at `GITHUB_APP_CALLBACK_URL` pathname) | Public browser redirect endpoint. Validates/consumes signed one-time state (user/workspace bound), requires a GitHub App `installation_id`, fetches installation/account metadata, stores/updates encrypted workspace connection as `ACTIVE`, records audit, then redirects to frontend integrations page with `?devIntegration=github&status=connected\|denied\|error`. |
| GET | `/api/v1/dev-integrations/gitlab/callback` (and optional alias mounted at `GITLAB_CALLBACK_URL` pathname) | Public browser redirect endpoint. Validates/consumes signed one-time state (user/workspace bound), exchanges authorization code for OAuth tokens, fetches GitLab user, stores/updates encrypted workspace connection as `ACTIVE`, records audit, then redirects to frontend integrations page with `?devIntegration=gitlab&status=connected\|denied\|error`. |

### Project repository routes

Mounted at `/api/v1/workspaces/:workspaceId/projects/:projectId/repositories` (authenticated, active account).

| Method | Path | Request | Success response | Errors | Required permission |
| --- | --- | --- | --- | --- | --- |
| GET | `/` | — | `200 { success, data: LinkedProjectRepository[] }` | 401, 403/404 project access | Project view (`project.view` / task.view-equivalent project visibility) |
| POST | `/` | Body `{ "connectionId": uuid, "externalRepoId": string, "fullName": string, "defaultBranch"?: string\|null }` | `201 { success, data: LinkedProjectRepository }` | 400 validation, 401, 403, 404 connection/project not found, 409 already linked | Project management/update (`project.update`) |
| DELETE | `/:repositoryId` | — | `200 { success, data: { ok: true } }` | 401, 403, 404 not found | Project management/update (`project.update`) |

**`LinkedProjectRepository`**: `{ id, projectId, connectionId, provider, externalRepoId, fullName, defaultBranch, createdAt, updatedAt }`.

### Environment variables

**GitHub App (Features A–C)**
- `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` (server-side only)
- `GITHUB_APP_CALLBACK_URL`, `GITHUB_APP_INSTALL_URL` (optional override)
- `GITHUB_APP_WEBHOOK_SECRET` — inbound webhook signature secret

**GitLab OAuth (Feature D)**
- `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` (server-side only)
- `GITLAB_CALLBACK_URL` — backend OAuth callback/redirect URI
- `GITLAB_BASE_URL` — instance base URL (default `https://gitlab.com`)
- `GITLAB_SCOPES` — OAuth scopes (default `read_api read_repository`, minimum read)
- `GITLAB_WEBHOOK_SECRET` — inbound webhook secret token

Requires existing `INTEGRATION_ENCRYPTION_KEY` (base64url, 32 bytes) for credential encryption at rest.

### Provider setup (manual)

**GitHub App:** create app with minimum read permissions (contents/metadata, pull requests, checks/statuses as needed), set callback and webhook URLs/secrets, install on target account/org, connect workspace and link repositories to projects.

**GitLab OAuth application:** create application with minimum read scopes (`read_api`, `read_repository`), set redirect URI to `GITLAB_CALLBACK_URL` (e.g. `https://<backend>/api/v1/dev-integrations/gitlab/callback`). For inbound MR sync, configure project/group/system webhook to `https://<backend>/api/v1/webhooks/gitlab` with `GITLAB_WEBHOOK_SECRET` as secret token and subscribe to merge request events. Connect workspace and link projects.

**Migrations (additive, local dev applied after verification; not applied to production):**
- `20261117120000_phase5_dev_integration_connections` — dev integration connections and project repositories
- `20261117130000_phase5b_task_dev_links` — task dev links
- `20261117140000_phase5c_github_webhook_deliveries` — GitHub webhook idempotency
- `20261117150000_phase5d_gitlab_webhook_deliveries` — GitLab webhook idempotency

Production steps (ordered): backup DB and verify migration state, deploy backend, apply migrations in controlled window/staging then production (`prisma migrate deploy` only in controlled rollout), `prisma generate`, set provider env vars, configure provider apps/webhooks, restart/verify. Never `prisma migrate deploy` outside controlled rollout.

### Feature B — Task development links (branches/PRs, no webhooks)

Builds on Feature A linked project repositories. On-demand GitHub reads (mocked in tests, timeouts, no secrets exposed) and persisted task-to-dev-resource links for display in task workspace.

**Repository dev-resource browsing (project-scoped)**
| Method | Path | Request | Success (data) | Errors | Required permission |
| --- | --- | --- | --- | --- | --- |
| GET | `/workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId/branches` | Query `search?`, `page?`, `perPage?` | `200 { success, data: { items: DevBranchSummary[] } }` | 401, 403/404, 409 no active connection, 502 provider unavailable | `project.view` (project access) |
| GET | `/workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId/pull-requests` | Query `state?` (`open|closed|all`), `search?`, `page?`, `perPage?` | `200 { success, data: { items: DevPullRequestSummary[] } }` | 401, 403/404, 409, 502 | `project.view` |

**`DevBranchSummary`:** `{ name, commitSha?, protected?, url? }`  
**`DevPullRequestSummary`:** `{ externalId, number, title, state, url, headRef, baseRef, authorLogin?, updatedAt? }`

**Task dev links**
| Method | Path | Request | Success (data) | Errors | Required permission |
| --- | --- | --- | --- | --- | --- |
| GET | `/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links` | — | `200 { success, data: TaskDevLink[] }` | 401, 403/404 | Project/task view (`project.view`) |
| POST | `/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links` | Body `{ projectRepositoryId, externalType: "BRANCH"|"PULL_REQUEST"|"COMMIT", externalId, externalNumber?, title?, url?, ref?, headRef?, baseRef?, state? }` | `201 { success, data: TaskDevLink }` | 400, 401, 403, 404 task/repo not found, 409 duplicate (`TASK_DEV_LINK_ALREADY_EXISTS`) | Task update (`project.task.update`) |
| DELETE | `/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links/:devLinkId` | — | `200 { success, data: { ok: true } }` | 401, 403, 404 | Task update (`project.task.update`) |

**`TaskDevLink`:** `{ id, taskId, projectId, projectRepositoryId, provider, externalType, externalId, externalNumber, title, url, ref, headRef, baseRef, state, repositoryFullName, linkedById, createdAt, updatedAt }` (no secrets).

**Migration (additive, local dev applied after verification; not applied to production):** `20261117130000_phase5b_task_dev_links` adds `DevLinkType` and `TaskDevLink` with relations/indexes/constraints (FKs to Task/Project/ProjectRepository/User). Production steps (ordered): backup DB and verify migration state, deploy backend, apply migration in controlled window (`prisma migrate deploy` only in controlled rollout, staging then production), `prisma generate`, restart/verify.

### Feature C — GitHub App inbound webhooks (idempotent state sync)

Raw-body endpoint (mounted before JSON parsing) for GitHub App webhooks. Verifies authenticity, deduplicates deliveries, and syncs linked development state. **No inbound auto-linking**; GitHub only.

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| POST | `/api/v1/webhooks/github` | Webhook signature (public endpoint, not session-authenticated) | Verifies `X-Hub-Signature-256` (HMAC-SHA256 over raw body) against `GITHUB_APP_WEBHOOK_SECRET` (constant-time). Requires `X-GitHub-Delivery` and `X-GitHub-Event`. Returns 401 if unverified, 400 if invalid/missing payload/headers, 503 if not configured, else 200 `{ success, data: { received: true, outcome } }` (`processed|duplicate|ignored`). |

**Idempotency:** each `(provider, deliveryId)` processed once (`GitHubWebhookDelivery` unique key); retries/duplicates acknowledged without reapplying side effects.

**Handled events (current):**
- `pull_request`: updates existing linked `TaskDevLink` records (`provider=GITHUB`, `externalType=PULL_REQUEST`, matching PR id) with `title`, `externalNumber`, `url`, `headRef`/`ref`, `baseRef`, `state` (`open|closed|merged|draft`). No-op if none linked.
- `installation` (`deleted`/`suspend`): best-effort marks matching active GITHUB `IntegrationConnection`(s) for the installation as `DISCONNECTED`, revokes stored credentials marker, records reason. Other installation actions acknowledged/ignored.
- Other events: acknowledged idempotently (`ignored`) for forward compatibility.

**Env/config:** `GITHUB_APP_WEBHOOK_SECRET` required for webhook verification; configure GitHub App webhook URL to `https://<backend>/api/v1/webhooks/github` and subscribe to at least `pull_request` and `installation` (minimum permissions/events).

**Migration (additive, local dev applied after verification; not applied to production):** `20261117140000_phase5c_github_webhook_deliveries` adds `GitHubWebhookDelivery` idempotency table (unique provider+deliveryId, indexes). Production steps (ordered): backup DB and verify migration state, deploy backend, apply migration in controlled window (`prisma migrate deploy` only in controlled rollout, staging then production), `prisma generate`, configure GitHub App webhook/secret, restart/verify delivery signatures and idempotency.

### Feature D — GitLab inbound webhooks (idempotent MR state sync)

Raw-body endpoint (mounted before JSON parsing) for GitLab webhooks. Verifies authenticity, deduplicates deliveries, and syncs linked development state. **No inbound auto-linking**.

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| POST | `/api/v1/webhooks/gitlab` | Webhook secret token (public endpoint, not session-authenticated) | Verifies `X-Gitlab-Token` against `GITLAB_WEBHOOK_SECRET` (constant-time). Uses `X-Gitlab-Event-UUID`/`X-Gitlab-Webhook-UUID` when present as delivery id (falls back to deterministic payload key). Returns 401 if unverified, 400 if invalid/missing payload, 503 if not configured, else 200 `{ success, data: { received: true, outcome } }` (`processed|duplicate|ignored`). |

**Idempotency:** each `(provider, deliveryId)` processed once (`GitLabWebhookDelivery` unique key); retries/duplicates acknowledged without reapplying side effects.

**Handled events (current):**
- `merge_request`: updates existing linked `TaskDevLink` records (`provider=GITLAB`, `externalType=PULL_REQUEST`, matching MR id) with `title`, `externalNumber` (iid), `url`, `headRef`/`ref`, `baseRef`, and mapped `state` (`open|closed|merged|draft`). No-op if none linked.
- Other events: acknowledged idempotently (`ignored`).

**Env/config:** `GITLAB_WEBHOOK_SECRET` required; configure webhook URL to `https://<backend>/api/v1/webhooks/gitlab` with the same secret token and subscribe to merge request events (minimum scope/events).

## BE-5 in-app notification fan-out (current contract)

BE-5 adds in-app `Notification` rows for review, checklist, attachment-version
and (when BE-6 is present) GitHub pull-request events. It adds **no HTTP
routes**: existing review, checklist and file endpoints keep their contracts,
and the notification list/preference routes accept the new types automatically.

**New `NotificationType` values:** `REVIEW_SUBMITTED`, `REVIEW_ASSIGNED`,
`REVIEW_STARTED`, `REVIEW_APPROVED`, `REVIEW_REJECTED`,
`REVIEW_CHANGES_REQUESTED`, `REVIEW_RESUBMITTED`, `CHECKLIST_SIGNED_OFF`,
`ATTACHMENT_VERSION_ADDED`, `GITHUB_PR_MERGED`, `GITHUB_PR_REVIEW_RECEIVED`.
`TASK_APPROVED` and `CHANGES_REQUESTED` remain dormant and are not used by this
feature. Clarification has its own future types and audit events.

| Trigger (server-side audit action) | Notification type | Default recipients |
| --- | --- | --- |
| `review.created` | `REVIEW_SUBMITTED` | Active project members who can `submission.review` or `submission.approve` |
| `review.assigned` | `REVIEW_ASSIGNED` | The stored assignee, if they are an eligible reviewer |
| `review.started` | `REVIEW_STARTED` | The stored submitter |
| `review.approved` / `rejected` / `changes_requested` | `REVIEW_APPROVED` / `REVIEW_REJECTED` / `REVIEW_CHANGES_REQUESTED` | The stored submitter |
| `review.resubmitted` | `REVIEW_RESUBMITTED` | Active project members who can `submission.review` or `submission.approve` |
| `checklist_item.signed_off` | `CHECKLIST_SIGNED_OFF` | Active project members |
| `file.version.created` | `ATTACHMENT_VERSION_ADDED` | Active project members (project-scoped files only) |
| GitHub PR merged / review received | `GITHUB_PR_MERGED` / `GITHUB_PR_REVIEW_RECEIVED` | Task creator plus task assignees (BE-6) |

**Recipient rules.** Candidates are read from `WorkspaceMembership`: status
`ACTIVE`, linked user not soft-deleted and status `ACTIVE`, and effective access
to the project resolved by the central project authorization module. The actor
is always excluded; recipients are capped at 25. No user id from a request body
or webhook payload is used as a recipient. Every row includes `workspaceId`,
`projectId`, the target identifiers and a `dedupeKey` in `data`, so the in-app
preference check is always applied.

**Transactions and dedupe.** Review, checklist and attachment-version rows are
written with `createMany({ skipDuplicates: true })` inside the same transaction
as the audited change; a notification failure rolls the change back. The
migration `20261121100000_be5_notifications` adds the enum values and a partial
unique index on `("userId", (data->>'dedupeKey'))` where the key is present.
Repeated delivery of the same key therefore produces one row without catching
unique-constraint errors. GitHub notifications are best-effort, written after
the webhook commit, and never fail the webhook; their key is
`github:<deliveryId>:<linkId>:<action>`.

**Channels.** In-app only. BE-5 adds no email templates and no Slack kinds.
Message unread counts remain independent from general notifications.

**Schema drift fix.** Both notification list and preference `type` validators
now use `z.nativeEnum(NotificationType)`, so `SECURITY_ALERT` is accepted rather
than returning 400. Dormant review-like types remain unaffected.

## Updating this API reference

After each backend phase that adds, changes, or removes an externally visible
route or response contract, update this route index and `openapi.yaml` in the
same phase change. Verify both against the registered Express routers and
schemas. Do not document planned behavior as live API functionality. If a
phase changes no HTTP contract, record that no API update was required in the
phase completion notes.

## Email verification and password reset codes (current contract)

All paths below are prefixed by `/api/v1`. Codes are six digits, expire after 10 minutes, and are limited to five guesses. Each user may have only one active code per purpose; issuing another replaces the previous code. Requests are limited per IP and per normalized email, and sending has a 60-second per-user cooldown.

- `POST /auth/email/verify` — `{ "email": "user@example.com", "code": "012345" }` → `{ "success": true, "data": { "user": { ... } } }`. Verification activates the account and does not sign the user in, matching the existing behavior.
- `POST /auth/email/resend` — `{ "email": "user@example.com" }` → generic `{ "success": true, "data": { "message": "If the address can be used, a message with the next step has been sent." } }`, whether or not the account exists.
- `POST /auth/password/forgot` — `{ "email": "user@example.com" }` → the same generic response for known and unknown addresses.
- `POST /auth/password/reset` — `{ "email": "user@example.com", "code": "012345", "newPassword": "..." }` → `{ "success": true, "data": { "message": "Your password has been reset. Please sign in again." } }`. All existing sessions and refresh tokens are revoked.

Invalid/expired codes return HTTP 400 with `INVALID_OR_EXPIRED_CODE`; the fifth incorrect guess returns HTTP 400 with `TOO_MANY_ATTEMPTS`. Legacy `POST /auth/verify-email`, `POST /auth/resend-verification`, and token-shaped password-reset requests return HTTP 410 `LINK_TOKEN_DEPRECATED`. Existing link-based pending accounts can use `/auth/email/resend` to receive a code.

`OTP_HMAC_SECRET` is required in production and must be a stable random secret of at least 32 characters. Code hashes are HMAC-SHA256; code-bearing email bodies are encrypted in the transactional outbox and decrypted only for delivery. These code endpoints do not set authentication cookies.
