# Nexus Backend — Development Phases

> **Purpose:** Planning and progress-tracking document for the complete Nexus backend. This document is not authorization to implement phases automatically. Work on one phase at a time, only when explicitly instructed.

---

## Progress Dashboard

| Metric | Count |
|---|---|
| **Project** | Nexus Backend |
| **Total phases** | 24 |
| **Completed** `[x]` | 0 |
| **In progress** `[/]` | 0 |
| **Not started** `[ ]` | 24 |
| **Overall progress** | 0% |

_Update this table whenever a phase status changes._

---

## Phase Status Rules

| Symbol | Meaning |
|---|---|
| `[ ]` | Not started |
| `[/]` | In progress |
| `[x]` | Completed and verified |

- A phase may only be marked `[x]` after its deliverables have been reviewed and all verification criteria have passed.
- Writing code does not complete a phase. The behavior must be verified.
- If a phase is partially implemented, record the remaining work in its **Blockers / Notes** field and keep the status as `[/]`.
- Update the Progress Dashboard whenever any phase status changes.
- Do not mark a future phase as in progress before work on it actually begins.

---

## Development Workflow

Follow this cycle for every phase, without exception:

1. Read `AGENTS.md` and the relevant `.opencode/skills/nexus-backend/SKILL.md`.
2. Inspect the existing implementation and confirm all prerequisite phases are complete.
3. Implement only the phase explicitly requested.
4. Reuse the existing architecture and preserve all completed work.
5. Run relevant tests, linting, type-checking, and verification steps.
6. Fix any issues introduced by the implementation before reporting.
7. Update this `PHASES.md` to reflect verified progress.
8. Report completed work, test results, blockers, and the next recommended phase.
9. **Stop and wait for explicit instruction before starting another phase.**

---

## Milestones

| Milestone | Phases | Deliverable |
|---|---|---|
| 1 — Foundation and Infrastructure | 1–4 | Running backend, database schema, authentication, email delivery |
| 2 — Organization and Access Control | 5–7 | Workspaces, invitations, roles, permissions, teams |
| 3 — Project Management | 8–10 | Projects, tasks, reviews, comments, activity history |
| 4 — Files and Collaboration | 11–14 | Uploads, real-time events, messaging, notifications |
| 5 — Productivity | 15–16 | Search, calendars, reminders |
| 6 — Advanced Capabilities | 17–20 | Meetings, AI, automation, reporting, integrations |
| 7 — Production Readiness | 21–24 | Security hardening, tests, deployment, operations |

---

## Phases

### Milestone 1 — Foundation and Infrastructure

---

#### Phase 1 — Foundation and infrastructure `[ ]`

**Objective:** Create a stable, tested backend application shell that safely supports every future Nexus feature.

**Deliverables:**
- Express + TypeScript application with `app.ts` / `server.ts` separation
- Validated environment configuration (`src/config/env.ts`)
- Structured JSON logging, request correlation IDs
- Centralized error handling and request validation middleware
- Security headers, CORS allowlisting, request-body size limits, rate limiting
- PostgreSQL / Prisma connection module
- Redis connection module
- Graceful shutdown with connection cleanup
- Versioned `/api/v1` prefix
- Liveness (`/api/v1/health`) and readiness (`/api/v1/health/ready`) endpoints
- Development, build, lint, type-check, and test scripts
- `.env.example`, `.gitignore`, and `README.md`
- Initial OpenAPI contract (`docs/openapi.yaml`)
- Initial test framework and passing tests

**Dependencies:** None — this is the first phase.

**Verification criteria:**
- Server builds and starts without errors
- Health endpoints return correct status codes
- Environment validation rejects missing required variables
- Tests pass in CI
- No secrets committed to the repository

**Blockers / Notes:** _None recorded._

---

#### Phase 2 — Database architecture and migrations `[ ]`

**Objective:** Define the complete relational foundation for the Nexus platform before implementing business logic.

**Deliverables:**
- Prisma schema with core models: `User`, `UserProfile`, `Workspace`, `WorkspaceMembership`, `Team`, `TeamMembership`, `Project`, `ProjectMembership`, `Task`, `TaskAssignee`, `TaskDependency`, `Comment`, `Notification`, `Invitation`, `FileAttachment`, `AuditLog`, session records
- Foreign keys and appropriate cascade / restrict deletion policies
- Uniqueness constraints (email normalization, duplicate membership prevention)
- Created/updated timestamps on all mutable models
- Account and resource status enums
- Membership role enums
- Soft-deletion or archival columns where recovery is required
- Indexes for workspace, project, task, membership, and activity queries
- Migrations for every schema change
- Seed script for reproducible test data
- Placeholder stubs for future models (messages, meetings, AI usage, integrations) without full implementation

**Dependencies:** Phase 1

**Verification criteria:**
- Fresh database setup runs all migrations without errors
- Seed script populates test data reproducibly
- Uniqueness, foreign-key, and index constraints verified by tests or migration review
- Rollback of migrations tested in a safe environment

**Blockers / Notes:** _None recorded._

---

#### Phase 3 — Authentication and account lifecycle `[ ]`

**Objective:** Build the complete account system from registration through recovery and deletion.

**Deliverables:**
- Registration with email, name, and password; normalized email; hashed password
- `PENDING_VERIFICATION` → `ACTIVE` account status flow
- Secure single-use expiring email-verification tokens
- Resend verification with rate limiting
- Login and logout
- Secure session or JWT lifecycle; refresh and revocation
- Password reset: request, single-use expiring token, apply
- Change password while authenticated; invalidate affected sessions
- Active session tracking; log out other devices
- Secure cookies and CSRF protection where applicable
- Rate limiting on login, registration, password reset, and verification
- Profile retrieval and update
- Email address change with new-address verification
- Account deactivation / deletion with safeguards
- Account status states: active, suspended, pending verification
- Security event logging (login success/failure, credential changes)

**Dependencies:** Phases 1, 2

**Verification criteria:**
- Full register → verify → login → logout flow passes tests
- Expired and reused tokens are rejected
- Password reset revokes prior sessions
- Rate limits block brute-force attempts in tests
- Unverified accounts cannot access protected endpoints

**Blockers / Notes:** _Email delivery depends on Phase 4; stubs required to unblock Phase 3 tests._

---

#### Phase 4 — Transactional email and delivery infrastructure `[ ]`

**Objective:** Make email a reusable platform capability with a provider-agnostic adapter.

**Deliverables:**
- Transactional email provider selected and configured (Resend, Brevo, or Amazon SES)
- Sending-domain DNS verified (SPF, DKIM, DMARC)
- Reusable email service and provider adapter (`src/services/providers/email`)
- Branded responsive HTML and plain-text templates for all required events (see SKILL.md §5)
- Delivery metadata and provider message IDs stored in PostgreSQL
- Background delivery queue where appropriate
- Retry logic for transient failures; deduplication to prevent duplicate sends
- Provider webhook verification and processing (delivery, bounce, complaint)
- Idempotency on send operations
- Integration with: account verification, password reset, password change, email change, workspace invitation, task assignment, mention, meeting invitation
- Logging that excludes verification tokens and sensitive email contents

**Dependencies:** Phases 1, 2, 3

**Verification criteria:**
- Registration and invitation emails arrive end-to-end
- Templates render correctly in both HTML and plain-text
- Failed deliveries are recorded and retried without duplicating operations
- Bounced addresses and complaints are handled
- Verification tokens are not present in application logs

**Blockers / Notes:** _Provider credentials and domain DNS must be configured before production verification._

---

### Milestone 2 — Organization and Access Control

---

#### Phase 5 — Workspaces, memberships and invitations `[ ]`

**Objective:** Let users create and join workspaces and manage invitations securely.

**Deliverables:**
- Create, retrieve, update, archive, and delete workspaces
- Creator assigned initial Owner role on creation
- Add, list, update, and remove workspace members
- Workspace switching and membership-aware queries
- Secure invitation tokens with expiry
- Invite registered users and unregistered email addresses
- Email invitations with workspace name, inviter identity, intended role, expiry, and acceptance link
- Single-use acceptance link; backend validates token and intended recipient before granting access
- Resend, revoke, and expire invitations
- Rejection of expired, revoked, or already-used tokens
- Handle invitee who registers after receiving an invitation
- Handle users already belonging to the workspace
- Notify inviter when invitation is accepted
- Track pending / accepted / expired / revoked invitation states
- Membership changes recorded in audit log

**Dependencies:** Phases 1, 2, 3, 4

**Verification criteria:**
- Workspace creation, invitation, acceptance, cancellation, and member removal work end-to-end
- Expired and revoked links are rejected
- Duplicate invitations handled correctly
- Unauthorized attempts to join are denied
- Invitation email content verified

**Blockers / Notes:** _None recorded._

---

#### Phase 6 — Roles, permissions and authorization `[ ]`

**Objective:** Ensure users can only access and modify resources they are authorized to use.

**Deliverables:**
- Workspace-level roles: Owner, Project Manager, Member, Viewer, Collaborator
- Project-level membership and permission checks
- Team membership and team permissions
- Centralized authorization policies and reusable middleware / service checks
- Permission enforcement for: view, create, edit, delete, archive, assign, approve
- Permission checks extended to files, messages, AI context, and meetings
- Role changes and membership removal
- Workspace ownership transfer rules
- Protection against self-removal that leaves a workspace ownerless
- Explicit access rules for external collaborators and guests
- Audit records for sensitive permission changes

**Dependencies:** Phases 1, 2, 3, 5

**Verification criteria:**
- Automated tests prove unauthorized users cannot read or modify resources across workspace, project, and team boundaries
- Role escalation and cross-workspace access are denied in tests
- Ownership transfer edge cases covered

**Blockers / Notes:** _None recorded._

---

#### Phase 7 — Teams and organizational structure `[ ]`

**Objective:** Support teams within workspaces and make team membership meaningful across the platform.

**Deliverables:**
- Create, update, list, archive, and delete teams
- Add and remove team members; assign team leads
- Team descriptions and settings
- Associate teams with projects and channels where permitted
- Team member and project summary endpoints
- Team deletion with member reassignment; no orphaned data
- Notifications to affected members on team membership or assignment changes
- Workspace boundary enforcement and role-based team administration
- Audit records for team creation, updates, and membership changes

**Dependencies:** Phases 1, 2, 5, 6

**Verification criteria:**
- Full team lifecycle (create → member add → archive → delete) passes tests
- Team permissions enforced in project and communication modules
- Membership change notifications delivered

**Blockers / Notes:** _None recorded._

---

### Milestone 3 — Project Management

---

#### Phase 8 — Projects and project collaboration `[ ]`

**Objective:** Build the project management foundation.

**Deliverables:**
- Create, list, retrieve, update, archive, and delete projects
- Project fields: name, description, status, start date, due date, settings
- Project owner / manager assignment
- Project membership and project-level roles
- Project visibility and access policies
- Project-specific task lists, labels, and custom fields where needed
- Project activity history
- Project overview and summary endpoints
- Filtering, sorting, and pagination
- Project member invitations or workspace-member assignment
- Project status transitions and archival rules
- Notifications when a user is added to a project or key details change

**Dependencies:** Phases 1, 2, 5, 6, 7

**Verification criteria:**
- Project CRUD operations pass tests
- Project resources are isolated per workspace
- Unauthorized users cannot access or modify projects
- Pagination and filter endpoints return correct subsets

**Blockers / Notes:** _None recorded._

---

#### Phase 9 — Tasks, workflow and dependencies `[ ]`

**Objective:** Implement Nexus's core work-tracking engine.

**Deliverables:**
- Create, retrieve, update, archive, and delete tasks
- Task fields: title, description, status, priority, due date, start date, labels, ordering
- Single or multiple assignees per product rules
- Task creator and project association
- Subtasks and parent-child relationships
- Task watchers / subscribers
- Search, filtering, sorting, and pagination
- Workflow states: `ASSIGNED` → `IN_PROGRESS` → `SUBMITTED` → `UNDER_REVIEW` → `APPROVED`; `CHANGES_REQUESTED` supported
- Role-based transition permissions enforced on the backend
- Transition history: who changed status and when
- Review decisions and feedback recorded
- Task dependencies and blockers; circular dependency prevention
- Due-date validation and overdue detection
- Task reassignment and completion rules
- Progress calculation using a documented formula

**Dependencies:** Phases 1, 2, 5, 6, 8

**Verification criteria:**
- All valid workflow transitions pass; invalid transitions are rejected
- Circular dependencies are detected and prevented
- Role-based transition restrictions enforced in tests
- Task search and pagination work correctly

**Blockers / Notes:** _None recorded._

---

#### Phase 10 — Comments, activity history and audit logs `[ ]`

**Objective:** Preserve context behind work and provide accountability.

**Deliverables:**
- Task comments and threaded replies
- Edit and delete policies for comments
- Project discussions and activity entries
- Activity feed with pagination and filters; linked to workspace, project, or task
- User mentions in comments
- Important resource change records: actor, action, target, timestamp, change metadata
- Audit log distinct from user-facing activity feed
- Notifications for replies and relevant updates triggered from this module
- Retention and access policies on audit records
- Ordinary users cannot modify security audit entries

**Dependencies:** Phases 1, 2, 5, 6, 8, 9

**Verification criteria:**
- Activity feed shows correct events in order with correct pagination
- Audit records cannot be edited by non-admin users
- Mentions trigger notifications (requires Phase 14 integration)
- Comment edit/delete policies enforced by role

**Blockers / Notes:** _None recorded._

---

### Milestone 4 — Files and Collaboration

---

#### Phase 11 — File and attachment management `[ ]`

**Objective:** Let users safely upload, retrieve, and share files throughout Nexus.

**Deliverables:**
- S3-compatible object-storage provider configured
- File metadata records in PostgreSQL (uploader, size, content type, storage key)
- Short-lived signed upload and download URLs
- File attachments for tasks, comments, projects, messages, and meetings
- File size, allowed type, and ownership validation
- Storage quotas if required
- Deletion and detachment policies
- Private-file access restricted by authorization checks
- Asynchronous preview / thumbnail generation where appropriate
- Handling for incomplete uploads, missing objects, and storage-provider failures
- Malware scanning hook for production deployments
- No predictable public URLs for private files

**Dependencies:** Phases 1, 2, 5, 6

**Verification criteria:**
- Authorized users can upload and download files
- Unauthorized users cannot obtain private file content by guessing IDs or URLs
- Signed URLs expire and cannot be reused after expiry
- File type and size limits are enforced

**Blockers / Notes:** _Storage provider credentials and bucket configuration required before production verification._

---

#### Phase 12 — Real-time infrastructure and presence `[ ]`

**Objective:** Make Nexus respond to live changes without polling.

**Deliverables:**
- Socket.IO configured alongside Express HTTP server
- Authenticated socket connections
- Authorization before joining workspace, project, or conversation rooms
- Versioned, consistently structured event payloads
- Connection and disconnection handling
- Online presence tracking and last-seen timestamps
- Typing indicators and presence subscriptions
- Task, project, message, and notification events broadcast to authorized rooms
- Reconnect and stale-connection handling; duplicate-event prevention
- Persistent events stored in PostgreSQL before broadcasting
- Redis-backed cross-instance event coordination (Socket.IO adapter) for multi-instance deployments
- Event rate limits and incoming-payload validation

**Dependencies:** Phases 1, 5, 6

**Verification criteria:**
- Authenticated users receive only events for rooms they are authorized to join
- Unauthorized room-join attempts are rejected
- Real-time functionality recovers cleanly after disconnects
- No private event data leaks between workspaces

**Blockers / Notes:** _None recorded._

---

#### Phase 13 — Messaging and connected communication `[ ]`

**Objective:** Connect conversations directly to work.

**Deliverables:**
- Direct conversations, group conversations, workspace/team/project channels, task-linked discussions
- Conversation membership and access permissions
- Create, rename, archive, and manage conversations
- Send, retrieve, and paginate messages
- Edit and delete messages according to policy
- Threaded replies
- Reactions and emoji responses
- File attachments on messages
- @mentions and user resolution
- Typing indicators, read receipts, and unread counts
- Pin important messages
- Message search filtered by conversation or author
- Idempotent message creation to prevent duplicates on retry
- Consistent message ordering and timestamps
- Convert a message to a task; link messages to projects and tasks
- Preserve access control when a user loses membership
- Real-time delivery via Socket.IO (Phase 12)

**Dependencies:** Phases 1, 2, 5, 6, 7, 11, 12

**Verification criteria:**
- Messages persist correctly and are returned in consistent order
- Authorized users receive real-time updates; unauthorized users do not
- Conversation access revoked correctly on membership removal
- Message-to-task conversion does not create duplicates

**Blockers / Notes:** _None recorded._

---

#### Phase 14 — In-app notifications and preferences `[ ]`

**Objective:** Build one notification system that all Nexus modules can use.

**Deliverables:**
- Central notification service
- Persistent notification records in PostgreSQL
- Unread counts and mark-as-read operations
- Mark-all-as-read and optional dismissal / archive
- Real-time notification delivery via Socket.IO
- Notification preferences per user and, where appropriate, per workspace
- Channel preferences: in-app, email, and later push
- Notification categories, priority, and grouping
- Deduplication for repeated events
- Email delivery integration (Phase 4)
- Notification history with pagination
- Scheduled reminders for tasks and meetings
- Preference-aware delivery rules
- Retention and cleanup of old notifications
- Events covered: mentions, task assignment/reassignment/due-soon, review outcomes, comments/replies, membership changes, invitation accepted, meeting events, important project and admin events

**Dependencies:** Phases 1, 2, 4, 5, 6, 9, 10, 12, 13

**Verification criteria:**
- Notification creation is consistent across all producing modules
- Delivery preferences are respected; security-critical messages are not suppressible
- Email send failure does not erase the in-app notification record
- Real-time delivery confirmed over Socket.IO

**Blockers / Notes:** _None recorded._

---

### Milestone 5 — Productivity

---

#### Phase 15 — Search and filtering `[ ]`

**Objective:** Allow users to find information across their authorized workspace data.

**Deliverables:**
- Search users and workspace members
- Search workspaces and projects the current user can access
- Search tasks by title, description, status, assignee, priority, and due date
- Search messages and comments within access permissions
- Filter by team, project, author, status, and date range
- Sorting and pagination on all search results
- Consistent input validation
- PostgreSQL full-text search for suitable text fields
- Appropriate database indexes; query performance reviewed
- Optional saved filters or views
- Semantic search with embeddings / pgvector deferred to a later enhancement

**Dependencies:** Phases 1, 2, 5, 6, 9, 10, 13

**Verification criteria:**
- Search never returns data the user is not authorized to access
- Results are paginated and performant under normal load
- Full-text search indexes confirmed in migration review
- Cross-workspace result leakage tested and absent

**Blockers / Notes:** _None recorded._

---

#### Phase 16 — Calendar, scheduling and reminders `[ ]`

**Objective:** Make deadlines, planned work, and meetings available as coordinated backend data.

**Deliverables:**
- Task start dates and due dates surfaced in calendar queries
- Project timelines
- Calendar event models for independent events where needed
- Meeting scheduling and participant invitations
- Time-zone-aware date and timestamp handling (UTC storage; time-zone context preserved for recurring events)
- Recurring reminders where required
- Upcoming and overdue task queries
- Reminder scheduling, cancellation, and rescheduling (replaces outdated jobs)
- Email and in-app reminders via Phases 4 and 14
- User and workspace calendar settings
- Calendar integration preparation for external providers if required

**Dependencies:** Phases 1, 2, 4, 9, 14

**Verification criteria:**
- Scheduled reminder arrives at the correct time and respects user preferences
- Reminder is not sent after the associated event is cancelled or rescheduled
- Time-zone handling verified with tests using multiple zones
- Overdue detection returns correct task sets

**Blockers / Notes:** _None recorded._

---

### Milestone 6 — Advanced Capabilities

---

#### Phase 17 — Audio/video meetings `[ ]`

**Objective:** Integrate a managed calling provider so users can communicate live.

**Deliverables:**
- Create and schedule meetings; associate with projects, teams, conversations, and tasks
- Add and remove participants
- Secure meeting invitations via email (Phase 4)
- Generate or retrieve provider room identifiers
- Backend authorization for who can create, join, and manage meetings
- Short-lived provider credentials issued through the backend
- Meeting status, start time, end time, and participant records
- Call history endpoints
- Cancellation and rescheduling support
- Real-time events: participant joined/left, meeting started/ended, invitation, cancellation (Phase 12)
- Notifications to participants (Phase 14)
- Provider webhook verification and idempotent processing
- Provider credentials kept server-side
- Recording and transcription deferred: requires consent and access-control design

**Dependencies:** Phases 1, 2, 4, 5, 6, 12, 14, 16

**Verification criteria:**
- User can create a meeting, invite participants, obtain authorized credentials, and join via managed SDK
- Unauthorized users are denied access to meeting rooms
- Meeting history records are accurate
- Provider webhooks verified and processed idempotently

**Blockers / Notes:** _Calling provider selection and credentials required before production verification._

---

#### Phase 18 — AI services and workspace intelligence `[ ]`

**Objective:** Introduce AI features using a managed API, keeping authorization and costs under control.

**Deliverables:**
- Provider adapter and configurable model selection (`src/services/providers/ai`)
- Dedicated AI service layer
- Secure server-side provider credentials
- Request validation, timeouts, retries for safe failures, rate limits
- Input and output size limits
- Structured output validation
- Usage, latency, error, and cost tracking
- User and workspace quotas
- Safe handling of provider failures and unavailable models
- Prompt versioning; tests for critical AI workflows
- Features: task planning from project goals, task breakdown, dependency suggestions, draft descriptions, project/task/conversation summaries, meeting summaries, blocker and workload analysis, authorized workspace Q&A, workflow suggestions
- Authorization check before retrieving any workspace context
- Retrieval limited to minimum authorized data
- Untrusted-input treatment for retrieved messages, files, and user content
- Human confirmation required before consequential actions (create, delete, invite, etc.)
- No prompt-injection bypass of application permissions
- Transparent errors on AI request failures

**Dependencies:** Phases 1, 2, 5, 6, 9, 13, 17

**Verification criteria:**
- AI features enforce workspace permissions; unauthorized context is not retrieved
- Usage quotas enforced and exceeded-quota errors handled gracefully
- Provider failure does not break core project-management operations
- Consequential actions require explicit user confirmation in tests

**Blockers / Notes:** _AI provider API key required before production verification._

---

#### Phase 19 — Automation and background jobs `[ ]`

**Objective:** Move slow, scheduled, and retryable work out of HTTP request handlers.

**Deliverables:**
- BullMQ workers with Redis queues for: email delivery, task/meeting reminders, invitation expiry, AI summaries, file processing/thumbnails, notification fan-out, scheduled reports, data cleanup/retention, webhook delivery, provider reconciliation
- Retry and exponential-backoff policies per job type
- Dead-letter / failed-job handling and recovery process
- Idempotent job handlers
- Job status tracking and operational metrics
- Queue concurrency limits
- Graceful worker shutdown
- Transactional outbox pattern for critical database changes that must reliably trigger async events

**Dependencies:** Phases 1, 2, 4, 9, 14, 17, 18

**Verification criteria:**
- Temporary provider outage does not permanently lose work; jobs retry correctly
- Jobs are idempotent — retrying does not duplicate messages, emails, or business operations
- Dead-letter queue captures unrecoverable failures
- Graceful shutdown confirmed under load

**Blockers / Notes:** _None recorded._

---

#### Phase 20 — Integrations and webhooks `[ ]`

**Objective:** Allow Nexus to exchange events and data with external systems.

**Deliverables:**
- Standard integration / provider interface
- Secure credential storage for integrations
- Webhook registration and revocation
- Signed outgoing webhooks
- Incoming webhook signature validation
- Retry, deduplication, and delivery history for outgoing webhooks
- Integration permission scopes
- Audit logs for integration changes
- Event subscriptions for task creation, project updates, and other useful events
- Integration health and failure reporting
- Specific integrations (calendar, identity, file services, project tools) implemented only when a clear product requirement exists

**Dependencies:** Phases 1, 2, 5, 6, 9, 19

**Verification criteria:**
- Integrations can be authorized, revoked, and retried
- Outgoing webhook signatures verified by a test receiver
- Duplicate webhook delivery handled idempotently
- Integration credentials are not exposed in API responses or logs

**Blockers / Notes:** _None recorded._

---

### Milestone 7 — Production Readiness

---

#### Phase 21 — Security, reliability and performance hardening `[ ]`

**Objective:** Verify and strengthen the complete system's security posture and operational resilience.

_Security is implemented from Phase 1. This phase audits and hardens the whole platform._

**Deliverables:**
- Centralized authentication and authorization audit
- Input validation and output shaping review across all routes
- SQL-injection protection verified via safe ORM usage
- XSS and CSRF defenses reviewed
- CORS restrictions and HTTP security headers reviewed
- Request-size and upload limits reviewed
- Rate limiting on sensitive and expensive endpoints
- Secure password hashing and session management review
- Secret management and rotation procedures documented
- Brute-force and account-enumeration protection verified
- Safe production error responses (no stack traces or secrets)
- Workspace and project access checks on all applicable endpoints
- Resource-level authorization for tasks, messages, files, AI, and meetings
- Cross-workspace data-leakage tests
- Safe membership removal and ownership transfer edge cases
- Explicit access policies for archived resources and external collaborators
- Database indexes and query-performance analysis
- Connection pooling and transaction management review
- Redis timeouts, cache invalidation, and graceful degradation
- HTTP and provider timeout configuration
- Retry policies reviewed for idempotency
- Socket and worker resource management
- Database backup and restore procedures exercised (not merely documented)
- Dependency and vulnerability scan
- Log redaction and sensitive-data handling
- Account deletion, data-retention, and export rules
- AI data handling and provider-retention policy review
- Meeting recording and transcription consent review
- Audit-log retention and access controls
- Incident response procedures documented

**Dependencies:** All prior phases

**Verification criteria:**
- Security tests cover critical permission boundaries
- Cross-workspace access is denied in automated tests
- Backup and restore procedure successfully exercised in a staging environment
- No known high-severity vulnerabilities in dependency scan
- Incident response runbook exists

**Blockers / Notes:** _None recorded._

---

#### Phase 22 — Testing and quality assurance `[ ]`

**Objective:** Verify the backend behaves correctly across all modules and integrations.

**Deliverables:**
- Unit tests: business logic, permission policies, workflow transitions
- Integration tests against a real test PostgreSQL database
- Redis integration tests: cache, rate limits, queue behavior
- API tests for every major route
- Authentication, session expiry, and password-reset tests
- Workspace and project authorization tests
- Email template, invitation, and delivery-retry tests
- Socket.IO authorization and event-delivery tests
- File access and signed-URL tests
- AI provider mocking and output-validation tests
- Calling-provider webhook and meeting-permission tests
- Background job retry and idempotency tests
- Load tests for important endpoints and real-time connections
- Migration and fresh-environment tests
- End-to-end tests for critical workflows (see SKILL.md §4 Phase 22)
- CI checks for linting, formatting, type-checking, and tests

**Critical end-to-end scenarios covered:**
1. Register → receive email → verify → login
2. Owner invites user → email received → invitation accepted
3. Project Manager creates project → assigns task → submits for review
4. Reviewer approves or requests changes
5. User mentions teammate → notification delivered
6. Authorized upload and download of private file
7. Schedule meeting → invite participants → join via calling provider
8. AI summarizes an accessible project
9. Unauthorized user is denied access to another workspace's tasks, files, messages, and AI context
10. Email and AI provider outage occurs → system recovers per retry policy

**Dependencies:** All prior phases

**Verification criteria:**
- Critical user journeys pass in CI
- No major feature is considered complete based solely on manual demonstration
- Test failures are reproducible and traceable to specific changes

**Blockers / Notes:** _None recorded._

---

#### Phase 23 — Deployment, monitoring and operations `[ ]`

**Objective:** Make the complete backend production-ready and maintainable.

**Deliverables:**
- Separate development, staging, and production environments
- Production PostgreSQL and Redis provisioned
- Secure deployment-time environment configuration
- Automated build, test, and deployment pipelines (CI/CD)
- Controlled database migration strategy for deployments
- API health, readiness, and dependency checks in production
- Centralized logs and error monitoring
- Metrics: request latency, error rates, database performance, queue depth
- Alerts for repeated failures and service degradation
- Email delivery, AI usage, and calling-provider monitoring
- Database backup scheduling and restore verification
- Worker and scheduled-job deployment
- Socket.IO deployment configuration; Redis shared adapter for multi-instance
- HTTPS, domain, and CORS configuration
- Deployment rollback procedure
- Dependency update and security patch process
- Operational documentation and runbooks

**Dependencies:** Phases 1, 4, 17, 18, 19, 21, 22

**Verification criteria:**
- Backend can be deployed from a clean checkout without manual steps
- Health endpoints reflect true dependency status in production
- Backup and restore exercise completed on staging
- Alert rules fire correctly under simulated failure conditions
- Rollback procedure tested

**Blockers / Notes:** _Cloud provider and infrastructure choices must be confirmed before this phase begins._

---

#### Phase 24 — Production verification and ongoing operations `[ ]`

**Objective:** Validate the complete platform through production-readiness checks and establish ongoing operations.

**Deliverables:**
- Production-readiness checklist completed
- Critical user journeys executed against production or production-equivalent environment
- Load test results within acceptable thresholds
- Backup restoration verified in production or production-equivalent environment
- Incident response procedures exercised (tabletop or simulation)
- Provider failure simulations run and recovery confirmed
- Operational documentation finalized: architecture, runbooks, escalation paths
- Monitoring dashboards reviewed and thresholds tuned
- Post-launch: dependency patching schedule established
- Post-launch: regular backup verification schedule established
- Post-launch: periodic load and reliability reviews scheduled

**Dependencies:** Phases 21, 22, 23

**Verification criteria:**
- All critical user journeys pass in the production environment
- Load test results documented and within agreed SLAs
- Backup restoration confirmed with timing recorded
- At least one incident simulation completed with a written outcome
- Operational documentation reviewed by a second party

**Blockers / Notes:** _None recorded._


---

## Project Decisions and Blockers

### Current Phase

**Current phase:** Not started — Phase 1 is the next phase to begin.

---

### Outstanding Blockers

_No blockers recorded._

---

### Known Issues

_No issues recorded._

---

### Important Architecture Decisions

| Decision | Status | Notes |
|---|---|---|
| Authentication strategy (JWT vs session) | Not yet determined | To be decided in Phase 3 |
| Transactional email provider | Not yet determined | To be decided in Phase 4 |
| Calling / audio-video provider | Not yet determined | To be decided in Phase 17 |
| AI model provider | Not yet determined | To be decided in Phase 18 |
| S3-compatible storage provider | Not yet determined | To be decided in Phase 11 |
| Background job queue (BullMQ confirmed) | Confirmed — BullMQ with Redis | Per AGENTS.md and SKILL.md |
| ORM (Prisma confirmed) | Confirmed — Prisma | Per AGENTS.md and SKILL.md |
| Real-time layer (Socket.IO confirmed) | Confirmed — Socket.IO | Per AGENTS.md and SKILL.md |
| Multi-instance Redis Socket.IO adapter | Required when scaling beyond one instance | Phase 12 deliverable |

---

### Deferred Work

| Item | Deferred to | Reason |
|---|---|---|
| Semantic search / pgvector | Post-Phase 15 enhancement | PostgreSQL full-text search sufficient for initial launch |
| Meeting recording and transcription | Post-Phase 17, requires consent design | Consent and privacy requirements must be defined first |
| External calendar integrations | Phase 20 or later | Product requirement not yet confirmed |
| Push notifications | Post-Phase 14 enhancement | In-app and email notifications sufficient for initial launch |
| Saved search filters / views | Post-Phase 15 enhancement | Basic search required first |

---

### Verification Notes

_No verification results recorded. This section is updated as phases are completed and verified._

---

_Last updated: 2026-10-21. This document reflects the planning state only. No phases have been implemented or verified._
