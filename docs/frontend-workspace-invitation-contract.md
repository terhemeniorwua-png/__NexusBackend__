# Frontend integration contract — workspace invitations

This document is the explicit contract for the frontend implementation of the
Nexus workspace invitation flow. It describes the backend that exists today.
The frontend is maintained in a separate repository.

All paths below are prefixed by `/api/v1`. The backend does not render pages and
does not perform browser redirects for invitations.

## 1. End-to-end flow

1. An administrator creates an invitation for an email address.
2. The backend stores a SHA-256 digest of a single-use token and emails a link:
   `${FRONTEND_URL}${WORKSPACE_INVITATION_LINK_PATH}?token=<raw-token>`.
3. The recipient opens the link. The frontend reads `token` from the query
   string and calls the public preview endpoint.
4. The public preview validates the link and shows the invited workspace,
   inviter, role and expiry. It never accepts the invitation.
5. If the visitor is not signed in, the frontend sends them to sign in or
   register, preserving the invitation URL as the return destination.
6. If the visitor is signed in, the frontend calls the authenticated
   verification endpoint. That response says whether this account is the
   intended recipient and whether it may accept or decline.
7. The user explicitly chooses Accept or Decline. The frontend never sends an
   acceptance request on page load.
8. On success the frontend routes the user to the workspace, or shows the
   declined state.

## 2. Endpoints

| Method | Path | Authentication | Purpose |
| ------ | ---- | -------------- | ------- |
| `GET` | `/invitations/{token}` | Public, rate limited | Validate and preview the invitation link. Never changes the invitation. |
| `GET` | `/invitations/{token}/verify` | Bearer access token, active account, rate limited | Verify the invitation for the signed-in account. Never changes the invitation. |
| `POST` | `/invitations/{token}/accept` | Bearer access token, active account | Accept the invitation and create workspace membership atomically. |
| `POST` | `/invitations/{token}/decline` | Bearer access token, active account | Decline the invitation without creating membership. |
| `GET` | `/invitations` | Bearer access token, active account | List invitations addressed to the caller (invitation inbox). |
| `GET` | `/workspaces/{workspaceId}/invitations?status=PENDING` | Workspace member with invitation permission | List workspace invitations for administrators. |
| `POST` | `/workspaces/{workspaceId}/invitations` | Workspace member with invitation permission, rate limited | Create an invitation. |
| `POST` | `/workspaces/{workspaceId}/invitations/{invitationId}/resend` | Workspace member with invitation permission, rate limited | Reissue the token and extend the deadline. |
| `DELETE` | `/workspaces/{workspaceId}/invitations/{invitationId}` | Workspace member with invitation permission | Revoke an invitation. |

The invitation endpoints accept no request body. Send no `Content-Type` body
for `GET`, `accept` or `decline`.

## Team invitations

Team invitations are distinct from workspace invitations. A team manager can
invite only an already active member of that workspace; accepting adds explicit
team membership and never creates or changes workspace membership.

| Method | Path | Authentication | Purpose |
| ------ | ---- | -------------- | ------- |
| `GET` | `/workspaces/{workspaceId}/teams/{teamId}/invitations?status=PENDING` | Team manager | List invitations for this team. |
| `POST` | `/workspaces/{workspaceId}/teams/{teamId}/invitations` | Team manager, rate limited | Create an invitation with `{ targetUserId }`. |
| `DELETE` | `/workspaces/{workspaceId}/teams/{teamId}/invitations/{invitationId}` | Team manager | Revoke an unaccepted invitation. |

Team invitees use the same token preview, verification, accept and decline
endpoints above. A team preview includes `team: { id, name }`. Verification
reports `alreadyMember` for workspace membership, `alreadyTeamMember` for team
membership, and permits acceptance only for the intended account while both
memberships and the team remain eligible. Acceptance creates only the team
membership and consumes the invitation in one transaction.

The team email link uses `EMAIL_APP_URL` and `TEAM_INVITATION_LINK_PATH` (default
`/teams/invitations/accept`). Workspace invitation management lists, resends
and revokes only `WORKSPACE` invitation records; team invitation management is
scoped to the team manager.

### Authentication

Protected endpoints use the normal Nexus bearer access token:

```http
Authorization: Bearer <access-token>
```

The account must be active. `PENDING_VERIFICATION` accounts receive
`403 EMAIL_NOT_VERIFIED`. Suspended, deactivated and pending-deletion accounts
are rejected by the authentication middleware before the invitation service
runs.

The public preview endpoint needs no authentication. The verification endpoint
is the correct place to combine a public link with a signed-in session; do not
infer recipient eligibility from the public preview.

## 3. Invitation token handling

- The raw token is a URL-safe opaque string generated by the backend.
- The backend stores only its SHA-256 digest. It cannot recover a lost token.
- Treat the token as a secret:
  - Read it from the `token` query parameter of the invitation link.
  - Keep it in memory for the current flow only.
  - Never write it to application logs, analytics, error reporting, local
    storage, session storage, cookies or URLs other than the invitation route.
  - Never send it in a request body; it belongs in the path segment.
  - URL-encode it if the HTTP client does not do so automatically.
- A resend replaces the token. The previous link stops working and returns
  `404 INVITATION_NOT_FOUND`.
- A revoked, expired or accepted invitation cannot be reused.
- Do not cache preview or verification responses that contain invitation data.

## 4. Invitation statuses

| Status | Meaning | Actionable |
| ------ | ------- | ---------- |
| `PENDING` | The invitation is live. | Yes, if the viewer is the intended recipient, the workspace is active and the viewer is not already a member. |
| `ACCEPTED` | The invitation was accepted and membership was created (or the account already belonged to the workspace). | No. |
| `DECLINED` | The intended recipient declined it. | No. A new invitation may be created for the address. |
| `REVOKED` | An administrator revoked it, the workspace was archived, or the account was deleted. | No. |
| `EXPIRED` | The deadline passed. The backend also stores this status when it observes the deadline. | No. |

Only `PENDING` can be accepted or declined.

## 5. Public link validation

### `GET /invitations/{token}`

Purpose: validate the link and show the invitation before authentication.
This endpoint never accepts the invitation and never creates membership.

#### Success — `200 OK`

```json
{
  "success": true,
  "data": {
    "workspace": {
      "id": "6a3f2f7e-2f9a-4b5f-9f0a-2f7e6a3f2f7e",
      "name": "Acme Rockets",
      "slug": "acme-rockets"
    },
    "invitedBy": {
      "id": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
      "name": "Jane Doe"
    },
    "role": "MEMBER",
    "organizationRole": null,
    "status": "PENDING",
    "expiresAt": "2026-11-10T12:00:00.000Z",
    "maskedEmail": "p***@example.com",
    "boundToAccount": true
  },
  "requestId": "req_01"
}
```

The invited workspace is `data.workspace.id`, with `data.workspace.name` for
display and `data.workspace.slug` for a friendly route. Use `workspace.id` for
all API calls; do not assume the slug is unique enough for authorisation.

The recipient address is intentionally masked. The public response must not be
used to tell the visitor whether a particular account is the recipient. Use the
verification endpoint for that.

#### Errors

| HTTP | Code | Meaning |
| ---- | ---- | ------- |
| `404` | `INVITATION_NOT_FOUND` | The token is unknown, malformed or replaced by a resend. |
| `410` | `INVITATION_EXPIRED` | The invitation deadline passed. |
| `410` | `INVITATION_REVOKED` | The invitation was revoked. |
| `410` | `INVITATION_ALREADY_ACCEPTED` | The invitation was already accepted. |
| `410` | `INVITATION_WORKSPACE_UNAVAILABLE` | The workspace is archived or deleted. |
| `429` | `RATE_LIMITED` | Too many preview requests. |

A `DECLINED` invitation is returned as `200 OK` with `"status": "DECLINED"`;
the frontend must render the declined state. Other terminal states are returned
as the errors above for backwards compatibility.

## 6. Authenticated verification

### `GET /invitations/{token}/verify`

Purpose: answer "may the signed-in account accept or decline this invitation?"
without changing anything. Call this before rendering the action buttons.

#### Success — `200 OK`

```json
{
  "success": true,
  "data": {
    "workspace": {
      "id": "6a3f2f7e-2f9a-4b5f-9f0a-2f7e6a3f2f7e",
      "name": "Acme Rockets",
      "slug": "acme-rockets"
    },
    "invitedBy": {
      "id": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
      "name": "Jane Doe"
    },
    "role": "MEMBER",
    "organizationRole": null,
    "status": "PENDING",
    "expiresAt": "2026-11-10T12:00:00.000Z",
    "maskedEmail": "p***@example.com",
    "boundToAccount": true,
    "viewer": {
      "userId": "c1d2e3f4-a5b6-7890-1234-567890abcdef",
      "email": "person@example.com",
      "emailMatches": true,
      "alreadyMember": false,
      "membershipRole": null,
      "canAccept": true,
      "canDecline": true,
      "reason": null
    }
  },
  "requestId": "req_02"
}
```

`viewer` fields:

| Field | Meaning |
| ----- | ------- |
| `userId` | The signed-in account. |
| `email` | The signed-in account's own email address. |
| `emailMatches` | True when this account is the intended recipient. A bound invitation matches by account; an unbound invitation matches by email address. |
| `alreadyMember` | True when the account already belongs to the workspace. |
| `membershipRole` | The account's current workspace role when `alreadyMember` is true, otherwise `null`. |
| `canAccept` | True only when `status` is `PENDING`, the workspace is active, `emailMatches` is true and `alreadyMember` is false. |
| `canDecline` | True when `status` is `PENDING`, the workspace is active and `emailMatches` is true. Declining is still allowed for an existing member so the pending invitation can be cleared. |
| `reason` | `null` when the invitation is actionable for this viewer; otherwise one of the reason values below. |

`reason` values:

| Reason | Frontend meaning |
| ------ | ---------------- |
| `null` | The invitation is actionable; use `canAccept` and `canDecline`. |
| `EMAIL_MISMATCH` | This is not the invited account. Offer "switch account" or sign out. Do not offer accept or decline. |
| `ALREADY_ACCEPTED` | The invitation was already used. Offer to open the workspace. |
| `DECLINED` | The invitation was declined. Offer a neutral exit or ask an administrator for a new invitation. |
| `REVOKED` | An administrator revoked it. Offer a neutral exit. |
| `EXPIRED` | The deadline passed. Offer a neutral exit or ask for a new invitation. |
| `WORKSPACE_UNAVAILABLE` | The workspace is archived or deleted. Offer a neutral exit. |
| `ALREADY_A_MEMBER` | The account already belongs to the workspace. Do not accept; route to `workspace.id`. |

The verification endpoint reports terminal invitation states as `200 OK` so the
frontend can render them. It still returns `404 INVITATION_NOT_FOUND` for an
unknown or replaced token, `401` when no session is present, `403
EMAIL_NOT_VERIFIED` for an unverified account, and `429 RATE_LIMITED`.

## 7. Accepting an invitation

### `POST /invitations/{token}/accept`

No request body.

#### Success — `200 OK`

```json
{
  "success": true,
  "data": {
    "id": "3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d",
    "workspaceId": "6a3f2f7e-2f9a-4b5f-9f0a-2f7e6a3f2f7e",
    "workspaceName": "Acme Rockets",
    "email": "person@example.com",
    "role": "MEMBER",
    "organizationRole": null,
    "type": "WORKSPACE",
    "status": "ACCEPTED",
    "invitedBy": {
      "id": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
      "name": "Jane Doe"
    },
    "expiresAt": "2026-11-10T12:00:00.000Z",
    "acceptedAt": "2026-11-08T09:15:00.000Z",
    "declinedAt": null,
    "revokedAt": null,
    "createdAt": "2026-11-08T08:00:00.000Z"
  },
  "requestId": "req_03"
}
```

The backend, inside one database transaction:

- locks the workspace and verifies it is active;
- rechecks the token digest, `PENDING` status and deadline;
- creates the workspace membership when the account is not already a member;
- marks the invitation `ACCEPTED`, sets `acceptedAt` and `acceptedById`, and
  clears the pending-invitation slot;
- writes the audit event and notifies the inviter.

Concurrent acceptances are serialised by the workspace lock and the conditional
status update. Exactly one request can consume the invitation; the others
receive `409 INVITATION_ALREADY_ACCEPTED` and create no second membership.

After success, use `data.workspaceId` to navigate. Do not trust a workspace id
from the link for authorisation; the backend has already enforced it.

#### Errors

| HTTP | Code | Meaning |
| ---- | ---- | ------- |
| `400` | `VALIDATION_ERROR` | The token path parameter is malformed. |
| `401` | `AUTHENTICATION_REQUIRED` | No valid session. |
| `401` | `SESSION_REVOKED` | The session is no longer valid. |
| `403` | `EMAIL_NOT_VERIFIED` | The account must verify its email first. |
| `403` | `INVITATION_FOR_OTHER_USER` | The signed-in account is not the intended recipient. |
| `404` | `INVITATION_NOT_FOUND` | Unknown or replaced token. |
| `409` | `INVITATION_ALREADY_ACCEPTED` | Already accepted, or lost a concurrent acceptance race. |
| `409` | `INVITATION_REVOKED` | Revoked. |
| `409` | `INVITATION_NOT_PENDING` | The invitation is no longer pending. |
| `409` | `WORKSPACE_NOT_ACTIVE` | The workspace is not active. |
| `410` | `INVITATION_EXPIRED` | The deadline passed. |
| `429` | `RATE_LIMITED` | Too many requests. |
| `500` | `INVITATION_NOT_STORED` | The invitation could not be persisted. Retry safely; the transaction rolled back. |

## 8. Declining an invitation

### `POST /invitations/{token}/decline`

No request body.

#### Success — `200 OK`

The response is the same invitation summary shape as acceptance, with:

```json
{
  "success": true,
  "data": {
    "id": "3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d",
    "workspaceId": "6a3f2f7e-2f9a-4b5f-9f0a-2f7e6a3f2f7e",
    "workspaceName": "Acme Rockets",
    "email": "person@example.com",
    "role": "MEMBER",
    "organizationRole": null,
    "type": "WORKSPACE",
    "status": "DECLINED",
    "invitedBy": {
      "id": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
      "name": "Jane Doe"
    },
    "expiresAt": "2026-11-10T12:00:00.000Z",
    "acceptedAt": null,
    "declinedAt": "2026-11-08T09:20:00.000Z",
    "revokedAt": null,
    "createdAt": "2026-11-08T08:00:00.000Z"
  },
  "requestId": "req_04"
}
```

Declining never creates or deletes workspace membership. It clears the pending
slot, so the workspace may invite the same address again.

#### Errors

| HTTP | Code | Meaning |
| ---- | ---- | ------- |
| `400` | `VALIDATION_ERROR` | The token path parameter is malformed. |
| `401` | `AUTHENTICATION_REQUIRED` / `SESSION_REVOKED` | No valid session. |
| `403` | `EMAIL_NOT_VERIFIED` | The account must verify its email first. |
| `403` | `INVITATION_FOR_OTHER_USER` | The signed-in account is not the intended recipient. |
| `404` | `INVITATION_NOT_FOUND` | Unknown or replaced token. |
| `409` | `INVITATION_DECLINED` | Already declined. |
| `409` | `INVITATION_NOT_PENDING` | The invitation is no longer pending. |
| `409` | `WORKSPACE_NOT_ACTIVE` | The workspace is not active. |
| `410` | `INVITATION_EXPIRED` | The deadline passed. |
| `429` | `RATE_LIMITED` | Too many requests. |
| `500` | `INVITATION_NOT_STORED` | The invitation could not be persisted. |

## 9. Error response format

Every error uses the project-wide envelope:

```json
{
  "success": false,
  "error": {
    "code": "INVITATION_FOR_OTHER_USER",
    "message": "This invitation was sent to a different account",
    "requestId": "req_05"
  }
}
```

Validation errors may include `details`:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request contains invalid data",
    "details": [
      { "field": "params.token", "message": "The invitation token is not valid" }
    ],
    "requestId": "req_06"
  }
}
```

Frontend rules:

- Branch on `error.code`, not on the human-readable `message`.
- Show the invitation-specific state for `INVITATION_*` codes.
- Show a generic retry for `INTERNAL_SERVER_ERROR`.
- Do not retry `403`, `404`, `409` or `410` automatically.
- A `500 INVITATION_NOT_STORED` is safe to retry once because the transaction
  rolled back; the invitation is still usable.

## 10. Invitation inbox and administrator endpoints

### `GET /invitations`

Returns an array of invitation summaries addressed to the signed-in account
(bound to the account id or to its email). This is the Messages-area-style
invitation inbox; it is not the general notification feed.

```json
{
  "success": true,
  "data": [
    {
      "id": "3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d",
      "workspaceId": "6a3f2f7e-2f9a-4b5f-9f0a-2f7e6a3f2f7e",
      "workspaceName": "Acme Rockets",
      "email": "person@example.com",
      "role": "MEMBER",
      "organizationRole": null,
      "type": "WORKSPACE",
      "status": "PENDING",
      "invitedBy": { "id": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", "name": "Jane Doe" },
      "expiresAt": "2026-11-10T12:00:00.000Z",
      "acceptedAt": null,
      "declinedAt": null,
      "revokedAt": null,
      "createdAt": "2026-11-08T08:00:00.000Z"
    }
  ],
  "requestId": "req_07"
}
```

The inbox does not include the raw token, so an inbox entry cannot be used to
accept an invitation by itself. The user must open the emailed link or an
administrator must resend it.

### `GET /workspaces/{workspaceId}/invitations?status=PENDING`

Administrator view. `status` is one of `PENDING`, `ACCEPTED`, `DECLINED`,
`REVOKED`, `EXPIRED` or `ALL` (default). Returns the same summary array. The
service expires stale invitations before reading.

### `POST /workspaces/{workspaceId}/invitations`

Request:

```json
{ "email": "person@example.com", "role": "MEMBER" }
```

or an organisation role instead of the workspace role:

```json
{ "email": "person@example.com", "organizationRole": "COMPANY_MEMBER" }
```

Provide exactly one of `role` or `organizationRole`. `role` defaults to
`MEMBER`. Unknown fields are rejected. Response is `201 Created`:

```json
{
  "success": true,
  "data": {
    "invitation": { "...": "InvitationSummary" },
    "emailSent": true
  },
  "requestId": "req_08"
}
```

`emailSent: false` means the invitation exists but the mail provider did not
accept the message. The administrator can resend it.

Errors include `409 INVITATION_EXISTS` (a pending invitation already exists for
that address), `409 ALREADY_A_MEMBER`, `409 WORKSPACE_NOT_ACTIVE`, `403`
permission failures and `429 RATE_LIMITED`.

### `POST /workspaces/{workspaceId}/invitations/{invitationId}/resend`

No body. Replaces the token, extends the deadline by
`WORKSPACE_INVITATION_TTL_SECONDS`, and sends a new mail. The old link stops
working. Errors include `409 INVITATION_ALREADY_ACCEPTED`,
`409 INVITATION_REVOKED`, `409 INVITATION_DECLINED`,
`409 INVITATION_EXPIRED`, `409 INVITATION_NOT_PENDING` and
`404 INVITATION_NOT_FOUND`.

### `DELETE /workspaces/{workspaceId}/invitations/{invitationId}`

No body. Revokes a pending, declined or expired invitation. The invitee's link
stops working. Errors include `409 INVITATION_ALREADY_ACCEPTED` and
`409 INVITATION_REVOKED`.

## 11. Required frontend behavior

### On opening the invitation link

1. Read `token` from `?token=...`.
2. If missing or malformed, show an invalid-link state. Do not call the API with
   an empty token.
3. Call `GET /invitations/{token}`.
4. Show the workspace name, inviter, role and expiry from the response.
5. Never call `accept` automatically. Acceptance must be an explicit user
   action.
6. If the user is not signed in, offer sign-in/register and preserve the full
   invitation URL as the return destination.
7. If the user is signed in, call `GET /invitations/{token}/verify`.
8. Render actions strictly from `viewer.canAccept` and `viewer.canDecline`.
   Never derive eligibility from the public preview or from the masked email.

### After sign-in or registration

Return the user to the same invitation route with the same token. The frontend
may keep the token in the `returnTo` URL; it must not copy it into logs,
analytics or long-lived storage. After the user verifies their email, repeat the
verification call.

### Accept

- Send `POST /invitations/{token}/accept` only after an explicit click.
- Disable the button while the request is in flight to avoid duplicate clicks;
  the backend is still safe against concurrent requests.
- On `200`, navigate to the invited workspace, for example
  `/workspaces/{data.workspaceId}`, and refresh the workspace list.
- On `409 INVITATION_ALREADY_ACCEPTED`, treat the invitation as already used and
  route to the workspace or show the accepted state.
- On `403 INVITATION_FOR_OTHER_USER`, show the wrong-account state and offer to
  switch accounts.
- On `410 INVITATION_EXPIRED`, show the expired state and offer to request a new
  invitation.

### Decline

- Send `POST /invitations/{token}/decline` only after an explicit click.
- On `200`, show the declined confirmation. The user has not joined the
  workspace and must not be routed into it.
- Declining is final for that token. A new invitation is required to join later.

### Redirects

The backend performs no redirects. Recommended frontend routes:

| Situation | Destination |
| --------- | ----------- |
| Link opened while signed out | Sign-in/register page with `returnTo` set to the invitation route including `?token=...` |
| Accept succeeds | `/workspaces/{workspaceId}` |
| Already a member (`ALREADY_A_MEMBER`) | `/workspaces/{workspaceId}` |
| Already accepted (`ALREADY_ACCEPTED`) | `/workspaces/{workspaceId}` or an "already accepted" page |
| Declined | A declined confirmation page, or `/workspaces` |
| Expired, revoked, unavailable, invalid token | A terminal invitation state page, or `/workspaces` |
| Email mismatch | Wrong-account page with "switch account" and "sign out" actions |

## 12. Configuration

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `FRONTEND_URL` | empty in development; required in production | Origin used to build the invitation link. Production requires `https`. |
| `WORKSPACE_INVITATION_LINK_PATH` | `/workspaces/invitations/accept` | Frontend route that receives `?token=...`. Must start with `/`. |
| `WORKSPACE_INVITATION_TTL_SECONDS` | `172800` (48 hours) | Invitation lifetime. Resending issues a new deadline. |
| `CORS_ORIGINS` | — | Must include the frontend origin so the browser can call the API. |

No new environment variable is required for this flow. The invitation email
link is:

```text
${FRONTEND_URL}${WORKSPACE_INVITATION_LINK_PATH}?token=<raw-token>
```

with trailing slashes removed from `FRONTEND_URL`. Example:
`https://app.nexus.example/workspaces/invitations/accept?token=...`.

## 13. Security requirements for the frontend

- Do not auto-accept on page load, link preview, email scanner fetch or bot
  crawl. Only the explicit user action may call `accept`.
- Do not log or transmit the raw token to third-party analytics, error tracking
  or support tooling.
- Do not trust the workspace id, role or email from the link. Read them from the
  backend response, and let the backend authorise the action.
- Do not treat the public preview as proof that the current user is the
  recipient. Call the verification endpoint.
- Do not retry terminal invitation errors automatically.
- Do not expose the invitation token in a `Referer` header to unrelated origins;
  keep the invitation page free of third-party embeds where practical.
