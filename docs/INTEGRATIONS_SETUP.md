# Integrations Setup

This document lists environment variables, OAuth redirect URIs, scopes, webhook configuration, and importer notes for Nexus integrations implemented on `feat/integrations-import`.

## Core

| Env var | Required | Description |
|---|---:|---|
| `INTEGRATION_ENCRYPTION_KEY` | Yes (for stored tokens) | 32-byte base64url key used for AES-256-GCM encryption of integration access/refresh tokens at rest. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Tokens are never returned by API responses or written to logs. |
| `FRONTEND_URL` | Yes | Frontend origin used for OAuth result redirects (e.g. `/settings/integrations?...`). |
| `JWT_ACCESS_SECRET` | Yes | Used to sign OAuth state (CSRF protection) in addition to auth. |

OAuth state is signed (HMAC), single-use when Redis is available, and short-lived (10 minutes). PKCE (S256) is used where supported (Google Calendar, GitHub).

## Google Calendar (per-workspace, workspace admins only)

Two-way sync with Nexus events is executed as idempotent background jobs with retries and visible status (`lastSyncedAt`, `lastError`, sync jobs). Sync tokens are used where available to handle changed/deleted events and avoid echo loops.

| Env var | Required | Description |
|---|---:|---|
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret (backend only). |
| `GOOGLE_CALENDAR_REDIRECT_URI` | Yes | Must exactly match an authorized redirect URI in Google Cloud Console. |

- **Redirect URI:** `GOOGLE_CALENDAR_REDIRECT_URI` (e.g. `http://localhost:4000/api/v1/integrations/google-calendar/callback`)
- **Scopes (minimal):** `https://www.googleapis.com/auth/calendar.events`
- **Authorize:** `GET /api/v1/integrations/google-calendar/authorize?workspaceId=<uuid>` (authenticated, workspace admin/manager)
- **Callback:** `GET /api/v1/integrations/google-calendar/callback`

## Slack (per-workspace, workspace admins only)

Posts notifications and automation messages to a chosen channel. Workspace
update permission (`OWNER` or `PROJECT_MANAGER`) is required to connect, change
settings, list channels, or disconnect.

Notification settings live in the integration config: `slackChannelId`,
`slackChannelName`, and `notificationsEnabled` (default `true`). Set them through
`PATCH /api/v1/integrations/:integrationId` with a `config` object.

| Env var | Required | Description |
|---|---:|---|
| `SLACK_CLIENT_ID` | Yes (OAuth flow) | Slack app client ID. |
| `SLACK_CLIENT_SECRET` | Yes (OAuth flow) | Slack app client secret. |
| `SLACK_REDIRECT_URI` | Yes (OAuth flow) | Must match Slack app OAuth redirect URL. |
| `SLACK_DEFAULT_CONNECT` | No | If `true` with `SLACK_BOT_TOKEN`, enables server-token "default connect" for internal/demo use. |
| `SLACK_BOT_TOKEN` | No | Bot token used only when `SLACK_DEFAULT_CONNECT=true`. |

- **Redirect URI:** `SLACK_REDIRECT_URI` (e.g. `http://localhost:4000/api/v1/integrations/slack/callback`)
- **Scopes (minimal):** `chat:write,channels:read,channels:join`
- **Authorize:** `GET /api/v1/integrations/slack/authorize?workspaceId=<uuid>` (authenticated, workspace admin/manager)
- **Callback:** `GET /api/v1/integrations/slack/callback`
- **List channels:** `GET /api/v1/integrations/:integrationId/slack/channels` (workspace admin/manager). Returns public channels only (`id`, `name`, `private`, `member`). With the scopes above, private channels are not listed.
- **Delivery events:** task assigned, task due soon, task overdue, form submitted, and the explicit automation action `SEND_SLACK_MESSAGE` (`POST_MESSAGE` remains an internal chat action). Messages are persisted as durable `OUTBOUND_EVENT` sync jobs before Slack is contacted, deduplicated per event, and retried with bounded exponential backoff. Slack `Retry-After` is honoured.
- **Reconnect notice:** if Slack rejects the stored token (`invalid_auth`, `token_revoked`, etc.), the integration is marked `needsReconnect`, pending Slack jobs are failed without retry, and every ACTIVE workspace member receives an in-app `INTEGRATION_RECONNECT_REQUIRED` notification once. Reconnecting Slack clears the state.
- **Privacy:** Slack messages contain only the item title, status and a deep link (forms: form name and link). Task descriptions, comments, attachments, form answers, actor/assignee names and automation error text are never sent.

## GitHub (per-workspace, workspace admins only)

Links PRs/issues to tasks and receives webhooks with HMAC signature verification and replay protection.

| Env var | Required | Description |
|---|---:|---|
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth client ID. |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth client secret. |
| `GITHUB_CALLBACK_URL` | Yes | OAuth callback URL. |
| `GITHUB_INTEGRATION_WEBHOOK_SECRET` | Yes (webhooks) | HMAC secret for GitHub webhooks (`X-Hub-Signature-256`). Falls back to `GITHUB_APP_WEBHOOK_SECRET` if unset. |

- **OAuth redirect URI:** `GITHUB_CALLBACK_URL` (e.g. `http://localhost:4000/api/v1/integrations/github/callback`)
- **Scopes (minimal):** `read:user,repo` (repo access required for PR/issue linking metadata)
- **Authorize:** `GET /api/v1/integrations/github/authorize?workspaceId=<uuid>` (authenticated, workspace admin/manager)
- **Callback:** `GET /api/v1/integrations/github/callback`
- **Webhook endpoint:** `POST /api/v1/webhooks/github`
  - Header: `X-Hub-Signature-256: sha256=<hmac>`
  - Header: `X-GitHub-Delivery: <unique id>` (used for replay/idempotency protection)
  - Header: `X-GitHub-Event: <event>`
  - Bad signatures are rejected (401); duplicate deliveries are safely ignored.

## Sync and status

- Syncs run as idempotent background jobs with retries.
- Visible status: integration `lastSyncedAt`, `lastError`, and `GET /api/v1/integrations/:integrationId/status` (latest job).
- Manual enqueue: `POST /api/v1/integrations/:integrationId/sync` (202).

## Importers (ClickUp, Trello, CSV)

- **Dry-run preview:** `POST /api/v1/imports/dry-run` — returns counts (projects, tasks, comments, users), warnings; does **not** create entities.
- **Confirm/execute:** `POST /api/v1/imports/:importId/confirm` — queues a background execution job (202). Supports `idempotencyKey` for idempotent confirmation.
- **Get/list:** `GET /api/v1/imports/:importId`, `GET /api/v1/imports?workspaceId=<uuid>`
- Users mapped by email; unmapped users become unassigned with warnings.
- Idempotent: external source IDs are stored (`ImportExternalId`) to prevent duplicates on re-run.
- Workspace permissions enforced (workspace access required); plan limits should be respected by deployment policy (enforcement hooks can be extended per billing module).
- Import reports include counts and warnings/errors.

## Audit events

- `integration.connected`
- `integration.disconnected`
- `integration.refresh_failed`
- `import.previewed`, `import.confirmed`, `import.completed`
- additional config/enable/disable events as applicable.
