# Nexus Backend

**Real-Time Workspace & Project Management Platform**

Nexus is a collaborative workspace platform designed to bring project management, task tracking, team communication, shared documents, notifications, meetings, and AI-assisted productivity into one connected environment.

The Nexus backend powers the platform's business logic, data persistence, authentication, authorization, real-time communication, integrations, and API services.

## Table of Contents

- [Overview](#overview)
- [Core Features](#core-features)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [User Roles](#user-roles)
- [Task Workflow](#task-workflow)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment Configuration](#environment-configuration)
- [Database Setup](#database-setup)
- [Running the Server](#running-the-server)
- [API Design](#api-design)
- [Authentication](#authentication)
- [Workspaces and Invitations](#workspaces-and-invitations)
- [Real-Time Communication](#real-time-communication)
- [Redis and Caching](#redis-and-caching)
- [Email and Notifications](#email-and-notifications)
- [Meetings and AI Integration](#meetings-and-ai-integration)
- [Security](#security)
- [Testing](#testing)
- [Frontend Integration](#frontend-integration)
- [Deployment](#deployment)
- [Development Workflow](#development-workflow)
- [Contributing](#contributing)

## Overview

Modern teams often use separate applications for project management, documents, messaging, and meetings. This can fragment conversations, decisions, and task information.

Nexus aims to bring these activities together in one workspace, connecting communication directly to the work being performed.

The backend provides the services required to manage users, workspaces, teams, projects, tasks, conversations, documents, notifications, and supported external integrations.

The backend and frontend are maintained in separate repositories and communicate through documented HTTP APIs and real-time events where supported.

## Core Features

### 1. Authentication and User Management

- User registration and login.
- Session management and logout.
- Secure password handling.
- User profiles and account settings.
- Authentication failure and expired-session handling.
- Role-aware access control.
- Email verification and password recovery where implemented.

### 2. Workspaces and Teams

- Workspace creation, update, archive and deletion. The creator becomes the owner.
- Membership aware reads: a caller only ever sees the workspaces it belongs to.
- Member management: adding a registered account, changing a role and removing a member.
- Invitations with a single use token, an expiry and a mail that carries the workspace, the inviter, the role and the acceptance link.
- Workspace and project access control.
- Role-based permissions.
- Private and shared workspaces according to configured permissions.

### 3. Project Management

- Create and manage projects.
- Assign members to projects.
- Manage project visibility and access.
- Organize work into tasks and relevant resources.
- Track project activity and progress.
- Support project-level discussions and collaboration.

### 4. Task Management

- Create, update, and assign tasks.
- Manage task descriptions, priority, due dates, and status.
- Support Kanban and list-based task organization.
- Track task comments and activity where implemented.
- Support task submission, review, approval, and change requests.
- Calculate project progress according to defined business rules.

### 5. Connected Communication

Nexus connects conversations to the work they concern.

Potential capabilities include:

- Direct messages.
- Team and project conversations.
- Task-specific discussions.
- User mentions.
- Message-to-task conversion.
- Contextual file sharing.
- Real-time message delivery where supported.
- Notifications for relevant activity.

### 6. Documents and Collaboration

- Store and organize workspace documents.
- Control access to shared resources.
- Support document creation and editing where implemented.
- Track saving and update states.
- Integrate collaborative editing services when configured.

Real-time collaborative editing requires a compatible implementation; it is not guaranteed by ordinary REST endpoints or Socket.IO alone.

### 7. Notifications

- Task assignment notifications.
- Comment and mention notifications.
- Project activity notifications.
- Messaging notifications.
- Read and unread status where implemented.
- Real-time notification delivery where supported.
- Email notifications through a configured provider.

### 8. Meetings and AI-Assisted Productivity

The architecture may support integrations for:

- Starting meetings from a workspace, project, or conversation.
- Meeting metadata and participant management.
- Meeting summaries and action items.
- AI-assisted task or project workflows.
- Summarization of authorized workspace content.

These capabilities depend on the relevant providers, credentials, permissions, and backend services being configured.

### 9. Files and Attachments

Where implemented, file-related services should support:

- Uploading and associating files with relevant resources.
- File metadata and access control.
- Configurable storage providers.
- File type and size restrictions.
- Authorized file retrieval.

Large files should generally use appropriate object storage rather than being stored directly in relational database records.

## Architecture

Nexus uses a separated frontend/backend architecture.

```text
┌─────────────────────────────────────┐
│        Nexus Frontend               │
│     Next.js + TypeScript            │
└──────────────────┬──────────────────┘
                   │
          HTTPS / REST API
                   │
          Socket.IO connection
                   │
┌──────────────────▼──────────────────┐
│          Nexus Backend              │
│        Node.js + Express            │
│             TypeScript              │
├─────────────────────────────────────┤
│ Authentication and Authorization    │
│ Workspace and Project Services      │
│ Task and Document Services          │
│ Messaging and Notification Services │
│ Integration and Validation Layers   │
└───────────┬─────────────┬───────────┘
            │             │
     ┌──────▼──────┐ ┌────▼─────┐
     │ PostgreSQL  │ │  Redis   │
     │  + Prisma   │ │ Cache /  │
     │             │ │ Support  │
     └─────────────┘ └──────────┘
```

The exact implementation may include additional services for email delivery, file storage, meetings, AI processing, or background jobs.

### Architectural Principles

- Separation of concerns.
- Explicit API contracts.
- Centralized validation and error handling.
- Authentication and authorization enforced on the server.
- Reusable business services.
- Database integrity and transactional consistency.
- Real-time events that reflect authorized state changes.
- Environment-based configuration.
- Testable, maintainable code.

## Technology Stack

| Technology | Purpose |
|---|---|
| Node.js | JavaScript runtime |
| Express.js | HTTP API framework |
| TypeScript | Type-safe application development |
| PostgreSQL | Relational database |
| Prisma ORM | Database access, schema, and migrations |
| Redis | Caching and other configured real-time or background-work support |
| Socket.IO | Real-time communication |
| JWT or secure session mechanism | Authentication, according to the implementation |
| Email provider | Transactional email where configured |
| Testing tools | Automated quality assurance |

Use the versions and scripts defined in the repository's package manifest and lockfile.

## User Roles

Nexus supports the following intended roles:

| Role | Intended responsibility |
|---|---|
| Owner | Workspace administration and ownership |
| PM | Project planning and management |
| Member | Participation in assigned or authorized work |
| Viewer | Read-only access where permitted |
| Collaborator | Access to explicitly shared resources |

The backend must enforce the actual permission matrix for each resource and action. The descriptions above are conceptual; the implemented authorization rules are authoritative.

## Task Workflow

The intended task lifecycle is:

`ASSIGNED → IN_PROGRESS → SUBMITTED → UNDER_REVIEW → APPROVED`

An additional state is:

`CHANGES_REQUESTED`

The backend should validate permitted transitions, verify the acting user's permissions, and preserve the task's relevant activity history.

Project progress should follow a consistent server-defined calculation rather than relying on independently calculated frontend values.

## Project Structure

The following is an illustrative structure. Adapt it to the repository's actual organization.

```text
nexusbackend/
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── src/
│   ├── config/
│   ├── controllers/
│   ├── middleware/
│   ├── routes/
│   ├── services/
│   │   ├── cache/
│   │   ├── email/
│   │   │   └── templates/
│   │   └── providers/
│   │       └── email/
│   ├── repositories/
│   ├── validators/
│   ├── types/
│   ├── utils/
│   ├── sockets/
│   ├── integrations/
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── webhooks/
│   │   └── workspaces/
│   ├── app.ts
│   └── server.ts
├── tests/
│   └── helpers/
├── nexus-database/
│   └── SKILL.md
├── emailing/
│   └── SKILL.md
├── ai-meetings/
│   └── SKILL.md
├── real-messaging/
│   └── SKILL.md
├── testing-deployment/
│   └── SKILL.md
├── agent.md
├── PHASES.md
├── .env.example
├── package.json
└── README.md
```

Not every folder must exist. Follow the actual project architecture and avoid creating unnecessary layers.

## Prerequisites

Install or configure:

- A supported Node.js version.
- npm, pnpm, or the package manager specified by the repository.
- PostgreSQL.
- Redis if required by the configured application features.
- Git.
- Access to any external services required for the features being developed.

## Installation

Clone the backend repository and enter its directory:

```bash
git clone <YOUR_NEXUS_BACKEND_REPOSITORY_URL>
cd nexusbackend
```

Install dependencies using the repository's package manager.

For npm:

```bash
npm install
```

Create your local environment file from the example, if provided:

```bash
cp .env.example .env
```

Configure the required values before starting the application.

Never commit `.env` or real credentials.

## Environment Configuration

The exact environment variable names must match the application's configuration code.

Typical configuration categories include:

| Variable or setting | Purpose |
|---|---|
| `NODE_ENV` | Runtime environment |
| `PORT` | HTTP server port |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string, if used |
| `FRONTEND_URL` | Trusted frontend origin |
| `JWT_SECRET` | JWT signing secret, if JWT is used |
| `SESSION_SECRET` | Session signing secret, if applicable |
| `EMAIL_*` | Email provider configuration |
| `AI_*` | AI provider configuration, if integrated |
| `MEETING_*` | Meeting provider configuration, if integrated |
| `STORAGE_*` | File storage configuration, if integrated |

These names are examples, not a guarantee of the repository's current variable names. Inspect the configuration code and `.env.example` before using them.

Use strong secrets in development and production. Never expose backend secrets to the frontend.

### Authentication settings

The variables below are read by `src/config/env.ts`. All of them have defaults except `JWT_ACCESS_SECRET`, which must be at least 32 characters and must not be a placeholder.

| Variable | Default | Purpose |
|---|---|---|
| `JWT_ACCESS_SECRET` | none | Signs the access token and derives the CSRF signing key |
| `JWT_ACCESS_TTL_SECONDS` | `900` | Access token lifetime |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh token and session lifetime |
| `BCRYPT_SALT_ROUNDS` | `12` | Password hashing cost |
| `VERIFICATION_TOKEN_TTL_SECONDS` | `3600` | Email verification token lifetime |
| `PASSWORD_RESET_TOKEN_TTL_SECONDS` | `1800` | Password reset token lifetime |
| `EMAIL_CHANGE_TOKEN_TTL_SECONDS` | `3600` | Email change token lifetime |
| `AUTH_COOKIE_SECURE` | `false` (`true` in production) | Marks the session cookies as secure |
| `AUTH_COOKIE_SAME_SITE` | `lax` | `SameSite` attribute of the session cookies. `none` requires `AUTH_COOKIE_SECURE=true` |
| `AUTH_COOKIE_DOMAIN` | empty | Optional cookie domain |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `900000` | Window of the authentication rate limits |
| `AUTH_LOGIN_RATE_LIMIT_MAX` | `10` | Sign-in attempts per window per IP address and per account |
| `AUTH_REGISTER_RATE_LIMIT_MAX` | `5` | Registrations per window per IP address and per account |
| `AUTH_PASSWORD_RATE_LIMIT_MAX` | `5` | Password requests per window per IP address and per account |
| `AUTH_VERIFICATION_RATE_LIMIT_MAX` | `5` | Verification requests per window per IP address and per account |
| `AUTH_VERIFICATION_LINK_PATH` | `/verify-email` | Frontend path that receives the verification link |
| `AUTH_PASSWORD_RESET_LINK_PATH` | `/reset-password` | Frontend path that receives the reset link |
| `AUTH_EMAIL_CHANGE_LINK_PATH` | `/settings/email` | Frontend path that receives the email change link |
| `RATE_LIMIT_NAMESPACE` | `nexus` | Prefix for the Redis rate limit keys. Use a different value per environment when they share a Redis instance |

The verification, reset and email change links are built from `FRONTEND_URL` and the configured path, so the frontend contract can change without a backend deployment.

### Workspace settings

| Variable | Default | Purpose |
|---|---|---|
| `WORKSPACE_INVITATION_TTL_SECONDS` | `604800` | Lifetime of an invitation link |
| `WORKSPACE_INVITATION_LINK_PATH` | `/workspaces/invitations/accept` | Frontend route that receives the acceptance link |
| `TASK_ASSIGNMENT_LINK_PATH` | `/projects/:projectId/tasks/:taskId` | Frontend route for an assigned task. `:projectId` and `:taskId` are replaced with encoded identifiers |
| `COMMENT_MENTION_LINK_PATH` | `/projects/:projectId/tasks/:taskId#comment-:commentId` | Frontend route for a comment mention. Route parameters are replaced with encoded identifiers |
| `MEETING_INVITATION_LINK_PATH` | `/meetings/:meetingId` | Frontend route for a meeting invitation. `:meetingId` is replaced with an encoded identifier |

### Email settings

The variables below are read by `src/config/env.ts` and drive the Phase 4 transactional email service.

| Variable | Default | Purpose |
|---|---|---|
| `EMAIL_PROVIDER` | `disabled` in production, `console` otherwise | Transport: `smtp`, `console` or `disabled`. Production requires `smtp` |
| `EMAIL_SMTP_HOST` | none | SMTP host. Required when the provider is `smtp` |
| `EMAIL_SMTP_PORT` | `587` | SMTP port. Port `465` requires `EMAIL_SMTP_SECURE=true` |
| `EMAIL_SMTP_SECURE` | `false` | Use TLS on connect instead of STARTTLS |
| `EMAIL_SMTP_USER` | empty | SMTP username |
| `EMAIL_SMTP_PASSWORD` | empty | SMTP password |
| `EMAIL_SMTP_TLS_REJECT_UNAUTHORIZED` | `true` | Reject untrusted SMTP certificates |
| `EMAIL_FROM_ADDRESS` | none | Sender address. Its domain needs SPF, DKIM and DMARC |
| `EMAIL_FROM_NAME` | `Nexus` | Sender display name |
| `EMAIL_REPLY_TO_ADDRESS` | empty | Optional reply-to address |
| `EMAIL_SUPPORT_ADDRESS` | empty | Optional support address shown in the email footer |
| `EMAIL_APP_URL` | falls back to `FRONTEND_URL` | Public base URL used for links in emails |
| `EMAIL_WEBHOOK_SECRET` | empty | Shared secret for provider webhooks. At least 32 characters. The webhook endpoint is disabled while empty |
| `EMAIL_WEBHOOK_TOKEN` | empty | Token for providers that do not sign their events, Brevo among them. At least 32 characters. The webhook URL then ends with the token |
| `EMAIL_WEBHOOK_SIGNATURE_HEADER` | `x-nexus-signature` | Header that carries the provider signature |
| `EMAIL_WEBHOOK_TOLERANCE_SECONDS` | `300` | Accepted age of a signed webhook timestamp |
| `EMAIL_MAX_ATTEMPTS` | `5` | Delivery attempts before a message is given up |
| `EMAIL_RETRY_BASE_DELAY_MS` | `30000` | Base delay of the exponential retry backoff |
| `EMAIL_RETRY_MAX_DELAY_MS` | `3600000` | Upper bound of the retry delay |
| `EMAIL_REQUEST_TIMEOUT_MS` | `15000` | Timeout of a single provider request |
| `EMAIL_WORKER_ENABLED` | `true` | Run the background delivery worker |
| `EMAIL_WORKER_POLL_INTERVAL_MS` | `5000` | Delay between outbox polls |
| `EMAIL_WORKER_BATCH_SIZE` | `10` | Maximum rows claimed per poll |

## Database Setup

Nexus uses PostgreSQL as its relational data store and Prisma for schema management and database access.

After configuring the database connection, inspect the Prisma scripts in `package.json`.

Typical development commands, if supported by the project, include:

```bash
npx prisma validate
npx prisma generate
npx prisma migrate dev
```

For production deployments, use the repository's approved migration process, commonly:

```bash
npx prisma migrate deploy
```

Do not run migrations against production without reviewing the migration, confirming the target database, and following the deployment procedure.

Avoid destructive database resets unless explicitly authorized and safely isolated to a disposable development database.

## Running the Server

Inspect `package.json` for the actual scripts.

Common examples include:

```bash
npm run dev
```

For a configured production build:

```bash
npm run build
npm start
```

The exact commands depend on the repository's scripts and TypeScript build configuration.

When running locally, confirm that:

- The server starts successfully.
- PostgreSQL is reachable.
- Required migrations have been applied.
- Redis connects if required.
- Required environment variables are present.
- The frontend can reach the API using the configured URL.

## API Design

Organize APIs by resource and domain.

Potential resource groups include:

- Authentication and users.
- Workspaces and teams.
- Members and invitations.
- Projects and project membership.
- Tasks and task activity.
- Documents.
- Conversations and messages.
- Notifications.
- Meetings and AI-assisted features.
- Files and attachments.

These are domain categories, not claims that specific endpoints already exist.

### API Guidelines

- Use consistent HTTP methods and status codes.
- Validate request parameters and bodies.
- Authenticate protected requests.
- Enforce resource-level authorization.
- Return consistent response and error structures.
- Apply pagination to large collections.
- Validate sorting and filtering parameters.
- Use database transactions for operations that must succeed or fail together.
- Document request and response contracts for the frontend.
- Avoid returning sensitive fields unnecessarily.

Maintain API documentation using the documentation approach adopted by the repository.

## Authentication

Phase 3 implements the account lifecycle. The full contract is in `docs/openapi.yaml`.

### Session model

| Credential | Where it lives | Lifetime | Notes |
|---|---|---|---|
| Access token | Response body, sent as `Authorization: Bearer <token>` | `JWT_ACCESS_TTL_SECONDS` (default 15 minutes) | Short-lived HS256 JWT. Never stored in a cookie. |
| Refresh token | httpOnly `nexus_rt` cookie | `REFRESH_TOKEN_TTL_SECONDS` (default 30 days) | Opaque random value. Only its SHA-256 digest is stored in PostgreSQL. |
| CSRF token | Response body and readable `nexus_csrf` cookie | Same as the refresh token | Sent back in the `x-csrf-token` header. |

Rules that the implementation enforces:

- Every authenticated request is checked against the `Session` row in PostgreSQL, so signing out, changing a password or resetting a password revokes access immediately instead of waiting for the access token to expire.
- The refresh token rotates on every use. Presenting a token that was already rotated is treated as a compromise and revokes every session of the account (`SESSION_REUSE_DETECTED`).
- Requests that rely on the `nexus_rt` cookie must also send the `x-csrf-token` header. The header is required: the `nexus_csrf` cookie alone is not accepted, because a browser attaches cookies to cross-site requests automatically. The cookie only gives the frontend a way to read the value. Requests that present the refresh token in the request body are not cookie-authenticated and do not need one.
- Only cookie-authenticated requests exist, so the business endpoints never accept the access token from a cookie and are therefore not exposed to cross-site request forgery.
- One-time tokens (email verification, password reset, email change) are single use, expiring, and stored only as digests. The newest token of a purpose invalidates the older ones.
- Deactivation revokes every session and invalidates every outstanding one-time token, so a link issued before deactivation cannot restore access or change the account. Reactivation is self-service with the account email address and password, never creates a session, and returns an unverified account to `PENDING_VERIFICATION` with a fresh verification link. Deleted and suspended accounts cannot reactivate themselves.
- Passwords are hashed with bcrypt, are limited to 72 bytes so nothing is silently truncated, and are never logged or emailed.
- Endpoints that accept an email address (`resend-verification`, `password/forgot`) always return the same response, so they cannot be used to discover which addresses are registered.
- Sign-in, reactivation, registration, verification and password endpoints are rate limited per IP address and per account. The counters live in Redis and fall back to an in-process counter when Redis is unavailable.
- Account level security events are written to the `AuditLog` table with a null `workspaceId`. They never contain passwords, tokens or verification links.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/auth/register` | Create an account and send the verification link |
| `POST` | `/api/v1/auth/verify-email` | Activate the account with the emailed token |
| `POST` | `/api/v1/auth/resend-verification` | Request a new verification link |
| `POST` | `/api/v1/auth/login` | Start a session |
| `POST` | `/api/v1/auth/reactivate` | Reactivate a deactivated account |
| `POST` | `/api/v1/auth/refresh` | Rotate the session |
| `POST` | `/api/v1/auth/logout` | End the current session |
| `POST` | `/api/v1/auth/logout-all` | End every session of the account |
| `GET` | `/api/v1/auth/sessions` | List the active sessions |
| `GET` | `/api/v1/auth/me` | The signed-in account |
| `POST` | `/api/v1/auth/password/forgot` | Request a password reset link |
| `POST` | `/api/v1/auth/password/reset` | Set a new password with the reset token |
| `POST` | `/api/v1/auth/password/change` | Change the password of the signed-in account |
| `POST` | `/api/v1/auth/email/change` | Request an email address change |
| `POST` | `/api/v1/auth/email/change/confirm` | Confirm the email address change |
| `POST` | `/api/v1/auth/deactivate` | Deactivate the signed-in account |
| `POST` | `/api/v1/auth/delete` | Delete the signed-in account |
| `GET` | `/api/v1/users/me` | The profile of the signed-in account |
| `PATCH` | `/api/v1/users/me` | Update the profile of the signed-in account |

### Email delivery

`src/services/email` is the delivery seam. `src/services/providers/email` holds the provider adapter. The default sender only records non-recipient delivery metadata and never logs recipient addresses, message bodies, links or tokens.

Phase 4 installs the transactional sender at startup (`installOutboxEmailSender()` in `src/server.ts`), so application modules only call `sendEmail()` and never touch the provider.

### Provider webhooks

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/webhooks/email` | Provider delivery, bounce and complaint events |
| `POST` | `/api/v1/webhooks/email/:token` | The same events, authenticated with the URL token |

The endpoint is unauthenticated but protected by a shared secret. Two mechanisms are supported:

- A provider that signs its events sends an HMAC signature in the `x-nexus-signature` header (the header name is configurable).
- A provider that does not sign its events, Brevo among them, is verified with the token that the webhook URL carries.

The route is mounted before the JSON body parser so the raw payload can be verified. The response is `200` with the processing outcome, `401` for a missing or invalid secret and `503` while neither a webhook secret nor a token is configured.

## Brevo

Brevo is the configured provider. It is reached through its SMTP relay, so no provider specific code is needed in the application.

| Setting | Value |
|---|---|
| Host | `smtp-relay.brevo.com` |
| Port | `587` with STARTTLS, `465` with implicit TLS |
| User | the account email, or the SMTP key as the user name |
| Password | the SMTP key of the account |

The deployment also needs:

- The sending address in `EMAIL_FROM_ADDRESS` added as an authorised sender in the Brevo account.
- SPF, DKIM and DMARC records for the sending domain. Brevo publishes the DKIM record to add.
- The transactional event webhook configured as `https://<backend-host>/api/v1/webhooks/email/<EMAIL_WEBHOOK_TOKEN>`.

The provider events are mapped onto the stored deliveries:

| Brevo event | Effect |
|---|---|
| `delivered` | The delivery is marked `DELIVERED` |
| `hard_bounce` | The delivery is marked `BOUNCED` and the address is suppressed |
| `soft_bounce` | Nothing changes. A soft bounce is temporary and must not suppress the address |
| `blocked` | The delivery is marked `BOUNCED` and the address is suppressed |
| `spam` | The delivery is marked `COMPLAINED` and the address is suppressed |
| `unsubscribe` | The delivery is marked `COMPLAINED` and the address is suppressed |
| `sent`, `queued` | Recorded, but the delivery state does not change |

The application builds the SMTP message id itself, so the local part of the message id is the id of the delivery row. A Brevo event that carries the message id therefore matches the delivery exactly, and the recipient is only used as a fallback.

## Workspaces and Invitations

Phase 5 implements workspaces, their members and the invitations that grant access. The full contract is in `docs/openapi.yaml`.

### Rules that the implementation enforces

- The creator of a workspace becomes its owner. The owner role cannot be handed out, changed or removed, so a workspace always has exactly one owner.
- Every read and every change is checked against the membership of the caller in the database. A role that a client sends in a request body is never trusted.
- A workspace that does not exist is reported as missing, a workspace the caller does not belong to is reported as forbidden. The two are kept apart, so the endpoints cannot be used to probe for identifiers.
- A member that is removed loses the access to the workspace immediately, because the access is decided by the membership row and not by a token.
- The owner of a workspace may manage every member. A project manager may manage members as well, but not another project manager: a role can only be widened by the owner.
- An invitation is a single use link. Only the SHA-256 digest of the token is stored, so a database leak does not hand out access.
- A pending invitation is unique per address and workspace. An accepted, revoked or expired invitation never blocks a new one, so an address can be invited again.
- The accepting account has to be the one the invitation was meant for: either the account the invitation is bound to, or the account that owns the address it was sent to. An invitation that was sent before the address had an account is bound to that account when it registers.
- The acceptance is applied once. A second attempt with the same token is rejected, also when it arrives at the same moment as the first one.
- An expired, revoked or already used token is rejected with a distinct error code, so the frontend can explain what happened.
- Every change to a workspace, a member or an invitation is written to the `AuditLog` table inside the transaction that performs the change.
- The inviter is notified when an invitation is accepted, and a member is notified when their role changes or their access is removed.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/workspaces` | Create a workspace. The caller becomes its owner |
| `GET` | `/api/v1/workspaces` | The workspaces the caller belongs to |
| `GET` | `/api/v1/workspaces/{workspaceId}` | Read one workspace |
| `PATCH` | `/api/v1/workspaces/{workspaceId}` | Change the name or the description |
| `POST` | `/api/v1/workspaces/{workspaceId}/archive` | Archive the workspace |
| `DELETE` | `/api/v1/workspaces/{workspaceId}` | Delete the workspace. The records keep their history |
| `POST` | `/api/v1/workspaces/{workspaceId}/switch` | Validate the membership and return the workspace to work in |
| `GET` | `/api/v1/workspaces/{workspaceId}/members` | List the members |
| `POST` | `/api/v1/workspaces/{workspaceId}/members` | Add a registered account to the workspace |
| `PATCH` | `/api/v1/workspaces/{workspaceId}/members/{userId}` | Change the role of a member |
| `DELETE` | `/api/v1/workspaces/{workspaceId}/members/{userId}` | Remove a member |
| `GET` | `/api/v1/workspaces/{workspaceId}/invitations` | List the invitations, optionally filtered by state |
| `POST` | `/api/v1/workspaces/{workspaceId}/invitations` | Invite an address and send the invitation mail |
| `POST` | `/api/v1/workspaces/{workspaceId}/invitations/{invitationId}/resend` | Send the invitation again with a new token |
| `DELETE` | `/api/v1/workspaces/{workspaceId}/invitations/{invitationId}` | Revoke an invitation |
| `GET` | `/api/v1/invitations` | The invitations that are addressed to the signed-in account |
| `GET` | `/api/v1/invitations/{token}` | The invitation behind the link, without a session |
| `POST` | `/api/v1/invitations/{token}/accept` | Accept the invitation and join the workspace |

### Invitation states

| State | Meaning |
|---|---|
| `PENDING` | The link is live. It can be accepted, resent or revoked |
| `ACCEPTED` | The link was used. The membership exists |
| `REVOKED` | The inviter withdrew the invitation. The link no longer works |
| `EXPIRED` | The deadline passed. The link no longer works |

## Real-Time Communication

Socket.IO may be used for live messaging, task updates, notifications, presence, and other supported events.

Real-time events should:

- Authenticate connections.
- Verify access to requested resources and rooms.
- Validate event payloads.
- Avoid exposing private workspace information.
- Use consistent event names and payload schemas.
- Avoid broadcasting sensitive data to unauthorized users.
- Cleanly handle disconnects and reconnections.
- Integrate with persisted database state where appropriate.

If multiple backend instances are deployed, configure a suitable shared Socket.IO adapter when cross-instance event delivery is required.

Document the event contract so the frontend can subscribe to the correct events without guessing.

## Redis and Caching

Redis can support selected infrastructure needs, including:

- Caching frequently accessed data.
- Rate limiting.
- Temporary state.
- Background-job infrastructure, if configured.
- Socket.IO cross-instance coordination when the relevant adapter is installed.

Use Redis only for responsibilities actually configured in the project.

Define cache expiration and invalidation rules. Do not allow stale cached data to bypass authorization or expose data after permissions change.

PostgreSQL should remain the authoritative store for persistent relational application data unless a specific service has a documented alternative.

## Email and Notifications

Phase 4 implements transactional email as a reusable platform capability.

- **Provider adapter** — `src/services/providers/email` sends through a provider-agnostic SMTP transport. Resend, Brevo and Amazon SES all expose an SMTP endpoint, so switching provider only changes the connection details. A `console` transport records delivery metadata without sending, and `disabled` accepts messages without sending them. Provider credentials stay server-side. Brevo is the configured provider, see the section below.
- **Templates** — `src/services/email/templates` renders a responsive branded HTML document and a plain-text alternative from one shared document model. HTML output is escaped. The available templates are `account_verification`, `password_reset`, `password_changed`, `email_change_verification`, `security_notification`, `workspace_invitation`, `team_invitation`, `project_invitation`, `task_assignment`, `mention` and `meeting_invitation`.
- **Outbox and delivery metadata** — every message is written to `EmailDelivery` with its template, recipient, status, attempt count, provider message id and timestamps. `EmailSuppression` records bounced and complained addresses, `EmailWebhookEvent` records processed provider events.
- **Background delivery** — a worker polls the outbox and claims due rows with `FOR UPDATE SKIP LOCKED`, so several instances can run it safely. Rows are claimed atomically and the worker stops with the server.
- **Retries and deduplication** — transient provider failures and unexpected worker errors are retried with exponential backoff and jitter only while `EMAIL_MAX_ATTEMPTS` remains. Permanent failures stop immediately, and an exhausted delivery moves to the terminal `FAILED` state instead of returning to the queue. A unique idempotency key per logical send prevents duplicate rows and duplicate sends.
- **Provider webhooks** — `POST /api/v1/webhooks/email` verifies an HMAC signature over the raw payload, then applies delivery, bounce and complaint events. Providers that do not sign their events, Brevo among them, are verified with the token in the webhook URL. Repeated events are applied once.
- **Task assignment notifier** — `src/services/task-assignment-notifier.ts` turns a persisted `TaskAssignee` row into the existing `task_assignment` email. It validates the active workspace and project membership, uses suppression rules, builds the task link from `EMAIL_APP_URL` and `TASK_ASSIGNMENT_LINK_PATH`, and derives its idempotency key from the assignment timestamp. The Phase 9 task service will call it after committing an assignment; delivery failure is reported without changing task data.
- **Collaboration email notifier** — `src/services/collaboration-email-notifier.ts` provides post-commit handlers for persisted comment mentions and pending meeting invitations. Mention recipients are looked up from active users with workspace membership and the comment author is excluded. Both handlers use the transactional outbox, address suppression, stable idempotency keys and links rooted at `EMAIL_APP_URL`. The repository currently has no mention parser or meeting invitation model/workflow, so these handlers do not create mention events or authorize meetings; their owning workflows must call them after commit and supply the persisted pending-invitation context. Notification preferences are not modeled yet; the existing suppression list is enforced.
- **Logging** — verification tokens, reset links and message bodies are never written to the application log. Delivery logs carry the delivery ID, template, provider, attempt and failure category, but not the recipient email address; provider and worker error text is redacted before it is logged.

Requirements:

- Keep provider credentials server-side.
- Validate recipient addresses.
- Handle provider failures and retries appropriately.
- Avoid duplicate notifications.
- Do not expose credentials or sensitive content in logs.
- Use templates consistently.
- Record delivery status where required and supported.

Do not assume email delivery is working until the provider is configured and tested. The sending domain needs SPF, DKIM and DMARC records before a production deployment sends real mail.

## Meetings and AI Integration

Integrations should be isolated behind clear service boundaries.

For AI and meeting providers:

- Store API credentials securely.
- Validate incoming requests.
- Apply appropriate user and resource permissions.
- Handle timeouts, rate limits, and provider errors.
- Track relevant usage where required.
- Protect transcripts, recordings, summaries, and other private content.
- Avoid treating AI-generated output as verified facts without appropriate validation.

Do not make external services mandatory for unrelated features unless the product architecture requires it.

## Security

Security must be enforced by the backend, regardless of what the frontend displays.

Key requirements include:

- Secure password hashing.
- Strong session or token management.
- Authorization on every protected resource.
- Input validation.
- SQL injection protection through safe database access patterns.
- Rate limiting for sensitive or abuse-prone operations.
- Secure CORS configuration.
- Safe error responses.
- Secret management.
- Upload validation and access controls.
- Protection against unauthorized workspace and project access.
- Appropriate audit logging.
- Dependency and configuration maintenance.

Never log passwords, access tokens, private keys, or unnecessary sensitive user data.

## Testing

Test the system at multiple levels:

- Unit tests for services and utilities.
- API integration tests.
- Authentication and authorization tests.
- Database integration tests using isolated test data.
- Task workflow and permission tests.
- Real-time event tests where applicable.
- Email and external-provider tests using safe test configurations.
- Regression tests for existing functionality.

Run the scripts actually configured in `package.json`. Do not run tests against production data.

### Running the tests

The unit and HTTP contract tests always run:

```bash
npm test
```

The database integration tests are opt-in. They create and delete accounts, so they only run when the target database is explicitly marked as a test database. The helper refuses to run against a database whose name does not contain `test`.

```bash
RUN_PHASE2_DB_TESTS=true \
RUN_PHASE3_DB_TESTS=true \
RUN_PHASE4_DB_TESTS=true \
RUN_PHASE5_DB_TESTS=true \
DATABASE_URL="postgresql://nexus:nexus@localhost:5432/nexus_test" \
npm test
```

Apply the migrations to the test database first, or let the test helper apply them:

```bash
DATABASE_URL="postgresql://nexus:nexus@localhost:5432/nexus_test" npx prisma migrate deploy
```

The Phase 3 suite covers registration, verification, sign-in, session rotation, refresh token replay detection, CSRF enforcement, sign-out, password reset and change, email change, deactivation, deletion, profile updates, rate limiting and the audit trail.

The Phase 4 suite covers template rendering in HTML and plain text, configuration validation, transport error classification, outbox enqueue and claiming, idempotent sends, transient retries, permanent failures, the attempt limit, bounded retry of unexpected worker errors, recovery after a temporary worker failure, repair of exhausted queued rows, concurrent claim safety, address suppression, webhook verification and idempotency, that verification tokens never reach the application log, and that queued, sent and failure events do not expose recipient addresses. The Phase 4.3 task-assignment integration suite covers recipient and context selection, reassignment, duplicate events, suppression, ineligible recipients, and delivery failure without assignment corruption. The integration tests talk to a local SMTP capture server or the transactional outbox, so no provider credentials and no outbound mail are required.

The Phase 5 suite covers the workspace lifecycle, the membership rules and the invitation flow: the content of the invitation mail, an invitee that registers after the invitation was sent, a single use token, expired, revoked and duplicate invitations, an invitation that belongs to another account, a resend that replaces the token, the member rules for the owner and for a project manager, the audit trail of every membership change and the state of the workspace after an archive and a deletion.

With every database integration suite enabled the full suite is 125 tests, and all of them pass.

## Frontend Integration

The frontend is a separate Next.js and TypeScript application.

Integration requires agreement on:

- API base URL.
- Authentication and session strategy.
- Request and response types.
- Error formats.
- Pagination conventions.
- CORS and allowed origins.
- Socket.IO URL and authentication.
- Event names and payload schemas.
- Upload and download behavior.
- Date, time, and timezone conventions.

Maintain a documented contract between both repositories. Update the frontend types and integration code when a backend contract intentionally changes.

## Deployment

Before deploying:

1. Review configuration and secrets.
2. Verify database connectivity.
3. Review pending migrations.
4. Run the appropriate automated checks.
5. Build the application.
6. Configure Redis and required external services.
7. Configure frontend origins and CORS.
8. Configure HTTPS and production secrets.
9. Deploy using the approved process.
10. Verify health, logs, database access, and essential user flows.

Use backward-compatible database changes when possible. Prepare a rollback or recovery procedure for risky releases.

## Development Workflow

The repository may contain:

- `agent.md` for project-wide development instructions.
- `PHASES.md` for the implementation roadmap and progress.
- Specialized `SKILL.md` files for database work, messaging, email, AI meetings, testing, and deployment.

Before implementing a feature:

1. Read the relevant instructions and phase.
2. Inspect existing code and configuration.
3. Identify dependencies and API contracts.
4. Implement the smallest coherent change.
5. Run relevant tests and checks.
6. Document unresolved issues.
7. Update phase status only when acceptance criteria are verified.

## Contributing

Contributions should preserve the existing architecture, maintain security and data integrity, and include appropriate tests.

Before submitting changes:

- Verify the affected functionality.
- Run applicable lint, type-check, test, and build commands.
- Document API or schema changes.
- Avoid committing credentials or local environment files.
- Explain known limitations and required configuration.

## Project Status

The precise implementation status of each feature is determined by the source code, tests, configuration, and current roadmap—not by the feature descriptions in this README.

`PHASES.md` is the implementation tracker. Phases 1 to 5 (foundation, infrastructure, authentication, transactional email, workspaces and invitations) are complete. The next phase is Phase 6, roles, permissions and authorization.

