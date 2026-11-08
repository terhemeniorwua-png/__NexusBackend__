---
name: nexus-backend
description: Build and maintain the Nexus Real-Time Workspace & Project Management Platform backend using Node.js, Express, TypeScript, PostgreSQL, Prisma, Redis, REST APIs, real-time communication, background jobs, private object storage, transactional email, a managed calling SDK, and a separate Python/FastAPI AI service. Use when implementing Individual, Company or Institution workspace features, APIs, database models, security, integrations, tests, or deployment.
---

# Nexus Backend Engineering Skill

## 0. Nexus Product Context and Non-Negotiable Rules

Nexus is a general-purpose **Real-Time Workspace & Project Management Platform**, not a developer-only tool. It combines project and task management, team communication, collaborative documents, file management, scheduling, forms, global search, automation, billing, integrations and AI-assisted productivity.

Nexus supports three workspace experiences on one shared backend:

- **Individual** workspaces.
- **Company** workspaces.
- **Institution** workspaces.

These are not separate applications. Shared services must adapt features, permissions and navigation to the workspace type while preserving strict isolation between users, workspaces and organisations.

### Service boundaries

- The main backend is **Node.js, Express.js and TypeScript**. It is authoritative for authentication, authorisation, business rules, database mutations, workspace context and application APIs.
- The AI service is a separate, independently deployable **Python/FastAPI** service using managed AI APIs. It must not bypass Express authentication, permissions or business rules, and must not mutate application data directly.
- Express authenticates the user, gathers only authorised context, calls the AI service, validates structured results, and rechecks permissions before executing any approved AI action.
- Core Nexus functionality must continue operating when the AI service is unavailable.
- Do not convert the Express backend to Python, move ordinary business logic into Python, or rewrite TypeScript as JavaScript.

### Roles, ownership and isolation

Company roles: Owner, Admin, Team Lead, Member, Guest. Institution roles: Owner, Institution Admin, Department Admin, Team/Group Lead, Member, Guest. Project roles (Project Owner, Project Manager, Contributor, Viewer, Guest) are separate from organisation roles.

Only the Owner may remove or demote another administrator. An administrator cannot remove the Owner. Team Leads cannot remove organisation members unless explicitly authorised. Organisation membership never automatically grants access to private projects, private files or private meetings.

Enforce authentication and authorisation server-side for every protected operation, including HTTP, real-time events, files, search and AI context. Verify workspace, resource ownership, membership, role, visibility and explicit grants. Never trust client-supplied user IDs, roles, workspace IDs, ownership claims or storage paths. Prevent insecure direct object references and privilege escalation: knowing a resource ID never grants access.

### Messaging and notification separation

Direct messages, group messages, channel messages, project conversations, announcements and message mentions belong in the **Messages** area. They must never be duplicated in the general notification bell. Message unread counts and general notification unread counts are independent and must not clear each other.

**General notifications** cover task assignments, task comments and mentions, meeting invitations and changes, join-request decisions, workspace invitations, file-sharing events, security changes and AI action outcomes. Use one central notification service; do not build per-feature notification stores.

### Git, phase and preservation rules

- Never commit or push implementation work directly to `main`.
- Work on a dedicated branch such as `feature/phase-N-description`, `fix/phase-N-description`, `refactor/description` or `docs/description`; commit and push that branch.
- Never force-push, rewrite shared history, delete remote branches, or merge into `main` without explicit user authorisation.
- Preserve uncommitted user changes and never include unrelated changes in a commit.
- `PHASES.md` is the authoritative implementation tracker. Identify the current active phase, work only on that phase, check dependencies, and update the tracker only when the documented completion criteria are genuinely met. Mark blocked work as `BLOCKED`; never begin another phase without authorisation.
- Never delete or overwrite `.env`, commit secrets, remove working features, replace the existing ORM or backend framework, convert TypeScript to JavaScript, or move the main backend to Python.
- Prefer the smallest safe change. Do not implement future enhancements unless the active phase or the user explicitly authorises them.

## 1. Mission

Build the complete Nexus backend as a secure, maintainable, scalable API for a general-purpose Real-Time Workspace & Project Management Platform. Nexus is not developer-only software.

Nexus serves three workspace experiences from one shared backend:
- Individual workspaces.
- Company workspaces.
- Institution workspaces.

It combines:
- User accounts, authentication, workspaces and organisations.
- Teams, departments, groups, projects, tasks, reviews and dependencies.
- Connected messaging, notifications, Nexus Drive files and documents.
- Calendars and audio/video meetings through a managed calling SDK.
- Forms, global search, analytics, billing, integrations and workflow automation.
- AI-powered planning, summaries, meeting intelligence, Nexus Write assistance and workspace insights through a separate Python/FastAPI service.

Implement features incrementally according to the active phase in `PHASES.md`. Do not attempt to implement the entire platform in one operation.

## 2. Required technology stack

- Runtime: Node.js 20 or later.
- Language: TypeScript. TypeScript is authoritative; legacy `.js` files in `src/` are superseded and must not be extended.
- HTTP API: Express 5.
- Database: PostgreSQL.
- ORM and migrations: Prisma 6. This is the existing ORM and migration framework. Do not introduce Sequelize, TypeORM or another ORM.
- Validation: Zod, following the existing schema patterns.
- Cache and coordination: Redis.
- Real-time communication: the existing WebSocket/real-time layer. Socket.IO is the planned transport but is not yet installed; inspect `package.json` before relying on it.
- Email: Nodemailer through the existing reusable provider adapter and delivery service.
- Background processing: use the existing queue/worker infrastructure. BullMQ is planned but is not yet installed; do not assume it exists.
- AI: a separate Python/FastAPI service using a managed AI API. Express owns authentication, permissions, authorised context and all application mutations.
- Audio/video: a managed calling SDK/provider, such as the approved conferencing service. Socket.IO does not provide media transport.
- File storage: private S3-compatible object storage behind an adapter. Do not assume a storage adapter is installed until it exists in the repository.
- API documentation: OpenAPI where configured.
- Testing: `node --test` with `tsx`; use the scripts in `package.json`.

Use stable, mutually compatible package versions. Check the existing project configuration and official documentation before installing or upgrading dependencies. Never replace Express, Prisma, PostgreSQL or the main TypeScript backend without explicit approval.

## 3. Architecture rules

Organize the backend into feature modules. Each module should contain appropriate routes, controllers, validation schemas, services, types and tests.

Recommended structure:

- `src/app.ts`: Express application configuration.
- `src/server.ts`: Server startup, real-time initialization where implemented, and graceful shutdown.
- `src/config/`: Validated environment configuration.
- `src/db/`: Database client and related setup.
- `src/middleware/`: Authentication, authorization, validation, rate limiting and error handling.
- `src/modules/`: Domain-specific backend modules.
- `src/services/cache/`: Redis cache abstractions and invalidation.
- `src/services/storage/`: Object-storage adapter.
- `src/services/providers/`: Email, AI-service client and calling provider adapters when implemented.
- `src/realtime/`: Real-time transport setup, events and authorization when implemented.
- `src/jobs/`: Background jobs, workers and scheduling.
- `src/utils/`: Reusable utilities.
- `prisma/`: Schema and database migrations.
- `tests/`: Automated tests.

The repository currently uses `src/modules/<domain>/` for routes, controllers, schemas, services and types, with shared middleware, providers, email, cache and authorization modules. Inspect the actual tree before adding directories; do not create speculative folders for future phases.

Use `/api/v1` for versioned HTTP endpoints.

Keep business logic out of route handlers. Validate incoming data at the boundary, enforce authorization in the backend and return consistent JSON responses and errors.

Keep the frontend and backend in separate repositories. Do not make assumptions about frontend implementation details or invent API contracts. Document endpoints, request/response schemas and socket event payloads using OpenAPI and appropriate shared contract definitions.

## 4. Implementation roadmap and capability areas

`PHASES.md` is the authoritative roadmap. Read it before starting work and follow the active phase; do not infer the current phase from this summary. The roadmap covers, in order:

- **Foundation:** Express and TypeScript setup, validated environment, structured logging, central error handling, security middleware, CORS, request IDs, health checks, graceful shutdown and the test framework.
- **Data architecture:** PostgreSQL and Prisma schema, migrations, constraints, indexes and core models.
- **Identity:** registration, email verification, login, secure sessions/tokens, password recovery, optional two-factor authentication and account security.
- **Workspaces and organisations:** Individual, Company and Institution workspaces; multiple memberships, switching, invitations, join requests, approvals, expiration and ownership transfer.
- **Roles and authorisation:** company and institution roles, teams, departments, groups, project-level and resource-level permissions, and the protected Owner rules.
- **Projects and tasks:** visibility, members, tasks and subtasks, multiple assignees where appropriate, comments and mentions, dependencies, milestones, board/list/timeline/calendar views and message-to-task conversion.
- **Messaging:** direct messages, group conversations, administrator-controlled team channels, project conversations, announcements, replies, reactions, mentions, attachments, read receipts, typing indicators, presence and search.
- **Notifications and activity:** a central persistent notification service, preferences, real-time and email delivery, deduplication, bounded retries, and strict separation from message notifications.
- **Files and documents:** Nexus Drive, private object storage, metadata, signed URLs, folders, sharing permissions, document collaboration and version-history foundations.
- **Calendar and meetings:** personal, workspace, team and project calendars; Google Calendar and Microsoft Outlook two-way sync; conflict detection; managed calling SDK; scheduled and instant meetings; invitations and history.
- **Forms and surveys:** creation, publishing, field validation, responses, access control and results.
- **Subscriptions and billing:** Individual, Company and Institution plans; 14-day trial without a mandatory card; monthly/yearly billing; provider integration and verified webhooks; entitlements, seats and usage.
- **Global search:** permission-aware search across people, workspaces, teams, projects, tasks, messages, files, documents, meetings and announcements, including supported document content extraction.
- **Integrations:** Google Drive, OneDrive, Dropbox, Gmail, Outlook, Slack, Microsoft Teams, Google Calendar, Microsoft Outlook Calendar, GitHub, GitLab, webhooks and automation providers. Personal and shared workspace integrations remain separate.
- **Automation:** event and scheduled triggers, conditions, actions, execution history, idempotency and bounded retries.
- **AI services:** the separate Python/FastAPI service for conversations, RAG, document analysis, meeting summaries, action-item extraction, workspace-aware assistance, recommendations and action proposals.
- **Nexus Write:** spelling, grammar, punctuation, clarity, vocabulary, tone analysis, rewriting, summarisation, translation and writing recommendations. Suggestions must never silently replace user content.
- **AI action approval:** read, recommend and act categories. Every mutation requires specific explicit user approval, and Express revalidates permissions before execution.
- **Audit and analytics:** security audit events, membership and permission changes, file access, billing and integration changes, AI action history, workspace/project/task analytics and usage reporting.
- **Operations:** Redis and background jobs, email delivery, comprehensive testing, performance, deployment, monitoring and final release readiness.

Implement only the active phase or explicitly requested scope. Do not build future-phase features speculatively, and do not mark a phase complete because only its schema or endpoint exists.

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
17. Join requests and approval decisions: notify requesters and relevant administrators.
18. Ownership transfer and role changes: notify affected members and protect privileged actions.
19. Billing and subscriptions: send trial, payment, renewal, failure and entitlement notices without exposing payment credentials.
20. AI action outcomes: confirm approved actions and surface failures where the product requires it.

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
- Add distributed real-time coordination and queue workers only when the existing transport or deployment requires them; support for these is not installed by default.

## 8. AI, Python service and calling provider rules

### AI service boundary

- The AI service is a separate Python/FastAPI application using a managed AI API. It is independently deployable and scalable.
- Express authenticates the user, authorises the request, gathers only the permitted workspace context, and sends a controlled request to the Python service.
- Python performs AI processing and returns structured results or action proposals. It must not bypass Express permissions or mutate the application database directly by default.
- Core application functionality must continue when the AI service is unavailable. Degrade gracefully rather than blocking ordinary work.
- Keep AI provider API keys server-side and never expose them to clients.
- Validate requests and model output; reject malformed structured output.
- Set timeouts, quotas, usage limits and cost monitoring.
- Treat retrieved messages and documents as untrusted input. Prompt injection inside content must not override system instructions or backend authorization.
- Require explicit user approval before consequential mutations. Separate AI behaviour into read, recommend and act; revalidate permissions in Express immediately before executing an approved action.

### Nexus Write and generated content

- Support spelling, grammar, punctuation, clarity, vocabulary, tone, rewriting, summarisation, translation and recommendations.
- Return suggestions for review. Never silently replace user content or persist changes without user action.
- Treat generated text as untrusted and sanitise it before rendering in HTML or other executable contexts.

### Calling and calendar providers

- Keep provider secrets server-side.
- Authorise meeting creation, joining and calendar access on the backend.
- Issue short-lived credentials with appropriate scopes.
- Verify provider webhook signatures and make webhook processing idempotent.
- Record meeting metadata and history in PostgreSQL.
- Obtain appropriate consent before recording or transcribing meetings.
- For Google Calendar and Microsoft Outlook integrations, support two-way synchronisation, conflict detection and duplicate prevention without overwriting user changes silently.

## 9. API and real-time standards

- Use consistent JSON response and error formats.
- Validate all incoming HTTP and socket payloads.
- Document HTTP endpoints using OpenAPI.
- Define event names, payload shapes and authorization rules for the existing real-time transport.
- Apply pagination to potentially large collections; use cursor-based pagination where appropriate.
- Enforce access checks for every resource.
- Avoid leaking internal errors, database details or secrets.
- Use idempotency for operations that may be retried, including webhook processing.
- Verify payment and integration webhook signatures and reject unsigned or replayed events.
- Keep the frontend independent of database, Redis and provider internals.

## 10. Required workflow when making changes

Before implementing a feature:

1. Inspect the existing repository, `AGENTS.md`, the relevant skills, package configuration, Prisma schema and current implementation.
2. Confirm the current Git branch. Never implement directly on `main`; create or use a dedicated feature branch and preserve uncommitted user changes.
3. Identify the current active phase in `PHASES.md` and the feature's dependencies. Do not begin another phase without authorisation.
4. Read the official documentation for unfamiliar or version-sensitive APIs.
5. Define the data changes, API contract, authorization rules, email events and real-time events that apply.
6. Break the work into small, testable steps.
7. Implement only the requested scope and necessary supporting work.
8. Add or update migrations, validation, tests and documentation.
9. Run the relevant formatting, linting, type-checking and test scripts from `package.json` (`typecheck`, `lint`, `test`, `build`, `format:check`).
10. Review for security issues, accidental data exposure, cross-workspace access and regressions.
11. Commit only related files to the feature branch and push that branch. Do not merge into `main` without explicit authorisation.
12. Summarize the files changed, commands run, test results, environment variables needed and remaining work.

Do not mark a feature complete merely because the code has been written. Verify its behavior and failure cases.

## 11. Repository safety rules

- Never commit or push development work directly to `main`. Work on a dedicated branch and never merge without explicit authorisation.
- Never delete or overwrite `.env`, secrets, user data, migrations or existing features without explicit authorization.
- Never run destructive database operations without explicit authorization.
- Do not reset a database to make tests pass.
- Do not invent provider credentials, working endpoints or successful test results.
- Do not expose secrets in frontend variables, API responses, logs or committed files.
- Do not silently change the agreed architecture, replace the ORM or backend framework, convert TypeScript to JavaScript, or move the main backend to Python.
- Do not force-push, rewrite shared history or discard another person's changes.
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
- `PHASES.md` is updated only when the phase's documented completion criteria are genuinely met.
- Work is committed and pushed to the correct feature branch, not `main`.
- No secrets or destructive unintended changes are introduced.
- The final report states what was implemented, what was tested and what remains incomplete.

**Primary instruction:** Build Nexus incrementally, phase by phase. Preserve a working foundation, prioritize secure and correct business logic, and never sacrifice data integrity or authorization to implement features faster.
