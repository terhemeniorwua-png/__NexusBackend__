# Nexus Backend — Agent Instructions

## 1. Project Overview

Nexus is a real-time workspace and project management platform combining project management, connected communication, audio/video meetings and AI-powered productivity.

The backend is maintained in a repository separate from the Next.js frontend.

The backend is responsible for authentication, authorization, business logic, data persistence, API contracts, real-time events, email provider integrations, AI integrations, caching, background jobs and secure communication with external services.

## 2. Technology Stack

Use:

- Node.js.
- Express.
- TypeScript.
- PostgreSQL as the primary relational database.
- Prisma ORM and migrations.
- Redis for caching, temporary state, rate limiting and coordination.
- Socket.IO for real-time events.
- A suitable WebRTC infrastructure or managed provider for audio/video.
- A managed AI model API accessed through a dedicated backend AI service.
- S3-compatible object storage for attachments and recordings.
- BullMQ with Redis for background jobs when required.
- OpenAPI for API documentation.
- Automated unit, integration and end-to-end testing.

Inspect the installed versions and project configuration before choosing dependency versions. Do not install, replace or upgrade packages unnecessarily.

## 3. Repository Independence

The frontend is maintained in a separate Next.js and TypeScript repository.

- Expose documented APIs for frontend consumption.
- Do not put frontend page or component code in this repository.
- Maintain a clear API contract and consistent response formats.
- Document HTTP endpoints, authentication requirements, permissions and Socket.IO events.
- Keep frontend URLs and deployment settings configurable.
- Do not assume the frontend can access PostgreSQL, Redis, object storage or AI providers directly.

Keep backend code in TypeScript unless an explicit migration plan establishes otherwise.

## 4. Database Architecture

PostgreSQL is the authoritative source of persistent application data.

Use Prisma schemas, migrations, indexes, relational constraints and transactions where appropriate.

Expected domain entities include:

- Users and authentication identities.
- Workspaces and workspace memberships.
- Teams and team memberships.
- Projects and project memberships.
- Tasks, subtasks and task dependencies.
- Comments and task activity.
- Conversations, conversation memberships and messages.
- Message reactions, mentions and attachments.
- Notifications and user preferences.
- Meetings, invitations, participants and call history.
- AI conversations, usage records and generated results where persistence is required.
- Audit events and background-job references where appropriate.

Define explicit relationships, uniqueness constraints and indexes.

Workspace membership and role-based authorization must be enforced for every applicable resource.

Keep task state transitions consistent with the business workflow:

ASSIGNED → IN_PROGRESS → SUBMITTED → UNDER_REVIEW → APPROVED

Support CHANGES_REQUESTED where applicable. Enforce permitted transitions in backend business logic.

Use transactions when related database changes must succeed or fail together.

Do not duplicate the authoritative state of PostgreSQL in Redis.

## 5. Authentication and Authorization

Implement secure authentication and authorization.

- Use the chosen session or JWT architecture consistently.
- Hash passwords using an appropriate password-hashing algorithm.
- Validate credentials and tokens.
- Implement password recovery and email verification where required.
- Enforce workspace, team, project and conversation access.
- Support Owner, Project Manager, Member, Viewer and Collaborator roles according to the defined permission matrix.
- Validate every resource identifier against the requesting user's access.
- Prevent insecure direct object references and cross-workspace data leakage.
- Rate-limit sensitive authentication endpoints.
- Never trust a role, user ID or workspace ID solely because it was supplied by the client.

Document the authentication model and reuse shared authorization middleware or services where practical.

## 6. REST API Design

Use a consistent API structure and versioning strategy where appropriate.

Define:

- Resource-oriented routes.
- Request validation.
- Consistent JSON response formats.
- Standardized HTTP status codes.
- Pagination, filtering and sorting.
- Structured error responses.
- Authentication and authorization requirements.
- Idempotency where retrying a request could cause duplicate actions.

Document endpoints through OpenAPI or equivalent documentation.

Do not create endpoints that are inconsistent with the frontend API contract. Coordinate contract changes explicitly.

## 7. Redis and Caching

Use Redis for temporary, performance-sensitive and coordination-related data.

Expected uses:

- Cache frequently requested workspace and project summaries.
- Cache suitable dashboard statistics.
- Track online presence and short-lived connection state.
- Coordinate distributed rate limits.
- Support Socket.IO event distribution across backend instances when configured.
- Support BullMQ queues for asynchronous work.
- Store temporary state with explicit expiration policies.

Implement a reusable cache service with clear key conventions, expiration and invalidation behavior.

Cache rules:

1. PostgreSQL remains the source of truth.
2. Check authorization before returning protected cached data.
3. Design cache keys to avoid leaking data between users or workspaces.
4. Invalidate or refresh affected cache entries after successful mutations.
5. Avoid caching sensitive data unless the security implications have been evaluated.
6. Handle Redis outages gracefully and define which operations can safely continue without the cache.
7. Set memory limits and appropriate eviction policies in deployment.
8. Never depend on Redis alone for permanent messages, financial-like audit history, or essential application records.
9. Do not introduce caching everywhere without a demonstrated need.

Keep Redis credentials in environment variables and use protected connections in production.

## 8. Real-Time Communication

Use Socket.IO for real-time application events, including:

- New messages and message updates.
- Typing indicators.
- Presence changes.
- Notifications and unread-count updates.
- Task and project updates.
- Call invitations and signaling when required by the calling architecture.
- Background-job progress and AI completion notifications.

Authenticate socket connections and authorize access to each conversation, workspace and room.

Validate event payloads, prevent unauthorized room joins, handle reconnection and avoid leaking private information.

Use a suitable Redis adapter when multiple Socket.IO instances need to exchange events.

Persist messages and other durable events in PostgreSQL before broadcasting success where appropriate. Use reliable event-handling patterns to avoid duplicate or missing updates.

Do not assume Redis Pub/Sub or a Socket.IO event is durable message storage.

## 9. Messaging and Connected Communication

Implement:

- Direct conversations.
- Group conversations.
- Workspace, team and project channels.
- Message creation, editing and deletion according to permissions.
- Replies, threads and reactions.
- Mentions and persistent notifications.
- Read state and unread counts.
- Message search.
- File attachments.
- Task-linked discussions.
- Message-to-task conversion.
- Project decisions and activity history.

Keep message records, conversation memberships and permissions in PostgreSQL.

Ensure message-to-task conversion is validated and avoids unintended duplicate task creation. Preserve appropriate references to the original message and destination task.

## 10. Audio, Video and Meetings

Integrate a suitable managed calling provider or a WebRTC-based infrastructure.

Support, according to the selected provider:

- One-to-one audio calls.
- Video calls and group meetings.
- Meeting creation and invitations.
- Participant authorization.
- Screen sharing.
- Call signaling and connection state.
- Call history and meeting metadata.
- Links between meetings, conversations and projects.

Use the provider's media transport for audio and video. Do not transmit media through normal Socket.IO messages.

Keep provider credentials on the server and issue short-lived access tokens when supported.

Protect meeting access, validate participants and document external service requirements.

Recording and transcription features must account for participant consent, access controls, retention and applicable privacy requirements.

## 11. AI Integration

Implement a dedicated AI service layer rather than embedding model-provider calls throughout controllers.

The AI layer should support:

- Task and project planning.
- Task breakdown and suggested dependencies.
- Project summaries.
- Conversation summaries.
- Meeting summaries and action items.
- Writing assistance.
- Project health and blocker analysis.
- Context-aware question answering.
- Search over authorized workspace information.
- Suggested workflow actions.

Requirements:

1. Keep model-provider API keys server-side.
2. Make the provider configurable without spreading provider-specific code across the application.
3. Validate requests and outputs.
4. Use structured output schemas where reliable application actions depend on AI results.
5. Enforce authorization before retrieving workspace information for AI context.
6. Never include another user's private content in the AI context without permission.
7. Treat model output and retrieved content as untrusted input.
8. Require user approval for consequential actions, including creating, assigning, deleting or modifying records, unless a separately authorized automation explicitly permits them.
9. Implement timeouts, retries where safe, rate limits, usage tracking and cost controls.
10. Handle provider failures and usage limits without breaking core project-management operations.
11. Record sufficient metadata for troubleshooting without logging secrets or unnecessarily storing private prompts and responses.
12. Clearly distinguish suggestions from successfully completed actions.

Use PostgreSQL full-text search initially when appropriate. Introduce `pgvector` or another retrieval mechanism when semantic search and retrieval-augmented generation justify it.

Do not send all workspace data to an AI model by default. Retrieve only the minimum authorized context needed for the request.

## 12. Background Jobs and Automation

Use BullMQ with Redis when asynchronous tasks require a queue.

Suitable jobs include:

- Email and notification delivery.
- AI report generation.
- Meeting transcription and summarization.
- File-processing tasks.
- Scheduled reminders.
- Recurring tasks and periodic reports.

Jobs must support appropriate retries, timeouts, idempotency and failure handling.

Keep durable application records in PostgreSQL. Store job status and results durably when users depend on them being available after Redis data expires.

Do not execute AI-suggested actions without permission checks and appropriate approval.

## 13. Files and Storage

Use object storage for uploaded files and recordings.

Store file metadata, ownership, relationships and access information in PostgreSQL.

Validate file size, content type, access permissions and upload authorization. Use short-lived signed URLs when appropriate.

Do not store large binary files in PostgreSQL or Redis without a specific, justified requirement.

## 14. Security and Reliability

- Validate request payloads and environment configuration.
- Use secure HTTP headers and appropriate CORS policies.
- Apply rate limiting and abuse prevention.
- Protect against injection, insecure object access and mass assignment.
- Avoid exposing stack traces or internal secrets to clients.
- Use centralized error handling and structured logging.
- Keep secrets out of source control and logs.
- Enforce appropriate access controls for AI, files, messages and calls.
- Handle database and Redis outages explicitly.
- Use transactions for related database updates.
- Add health and readiness checks that reflect the required dependencies.
- Avoid logging private message bodies or AI content unless explicitly justified and appropriately protected.

## 15. Testing and Documentation

Write tests for:

- Authentication and authorization.
- Workspace and project isolation.
- Task workflow transitions.
- Database constraints and transactions.
- API validation and error handling.
- Redis caching and invalidation.
- Socket.IO room access and event permissions.
- Message-to-task conversion.
- AI output validation and access control.
- Background-job retries and idempotency.
- File access permissions.

Use mocks for external services where appropriate, but retain integration tests for critical database and API behavior.

Document required environment variables, setup steps, migrations, API endpoints, Socket.IO events, external services and deployment requirements.

## 16. Development Workflow

Before making changes:

1. Inspect the repository and its current structure.
2. Read the existing agent and skill instructions.
3. Inspect dependencies, environment variable names, Prisma schema, migrations, routes, services, middleware and tests.
4. Identify what is already implemented and what is missing.
5. Confirm relevant frontend API contracts.
6. Plan the change before editing files.

During development:

- Work in small, verifiable stages.
- Preserve existing working code unless a change is explicitly required.
- Avoid unrelated refactoring.
- Never overwrite `.env` files or expose their contents.
- Do not run destructive database operations without explicit approval.
- Do not invent credentials, endpoints or provider capabilities.
- Keep TypeScript types and validation consistent.
- Add migrations instead of manually changing production schemas.
- Update documentation and tests with the implementation.

After development:

- Run relevant linting, type checking, tests and build checks.
- Verify migrations and database behavior in a safe environment.
- Report completed work, test results, configuration requirements and remaining limitations.

## 17. Definition of Done

A backend feature is complete when:

- Its business logic is implemented.
- Database changes and migrations are correct.
- Validation, authorization and error handling are present.
- Redis usage and cache invalidation are safe where applicable.
- API and real-time contracts are documented.
- Relevant tests pass.
- External service configuration is documented.
- No secrets have been exposed.
- Existing unrelated functionality remains intact.

Build Nexus as a modular, secure and maintainable platform. Establish the data model, API contracts and authorization foundation first, then add connected communication, AI and advanced real-time features incrementally.