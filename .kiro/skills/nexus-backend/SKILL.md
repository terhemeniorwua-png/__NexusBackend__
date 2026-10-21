---
name: nexus-backend
description: Build and maintain the complete Nexus workspace and project management platform backend using Node.js, Express, TypeScript, PostgreSQL, Prisma, Redis, Socket.IO, transactional email, a managed AI API, a managed calling SDK, and S3-compatible storage. Use when implementing backend features, database models, APIs, security, integrations, tests, or deployment.
---

# Nexus Backend Engineering Skill

## 1. Mission

Build the complete Nexus backend as a secure, maintainable, scalable API for a real-time workspace and project management platform.

Nexus combines:
- User accounts, authentication and workspace management.
- Teams, projects, tasks, reviews and dependencies.
- Connected messaging, notifications and file sharing.
- Audio/video meetings through a managed calling SDK.
- AI-powered planning, summaries, writing assistance and workspace insights.
- Search, analytics, scheduling, integrations and workflow automation.

Implement features incrementally according to the 24 development phases below. Do not attempt to implement the entire platform in one operation.

## 2. Required technology stack

- Runtime: Node.js.
- Language: TypeScript.
- HTTP API: Express.
- Database: PostgreSQL.
- ORM and migrations: Prisma.
- Cache and coordination: Redis.
- Real-time communication: Socket.IO.
- Email: A transactional email provider behind a reusable provider adapter.
- Background processing: BullMQ with Redis when asynchronous jobs are required.
- AI: An existing managed AI API accessed exclusively through the backend.
- Audio/video: A managed calling SDK/provider.
- File storage: S3-compatible object storage.
- API documentation: OpenAPI.
- Testing: Unit, integration, API and end-to-end tests.

Use stable, mutually compatible package versions. Check the existing project configuration and official documentation before installing or upgrading dependencies.

## 3. Architecture rules

Organize the backend into feature modules. Each module should contain appropriate routes, controllers, validation schemas, services, types and tests.

Recommended structure:

- `src/app.ts`: Express application configuration.
- `src/server.ts`: Server startup, Socket.IO initialization and graceful shutdown.
- `src/config/`: Validated environment configuration.
- `src/db/`: Database client and related setup.
- `src/middleware/`: Authentication, authorization, validation, rate limiting and error handling.
- `src/modules/`: Domain-specific backend modules.
- `src/services/cache/`: Redis cache abstractions and invalidation.
- `src/services/storage/`: Object-storage adapter.
- `src/services/providers/`: Email, AI and calling provider adapters.
- `src/realtime/`: Socket.IO setup, events and authorization.
- `src/jobs/`: Background jobs, workers and scheduling.
- `src/utils/`: Reusable utilities.
- `prisma/`: Schema and database migrations.
- `tests/`: Automated tests.

Use `/api/v1` for versioned HTTP endpoints.

Keep business logic out of route handlers. Validate incoming data at the boundary, enforce authorization in the backend and return consistent JSON responses and errors.

Keep the frontend and backend in separate repositories. Do not make assumptions about frontend implementation details or invent API contracts. Document endpoints, request/response schemas and socket event payloads using OpenAPI and appropriate shared contract definitions.

## 4. The 24 implementation phases

### Phase 1 — Foundation and infrastructure
Initialize Express and TypeScript; configure scripts, validated environment variables, structured logging, centralized error handling, security middleware, CORS, request IDs, health endpoints, graceful shutdown and the initial test framework.

### Phase 2 — Database architecture
Design relational models, foreign keys, indexes, uniqueness constraints, deletion policies and migrations. Establish the foundational user, workspace, membership, team, project, task, invitation, file, notification and audit models. Add later models as their phases begin.

### Phase 3 — Authentication and account lifecycle
Implement registration, password hashing, email verification, login, logout, secure sessions or an appropriately designed token system, password recovery, password changes, session revocation, email changes, account status and account deletion. Apply rate limits and protect sensitive endpoints.

### Phase 4 — Transactional email
Create a reusable email service, provider adapter, branded HTML and plain-text templates, delivery records, retries, deduplication, provider webhook verification and delivery monitoring. Integrate the service with all required business events.

### Phase 5 — Workspaces and invitations
Implement workspace lifecycle, memberships, ownership, secure invitations, expiration, acceptance, revocation, resending and invitation acceptance notifications. Handle both registered and unregistered invitees and validate invitation tokens and intended recipients.

### Phase 6 — Roles and authorization
Implement workspace, team and project permission policies. Enforce resource-level access checks for all HTTP requests, socket events, files, meetings and AI context. Prevent cross-workspace data access.

### Phase 7 — Teams
Implement team creation, updates, archival, membership, team leads where required, project associations and membership notifications.

### Phase 8 — Projects
Implement project lifecycle, visibility, membership, settings, status, dates, ownership, listing, filtering, pagination and project activity.

### Phase 9 — Tasks and workflows
Implement task CRUD, assignees, priorities, labels, dates, subtasks, dependencies, blockers and workflow transitions. Support `ASSIGNED`, `IN_PROGRESS`, `SUBMITTED`, `UNDER_REVIEW`, `APPROVED` and `CHANGES_REQUESTED`. Validate transitions and permissions on the backend.

### Phase 10 — Comments, activity and audit logs
Implement comments, threaded replies, edit/delete rules, activity feeds and protected audit records for significant resource, membership and permission changes.

### Phase 11 — File management
Implement S3-compatible storage, file metadata, signed upload/download URLs, attachments, validation, quotas where required, deletion policies and private-file authorization. Never expose private storage credentials.

### Phase 12 — Real-time infrastructure
Configure authenticated Socket.IO connections, authorized rooms, validated events, presence, typing indicators, reconnect behavior and Redis-backed cross-instance coordination when needed.

### Phase 13 — Messaging
Implement direct messages, group conversations, team/project channels, task-linked discussions, message editing/deletion, replies, reactions, mentions, read receipts, unread counts, attachments, search and real-time delivery.

### Phase 14 — Notifications
Implement persistent in-app notifications, unread counts, read/dismiss operations, real-time delivery, user preferences, notification grouping and email integration. Support assignment, mentions, comments, review outcomes, membership changes and meeting events.

### Phase 15 — Search
Implement permission-aware search and filtering for users, workspaces, projects, tasks, messages and comments. Begin with indexed PostgreSQL queries and full-text search where appropriate. Add semantic search only when justified.

### Phase 16 — Calendar and scheduling
Implement task deadlines, project timelines, scheduled events, time-zone-aware scheduling, recurring reminders where needed, overdue detection, reminder cancellation and email/in-app delivery.

### Phase 17 — Audio/video meetings
Integrate the managed calling SDK. Implement meeting lifecycle, participants, invitations, room authorization, short-lived provider credentials, scheduling, cancellation, call history and verified provider webhooks. Add recording or transcription only with appropriate consent and access controls.

### Phase 18 — AI services
Implement a provider adapter, AI service, model configuration, timeouts, output validation, usage tracking, quotas and cost controls. Support task planning, task breakdown, writing assistance, summaries, blocker analysis and authorized workspace Q&A. Require human confirmation for consequential actions.

### Phase 19 — Background jobs and automation
Implement appropriate BullMQ workers for email, reminders, AI summaries, file processing, notification delivery and cleanup. Add retry policies, idempotency, job monitoring, concurrency limits and failed-job recovery. Use an outbox pattern where critical database changes must reliably trigger asynchronous events.

### Phase 20 — Integrations and webhooks
Implement integration interfaces, secure credential storage, signed outgoing webhooks, verified incoming webhooks, retries, deduplication, event subscriptions and integration revocation.

### Phase 21 — Security and performance
Harden authentication, authorization, input validation, rate limiting, session security, file access, tenant isolation, secret management, database queries, provider failure handling, data retention and privacy. Test cross-workspace access and other critical threat scenarios.

### Phase 22 — Testing and quality assurance
Implement unit, integration, API, socket, provider-mocking and end-to-end tests. Cover authentication, invitations, permissions, tasks, notifications, files, AI, meetings, job retries and database migrations. Add CI checks for linting, type-checking and tests.

### Phase 23 — Deployment and operations
Configure development, staging and production environments; CI/CD; controlled migrations; HTTPS; health checks; logging; error monitoring; database backups; restore procedures; worker deployment; Redis and Socket.IO scaling; alerts and rollback procedures.

### Phase 24 — Production verification and ongoing operations
Validate the complete platform through production-readiness checks, critical user journeys, load testing, backup restoration, incident procedures, provider failure simulations and operational documentation. Continue monitoring, patching dependencies and improving reliability after launch.

Security, validation, logging, testing and documentation are cross-cutting requirements. Begin them in Phase 1 and maintain them throughout all phases.

## 5. Required email workflows

Every email-producing feature must use the centralized email service rather than implementing provider calls directly inside controllers.

Support the following events, subject to the stated security requirements and user preferences:

1. Account creation: send an email-verification link or code.
2. Account verification: send a welcome email when configured.
3. Password reset: send a secure, single-use, expiring reset link.
4. Password change: send a security notification.
5. Email address change: verify the new address and notify relevant addresses.
6. Workspace invitation: email the invitee with the workspace, inviter, intended role and secure acceptance link.
7. Team or project invitation: send the appropriate invitation where these invitation types are supported.
8. Invitation acceptance: notify the inviter or relevant administrators.
9. Invitation reminder: optionally remind invitees before expiry.
10. Task assignment and reassignment: notify relevant assignees according to preferences.
11. Mentions, comments and replies: notify relevant participants.
12. Task due dates and overdue status: send scheduled reminders where enabled.
13. Review outcomes: notify assignees when a task is approved or changes are requested.
14. Meeting invitation, reminder, rescheduling and cancellation: notify affected participants.
15. Security and account events: send required security notifications.
16. Account deletion: send appropriate request and completion notifications.

Email requirements:

- Configure provider credentials through environment variables.
- Verify sending-domain DNS records before production use.
- Provide branded HTML and plain-text templates.
- Use secure, expiring tokens for verification, reset and invitation flows.
- Never include passwords or long-lived credentials in email links.
- Validate recipients and resource permissions before sending.
- Track provider message IDs and delivery statuses.
- Verify webhook signatures and handle duplicate webhook events.
- Retry transient failures without duplicating the underlying operation.
- Keep secrets and verification tokens out of logs.
- Respect preferences for optional notifications; do not suppress required security messages through ordinary preferences.
- Ensure email failure does not undo an already committed business transaction.
- Use a durable queue and transactional outbox when reliable delivery requires it.

## 6. PostgreSQL and Prisma rules

- PostgreSQL is the source of truth for application data.
- Use Prisma for schema management, queries and migrations.
- Apply schema changes through migrations rather than manually altering production databases.
- Use foreign keys, indexes, uniqueness constraints and appropriate transaction boundaries.
- Prevent duplicate memberships and duplicate active invitations according to product rules.
- Use explicit enums or validated state machines for controlled statuses.
- Avoid storing large file binaries in PostgreSQL.
- Keep database access in services or dedicated repositories where useful.
- Do not create models for every future feature before their requirements and relationships are understood.
- Test migrations against a fresh database and an existing development dataset.

## 7. Redis rules

Use Redis for suitable cache entries, rate-limit counters, presence, coordination and background queues.

- PostgreSQL remains authoritative.
- Define key naming conventions, TTLs and invalidation rules.
- Invalidate or update cache entries after relevant successful database writes.
- Do not cache sensitive data without a clear security and invalidation policy.
- Do not assume a cache hit proves that the user is still authorized.
- Use atomic Redis operations where concurrency requires them.
- Apply timeouts and bounded failure handling.
- Keep the core application usable when a nonessential cache operation fails.
- Do not store durable business records solely in Redis.
- Add distributed Socket.IO coordination and BullMQ workers when the feature or deployment requires them.

## 8. AI and calling provider rules

### AI
- Keep API keys server-side.
- Authorize every workspace resource before retrieving context.
- Validate requests and model output.
- Set timeouts, quotas, usage limits and cost monitoring.
- Treat retrieved messages and documents as untrusted input.
- Do not permit AI-generated instructions to bypass application permissions.
- Require confirmation before consequential mutations.
- Avoid sending unnecessary personal or confidential data to the provider.

### Calling
- Keep provider secrets server-side.
- Authorize meeting creation and joining on the backend.
- Issue short-lived credentials with appropriate scopes.
- Verify provider webhook signatures.
- Make webhook processing idempotent.
- Record meeting metadata and history in PostgreSQL.
- Obtain appropriate consent before recording or transcribing meetings.

## 9. API and real-time standards

- Use consistent JSON response and error formats.
- Validate all incoming HTTP and socket payloads.
- Document HTTP endpoints using OpenAPI.
- Define event names, payload shapes and authorization rules for Socket.IO.
- Apply pagination to potentially large collections.
- Enforce access checks for every resource.
- Avoid leaking internal errors, database details or secrets.
- Use idempotency for operations that may be retried.
- Keep the frontend independent of database, Redis and provider internals.

## 10. Required workflow when making changes

Before implementing a feature:

1. Inspect the existing repository, `agent.md`, relevant skills, package configuration, Prisma schema and current implementation.
2. Identify the current phase and the feature's dependencies.
3. Read the official documentation for unfamiliar or version-sensitive APIs.
4. Define the data changes, API contract, authorization rules, email events and real-time events that apply.
5. Break the work into small, testable steps.
6. Implement only the requested scope and necessary supporting work.
7. Add or update migrations, validation, tests and documentation.
8. Run relevant formatting, linting, type-checking and tests.
9. Review for security issues, accidental data exposure and regressions.
10. Summarize the files changed, commands run, test results, environment variables needed and remaining work.

Do not mark a feature complete merely because the code has been written. Verify its behavior and failure cases.

## 11. Repository safety rules

- Never delete or overwrite `.env`, secrets, user data, migrations or existing features without explicit authorization.
- Never run destructive database operations without explicit authorization.
- Do not reset a database to make tests pass.
- Do not invent provider credentials, working endpoints or successful test results.
- Do not expose secrets in frontend variables, API responses, logs or committed files.
- Do not silently change the agreed architecture.
- Prefer small, reviewable changes over a complete rewrite.
- Ask for clarification if a critical business rule or provider choice is genuinely ambiguous.
- If a provider credential is unavailable, implement a testable adapter and clearly document what remains unverified.

## 12. Definition of done

A backend feature is complete only when:

- Its behavior matches the agreed requirements.
- Inputs are validated and permissions enforced.
- Database changes use appropriate migrations and constraints.
- Relevant email, notification and real-time events are implemented.
- Failures, retries and duplicate requests are handled where applicable.
- Automated tests cover success and important failure cases.
- Type-checking and relevant quality checks pass.
- API and environment documentation are updated.
- No secrets or destructive unintended changes are introduced.
- The final report states what was implemented, what was tested and what remains incomplete.

**Primary instruction:** Build Nexus incrementally, phase by phase. Preserve a working foundation, prioritize secure and correct business logic, and never sacrifice data integrity or authorization to implement features faster.
