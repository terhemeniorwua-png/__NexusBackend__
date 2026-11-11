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
| Files | `/workspaces/{workspaceId}/files` | List/upload files, obtain authorized download access, and delete files. Storage configuration is required for uploads. |
| Documents | `/workspaces/{workspaceId}/documents` | Create/list/get/update/delete documents; read revisions and comments; add or remove comments. Project-bound documents inherit project visibility. |
| Calendar | `/workspaces/{workspaceId}/events` | Create/list/get/update/cancel/delete events; manage invitations and responses. |
| Meetings | `/workspaces/{workspaceId}/meetings` | Create/list/get/update/delete meetings; join/leave and manage participants. This API stores meeting state but does not provide a calling SDK. |
| Forms | `/workspaces/{workspaceId}/forms` | Create/list/get/update/delete forms; manage fields and submit/list responses. All current routes require an authenticated active account. |
| Search | `/search` | Unified search across people, workspaces, teams, departments, projects, tasks, messages, conversations, files, documents, meetings, and channels. Supports category, workspace, page/limit, and relevance/recent filters, suggestions, and per-user recent-search history. Every result is permission-filtered. |
| Integrations | `/integrations` | List/manage personal and workspace integrations, OAuth connections, enable/disable, token refresh, provider revocation on disconnect, and durable sync jobs. Live connections require provider credentials and callback configuration. |
| Outbound webhooks | `/workspaces/{workspaceId}/webhooks` | Manage workspace webhook subscriptions and inspect/retry durable HMAC-signed deliveries. |
| Automations | `/workspaces/{workspaceId}/automations` | Create/list/get/update/delete automation definitions; read execution history; retry a failed run. Event triggers (task created, task completed, member joined) and daily/weekly schedules are executed by the background automation worker with conditions, bounded retries, idempotency, and workspace-scoped permissions. |
| AI | `/ai` | Conversations and streamed answers, workspace-aware authorised context, usage limits, writing analysis/rewrite, and approval-gated AI actions. Requires `AI_ENABLED` plus service URL/token; degrades with a clear 503 when unconfigured. |
| Audit | `/workspaces/{workspaceId}/audit` | Read workspace audit events subject to authorization. |

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

## Projects and project visibility (Phase 8 — in progress)

Project records are workspace-scoped. `WORKSPACE` projects are visible to
active workspace members. `DEPARTMENT_TEAM` projects inherit access from their
active department membership, or from active team membership when assigned to
a team; a team association narrows access over department membership. `PRIVATE`
projects require explicit project membership or ownership, even when a team or
department is associated with them. Organization roles
do not independently grant private-project access. Project-level `VIEWER`
members can read but cannot mutate; `MEMBER` can perform project contribution
actions; `PROJECT_MANAGER` can manage project metadata and members, subject to
the workspace-role ceiling. Project managers/owners are assigned by the server.
All project and milestone reads use the same authorization policy. Cross-
workspace and inaccessible restricted project IDs are returned as 404.

`DEPARTMENT_TEAM` creation/update requires an active same-workspace team or
department. Projects expose `category`, `labels`, dates, status, visibility,
owner, member/task counts, and the caller's explicit project role. Listing is
cursor-paginated (`cursor` is the last project ID, `limit` defaults to 25 and
is capped at 100) and applies visibility in the database query. Archived
projects are excluded by default and may be requested with
`includeArchived=true`. Project deletion is a soft deletion; restore applies
to archived projects.

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/workspaces/{workspaceId}/projects` | Active workspace member | Cursor-paginated visible projects; supports `status`, `visibility`, `teamId`, `departmentId`, `search`, and `includeArchived`. |
| POST | `/workspaces/{workspaceId}/projects` | Workspace role with project creation capability | Create project; body includes `name`, `key`, optional `description`, `category`, `labels`, `visibility`, `teamId`, `departmentId`, `startDate`, `dueDate`. Owner and initial PROJECT_MANAGER membership are server-assigned. |
| GET | `/workspaces/{workspaceId}/projects/{projectId}` | Project reader | Read an authorized project. |
| PATCH | `/workspaces/{workspaceId}/projects/{projectId}` | Project manager | Update metadata, scope, visibility, category/labels, lifecycle status (excluding ARCHIVED), and dates. |
| POST | `/workspaces/{workspaceId}/projects/{projectId}/transfer-ownership` | Current project owner or workspace OWNER/PROJECT_MANAGER (including organization owner/admin) | Immediately transfer ownership. Body: `{newOwnerId, previousOwnerRole?}` where prior role is `MANAGER` (default), `MEMBER`, or `REMOVE`. No notification is sent. |
| DELETE | `/workspaces/{workspaceId}/projects/{projectId}` | Authorized project manager/owner | Soft-delete project. |
| POST | `/workspaces/{workspaceId}/projects/{projectId}/archive` | Project manager | Archive project. |
| POST | `/workspaces/{workspaceId}/projects/{projectId}/restore` | Project manager | Restore archived project to its prior status (or PLANNING if no archive record exists). |
| GET | `/workspaces/{workspaceId}/projects/{projectId}/members` | Project member manager | List project members. |
| POST | `/workspaces/{workspaceId}/projects/{projectId}/members` | Project member manager | Add/update member role (`PROJECT_MANAGER`, `MEMBER`, `VIEWER`) for an active workspace member. |
| PATCH | `/workspaces/{workspaceId}/projects/{projectId}/members/{userId}` | Project member manager | Change project role. |
| DELETE | `/workspaces/{workspaceId}/projects/{projectId}/members/{userId}` | Project member manager | Remove project membership (owner cannot be removed). |
| GET | `/workspaces/{workspaceId}/projects/{projectId}/activity` | Project reader | Read cursor-paginated project audit activity. |
| GET/POST | `/workspaces/{workspaceId}/projects/{projectId}/milestones` | Project reader / project manager | List milestones or create one (`name`, optional `description`, `dueDate`, `position`). |
| PATCH/DELETE | `/workspaces/{workspaceId}/projects/{projectId}/milestones/{milestoneId}` | Project manager | Update or delete a milestone. Completion is represented by `completedAt`; update accepts `completed: boolean`. |

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
