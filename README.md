# NEXUS BACKEND

## Real-Time Workspace & Project Management Platform

The Nexus backend powers the application's business logic, authentication, authorisation, workspace management, project management, real-time messaging, notifications, file management, integrations, billing, automation, and AI orchestration.

It provides the APIs and services consumed by the Nexus frontend and coordinates communication with external services.

The backend is designed to be secure, scalable, maintainable, and suitable for a multi-workspace productivity platform.

---

# 1. Project Overview

Nexus is a Real-Time Workspace & Project Management Platform combining:

- Project and task management.
- Team collaboration.
- Real-time messaging.
- Document and file management.
- Calendar and scheduling.
- Audio and video meetings.
- Forms and surveys.
- Subscription and billing.
- Third-party integrations.
- Workflow automation.
- AI-powered productivity.
- Writing assistance.

Nexus supports three workspace types:

1. Individual.
2. Company.
3. Institution.

All workspace types share the same core backend architecture.

Workspace type, subscription plan, membership, role, and permissions determine which resources and capabilities are available.

## Core product principles

- One Nexus identity per user.
- Multiple workspace memberships.
- Personal and organisational data separation.
- Strong workspace isolation.
- Server-side permission enforcement.
- Real-time collaboration.
- Durable data storage.
- Explicit approval for AI mutations.
- Secure integrations.
- Scalable event processing.

---

# 2. Backend Technology Stack

The backend architecture uses the following technology categories.

| Area | Technology |
|---|---|
| Runtime | Node.js |
| Main language | TypeScript |
| Framework | Express.js |
| Primary database | PostgreSQL |
| Cache and coordination | Redis |
| Real-time communication | Existing WebSocket infrastructure |
| Background processing | Existing queue/job infrastructure |
| File storage | Private object storage |
| AI service | Python and FastAPI |
| AI provider | Managed AI APIs |
| Email delivery | Approved email provider |
| Payment processing | Approved payment provider |
| Calling | Managed audio/video SDK |

**Important:** The exact ORM, migration framework, queue library, WebSocket implementation, provider names, and package versions must be determined from the actual repository.

Do not replace existing technology choices without approval.

---

# 3. Backend Architecture

Nexus uses a modular backend architecture.

The Express.js and TypeScript application is the authoritative application backend.

It handles:

- Authentication.
- Authorisation.
- User management.
- Workspace management.
- Membership.
- Roles and permissions.
- Projects.
- Tasks.
- Messaging.
- Notifications.
- File access.
- Documents.
- Calendar.
- Meetings.
- Forms.
- Billing.
- Integrations.
- Automation.
- AI request orchestration.
- Audit logging.

The Python/FastAPI service is a separate AI processing service.

It must not become an alternative application backend or bypass the Express application's security model.

## Architectural responsibilities

### Express application backend

Responsible for application workflows, permission enforcement, validation, persistence, API delivery, and orchestration.

### PostgreSQL

The durable source of truth for application data.

### Redis

Supports:

- Caching.
- Rate limiting.
- Real-time coordination.
- Ephemeral state.
- Background queue infrastructure.
- Distributed coordination where needed.

Redis must not replace PostgreSQL as the permanent source of truth for messages, notifications, or other durable business records.

### Object storage

Stores uploaded files and other media.

Use private storage and backend-authorised access.

### Python AI service

Provides AI processing through managed AI APIs.

### External providers

Provide specialised services such as:

- Email delivery.
- Payments.
- Audio/video calling.
- Calendar integrations.
- File integrations.
- AI inference.

---

# 4. Backend Architecture Principles

The backend must follow these principles:

1. Modular and maintainable design.
2. Strong TypeScript typing.
3. Server-side authorisation.
4. Workspace-aware data access.
5. Clear separation of concerns.
6. Centralised validation.
7. Secure API design.
8. Durable data persistence.
9. Reliable event processing.
10. Idempotent background operations where appropriate.
11. Structured logging.
12. Automated testing.
13. Scalable infrastructure.
14. Explicit AI action approval.
15. Backward-compatible changes where practical.

The existing repository architecture is authoritative for implementation decisions.

---

# 5. Main Backend Components

A logical module organisation may include:

- Authentication.
- Users.
- Workspaces.
- Membership.
- Invitations.
- Join requests.
- Roles and permissions.
- Departments.
- Teams and groups.
- Projects.
- Tasks.
- Messaging.
- Channels.
- Notifications.
- Activity feed.
- File management.
- Documents.
- Calendar.
- Meetings.
- Forms and surveys.
- Billing.
- Search.
- Integrations.
- Automation.
- AI.
- Nexus Write.
- AI action execution.
- Background jobs.
- Email delivery.
- Audit logging.
- Analytics.

This is a logical module list, not a requirement to create a new directory structure when equivalent modules already exist.

---

# 6. User Identity and Authentication

Nexus uses one identity per user.

A user may belong to multiple workspaces without creating multiple accounts.

The authentication system must support the existing approved authentication methods.

Expected capabilities include:

- Registration.
- Sign-in.
- Email verification.
- Password recovery.
- Password reset.
- Session management.
- Logout.
- Token or cookie-based authentication according to the existing architecture.
- OAuth where supported.
- Security-related account operations.

## Authentication requirements

- Secure password hashing.
- Appropriate session or token handling.
- Secure cookie configuration where applicable.
- Expiration and revocation.
- Rate limiting.
- Input validation.
- Authentication event logging where appropriate.
- Protection against brute-force attacks.
- Safe account recovery.

Authentication must be implemented and enforced server-side.

Never trust frontend authentication state as proof of access.

### Account deletion lifecycle

`POST /auth/delete` requires an authenticated session, the current password,
and an exact email confirmation. It revokes the user's sessions and unused
authentication tokens, marks the account `PENDING_DELETION`, and schedules
permanent deletion 30 days later. The account and its personal workspace stay
intact during this recovery period. The account is signed out immediately and
cannot use normal authenticated routes.

Before the scheduled date, the user can cancel deletion through
`POST /auth/reactivate` using the account email and password. Recovery clears
the deletion schedule but never restores revoked sessions; the user must sign
in again. The worker permanently removes the personal workspace and its
workspace-scoped records, removes shared-workspace memberships and access,
revokes pending invitations, and replaces the account identity with the
neutral `Deleted user` identity so shared history retains valid references.
Company and Institution workspaces are never deleted as part of account
deletion. Their owners must transfer ownership before requesting deletion;
the last active organization administrator cannot leave without another
active owner or administrator.

The backend currently has file metadata but no object-storage deletion
adapter. A due deletion is therefore held when the personal workspace contains
file attachments, preserving the metadata rather than orphaning storage
objects. Storage cleanup must be integrated with the existing provider when
that provider is implemented.

---

# 7. Workspace Architecture

Nexus supports three workspace types.

## Individual workspace

Provides personal productivity and collaboration.

Email verification provisions one private personal workspace for each
activated account. It is marked internally as personal, cannot be archived or
deleted separately, and is removed only when the account's 30-day deletion
period completes. Ordinary `INDIVIDUAL` workspaces remain distinct from this
personal workspace marker.

## Company workspace

Provides organisational collaboration for businesses.

## Institution workspace

Provides collaboration for institutions, including departments, groups, staff, and students.

Foundational Company and Institution profile fields are tracked in Phase 4.
Company-specific and Institution-specific profile APIs, branding uploads,
notification preferences, and full organization settings are deferred to the
later organization-management work in the roadmap; no subscription or pricing
rules are defined here.

### Workspace functionality

- Creation.
- Updating.
- Archiving.
- Restoration where supported.
- Settings.
- Branding.
- Membership.
- Invitations.
- Subscription management.
- Workspace switching context.
- Access control.

### Workspace isolation

Every workspace-scoped operation must verify that the requesting user has access to the relevant workspace.

Never rely exclusively on a client-provided workspace ID.

Workspace isolation must be enforced in service logic and database queries.

---

# 8. Membership, Invitations, and Join Requests

Nexus supports organisational discovery and membership workflows.

## Join requests

- Users can discover organisations through supported search and invitation mechanisms.
- Organisations can provide links or codes.
- Matching email domains alone do not automatically grant membership.
- Join requests require administrator approval.
- Pending applicants cannot access private workspace content.
- Applicants can withdraw requests where supported.
- Join requests expire after seven days.
- Expired applicants can be notified and may submit a new request.

## Direct invitations

- Direct invitations expire after 48 hours.
- Expiration is enforced server-side.
- Expired invitations cannot be accepted.
- Administrators can resend invitations with a new expiry.
- Invitations can be revoked.

## Membership statuses

- Pending.
- Approved.
- Rejected.
- Withdrawn.
- Expired.

## Membership rules

- Organisation membership is separate from team membership.
- Users may belong to multiple teams.
- Users may belong to an organisation without team assignment.
- Removing organisation membership must not delete the user's Nexus identity.
- Personal workspaces must remain independent.
- Organisation assets and audit history must be preserved.
- Assigned tasks and responsibilities must be handled appropriately when membership changes.

---

# 9. Roles and Permissions

Permissions must be enforced in the backend.

Organization roles are stored on workspace memberships, never globally on a
user. Company workspaces use `COMPANY_OWNER`, `COMPANY_ADMIN`,
`COMPANY_PROJECT_MANAGER`, `COMPANY_MEMBER`, `COMPANY_COLLABORATOR`, and
`COMPANY_VIEWER`. Institution workspaces use `INSTITUTION_OWNER`,
`INSTITUTION_ADMIN`, `INSTITUTION_DEPARTMENT_HEAD`,
`INSTITUTION_LECTURER_STAFF`, `INSTITUTION_STUDENT`,
`INSTITUTION_COLLABORATOR`, and `INSTITUTION_VIEWER`.

These roles map into the existing centralized workspace, project, and team
policies; they do not replace them or grant implicit access to every project or
team. Organization-role members need explicit project/team assignment.
Institution Department Heads are further limited to departments where they
have department-head membership. Existing persisted `OWNER`,
`PROJECT_MANAGER`, `MEMBER`, `COLLABORATOR`, and `VIEWER` roles remain valid in
their existing contexts. Multiple organization owners are supported and the
last owner cannot be removed or demoted through member management. Custom
organization role definitions and permission builders are deferred to a later
phase.

## Company roles

- `COMPANY_OWNER`.
- `COMPANY_ADMIN`.
- `COMPANY_PROJECT_MANAGER`.
- `COMPANY_MEMBER`.
- `COMPANY_COLLABORATOR`.
- `COMPANY_VIEWER`.

## Institution roles

- `INSTITUTION_OWNER`.
- `INSTITUTION_ADMIN`.
- `INSTITUTION_DEPARTMENT_HEAD`.
- `INSTITUTION_LECTURER_STAFF`.
- `INSTITUTION_STUDENT`.
- `INSTITUTION_COLLABORATOR`.
- `INSTITUTION_VIEWER`.

### Confirmed permission rules

- Admins may remove ordinary members and guests.
- Only the Owner can remove or demote another administrator.
- Admins cannot remove the Owner.
- Team Leads cannot remove organisation members unless explicitly granted permission.
- Owner retains ultimate control.
- Organisation membership and team membership are separate.
- Organisation Admin does not automatically grant access to private projects.

### Security requirements

- Enforce permissions in services and resource queries.
- Never rely only on route-level checks.
- Prevent privilege escalation.
- Prevent insecure direct object references.
- Prevent cross-workspace data leakage.
- Verify resource ownership and membership.
- Revalidate permissions for sensitive operations.
- Log relevant administrative changes.

Permission logic should be centralised and reusable.

---

# 10. Departments, Teams, and Groups

The backend supports organisational structures.

### Company

- Departments.
- Teams.
- Team membership.
- Team Leads.
- Department administration.

### Institution

- Departments.
- Groups.
- Group membership.
- Staff and student distinctions where supported.
- Department administration.

Users may belong to multiple teams or groups.

Do not automatically assign every organisation member to a team.

---

# 11. Project Management

Projects are shared collaboration resources.

## Project visibility

The backend must support:

1. Organisation-wide.
2. Department/team-only.
3. Private/invitation-only.

### Project functionality

- Project creation.
- Project updates.
- Project archiving.
- Project membership.
- Project settings.
- Project activity.
- Project discussions.
- Project files.
- Project milestones.
- Project timeline.
- Project insights.

### Visibility enforcement

Project visibility must also apply to associated resources:

- Tasks.
- Files.
- Documents.
- Messages.
- Meetings.
- Activity.
- Search results.

Changing project visibility must not accidentally expose previously private information.

All project-related queries must enforce access permissions.

---

# 12. Task Management

The task system supports project and general work management.

### Task capabilities

- Title.
- Description.
- Status.
- Priority.
- Creator.
- Responsible owner.
- Multiple assignees where supported.
- Start date.
- Due date.
- Subtasks.
- Checklists.
- Comments.
- @mentions.
- Attachments.
- Labels.
- Dependencies.
- Activity history.
- Completion and reopening.

### Task views

The backend provides data required for:

- Board.
- List.
- Timeline.
- Calendar.

These views must operate on the same underlying task records.

### Additional requirements

- Task permissions must respect project visibility.
- Task assignment must validate membership and eligibility.
- Task updates must produce relevant events.
- Task history must be preserved according to the approved retention model.
- Message-to-task conversion must preserve the original message or conversation reference.

---

# 13. Messaging and Conversations

Nexus provides real-time communication.

## Conversation types

- Direct messages.
- Group conversations.
- Team channels.
- Project conversations.
- Announcements.

## Messaging capabilities

- Sending and retrieving messages.
- Replies and threads.
- Reactions.
- @mentions.
- Editing.
- Deletion.
- Attachments.
- Pinned messages.
- Saved messages.
- Read indicators.
- Typing indicators.
- Presence.
- Conversation search.

## Channel management

- Owners have full control.
- Admins manage channels according to their permissions.
- Team Leads may manage assigned team channels when authorised.
- Members cannot create channels by default.
- Guests access explicitly shared channels only.

### Message-to-task conversion

The backend should support converting eligible messages into tasks while preserving the relationship to the original conversation.

### Security

- Verify conversation membership.
- Verify channel access.
- Verify project visibility.
- Prevent cross-workspace message access.
- Validate all message operations.
- Enforce edit and deletion permissions.

---

# 14. Notification and Activity Architecture

Nexus has two distinct communication surfaces.

1. Messages.
2. General notifications.

These must remain separate.

## General notifications

Examples:

- Task assignments.
- Task-comment mentions.
- Meeting invitations and changes.
- Join request decisions.
- Directly shared files.
- Security and access changes.

## Messages

Direct messages, group messages, channel messages, and message @mentions belong to the messaging system.

### Critical separation requirement

Message events must not be added to the general notification bell.

The backend must maintain independent unread states for:

- General notifications.
- Direct and group messages.
- Channel messages.

### Notification infrastructure

Support:

- Durable notification persistence.
- Read and unread states.
- Mark-as-read.
- Mark-all-as-read.
- Notification preferences.
- Real-time delivery.
- Email delivery where configured.
- Deduplication.
- Bounded retries.
- Activity feed.
- Appropriate retention.

Use a centralised event and notification architecture where practical.

Do not create duplicate notification records when background jobs retry.

---

# 15. File Management and Nexus Drive

The backend provides secure file management.

### Capabilities

- File uploads.
- File metadata.
- Folder management.
- File listing.
- File downloads.
- File preview access.
- File sharing.
- Access control.
- File deletion.
- Restoration where supported.
- Version history where supported.
- Storage usage tracking.

### Storage architecture

Use private object storage.

The backend should manage:

- Upload authorisation.
- Object metadata.
- Signed URLs or streaming.
- Download permissions.
- File ownership.
- Workspace association.
- Project association.
- File deletion.
- Storage limits.

### Security requirements

- Never expose storage credentials.
- Never assume a file URL grants access.
- Verify file permissions before download.
- Validate file metadata and supported content types.
- Apply upload size restrictions.
- Use appropriate scanning or security controls where configured.
- Preserve access boundaries across workspaces.

---

# 16. Document Collaboration

Nexus supports document creation and collaboration.

Expected capabilities:

- Document creation.
- Document editing.
- Document listing.
- Document sharing.
- Comments.
- Version history.
- Access controls.
- Search.
- Workspace and project associations.

The backend must define the authoritative document storage and collaboration model.

Do not introduce a separate document persistence architecture without approval.

---

# 17. Calendar and Scheduling

The backend supports Nexus calendar functionality.

### Features

- Event creation.
- Event updates.
- Event deletion.
- Event invitations.
- Participant management.
- Personal calendars.
- Workspace calendars.
- Calendar aggregation.
- Event privacy.
- Calendar synchronisation.

### External integrations

- Google Calendar.
- Microsoft Outlook Calendar.

## Two-way synchronisation

Calendar synchronisation must support changes in both directions.

### Requirements

- OAuth.
- Secure token storage.
- Token refresh.
- Event mapping.
- Duplicate prevention.
- Conflict detection.
- Updates.
- Deletions.
- Sync history.
- Origin tracking.
- Idempotency.
- Loop prevention.

### Privacy

Private event details must not be exposed to unauthorised workspace members.

---

# 18. Meetings and Calling

Nexus uses a managed audio/video calling SDK.

The backend coordinates:

- Meeting creation.
- Meeting scheduling.
- Meeting invitations.
- Participant authorisation.
- Meeting access.
- Meeting metadata.
- Project association.
- Meeting lifecycle.
- Meeting history.

The calling provider handles the specialised real-time media infrastructure.

### Additional capabilities

- Audio calls.
- Video calls.
- Group meetings.
- Screen sharing.
- Meeting chat.
- Participant management.
- Meeting summaries and action items where supported.

Do not replace the existing approved calling SDK without explicit approval.

---

# 19. Forms and Surveys

The backend supports form and survey functionality.

### Capabilities

- Form creation.
- Form editing.
- Field configuration.
- Validation.
- Publishing.
- Access control.
- Response submission.
- Response storage.
- Response management.
- Survey results.

Ensure that response access is permission-controlled.

---

# 20. Subscription and Billing

Nexus supports individual and organisational subscription models.

## Individual

- Free.
- Premium.

## Company and Institution

- Free and paid plans.

### Subscription functionality

- Subscription creation.
- Trial management.
- Plan changes.
- Billing.
- Payment methods.
- Renewal.
- Cancellation.
- Invoices.
- Usage limits.
- Subscription status.

### Business rules

- Premium trial lasts 14 days.
- No card is required to start the trial.
- Trial expiration must not silently convert a user to paid.
- Subscription requires active user consent.
- Monthly and yearly billing.
- Organisation billing is controlled by the Owner.
- Organisation members do not separately pay for organisation features.
- Personal subscription is independent of organisational subscription.
- Leaving an organisation does not remove the personal workspace.
- Organisation plans control organisation features and limits, not personal plans.
- Downgrading must preserve existing data.
- Over-limit features may be restricted without deleting data.
- Ownership transfer must explicitly handle billing ownership.

### Payment security

- Use the approved payment provider.
- Never store raw card details or CVV.
- Use provider tokenisation.
- Validate payment webhooks.
- Verify webhook signatures.
- Ensure idempotent payment processing.
- Keep billing records auditable.

Pricing, seat counting, and institution-specific allowances must follow approved product decisions rather than assumptions.

---

# 21. Global Search and Full Document Search

Nexus provides global search across authorised resources.

### Search categories

- People.
- Workspaces.
- Teams.
- Projects.
- Tasks.
- Messages.
- Conversations.
- Files.
- Documents.
- Meetings.
- Announcements.

### Full document search

Search should cover:

- File names.
- Metadata.
- Readable document contents.
- Supported PDF documents.
- Word documents.
- Text files.
- Other approved document formats.

### Initial search architecture

PostgreSQL full-text search is the initial approach unless the existing implementation or performance requirements justify another engine.

### Security requirements

- Filter results by permissions.
- Do not expose private documents.
- Update indexes after creation and editing.
- Handle deletion.
- Handle permission changes.
- Revoke access when membership is removed.
- Respect project visibility.

Search must never become a way to bypass resource access controls.

---

# 22. Integrations Framework

Nexus supports personal and workspace integrations.

### Planned integrations

- Google Drive.
- Microsoft OneDrive.
- Dropbox.
- Gmail.
- Microsoft Outlook.
- Slack.
- Microsoft Teams.
- Google Calendar.
- Microsoft Outlook Calendar.
- GitHub.
- GitLab.
- Webhooks and automation providers.

### Integration architecture

- OAuth.
- Secure token storage.
- Token refresh.
- Permission scopes.
- Connection status.
- Disconnection.
- Sync history.
- Error handling.
- Webhook processing.
- Workspace-level configuration.

### Important rules

- Personal connections and shared workspace connections are separate.
- Personal account connections must not automatically become workspace connections.
- Use least-privilege OAuth scopes.
- Securely revoke and refresh tokens.
- Disconnecting an integration must not delete provider data.

---

# 23. Automation and Workflow Engine

Nexus includes an automation and workflow system.

### Capabilities

- Workflow creation.
- Trigger definitions.
- Conditions.
- Actions.
- Execution.
- Scheduling.
- Activation and deactivation.
- Execution history.
- Error tracking.
- Permission checks.

Automation must execute through approved backend services.

Ensure that workflow execution is secure, auditable, and idempotent where appropriate.

---

# 24. Python AI Service

Nexus uses a separate Python/FastAPI service for AI processing.

The Python service is independently deployable and communicates with the Express backend through an approved service interface.

## AI capabilities

- AI conversations.
- Contextual assistance.
- Retrieval-augmented generation.
- Document analysis.
- Summarisation.
- Meeting intelligence.
- Writing assistance.
- Grammar correction.
- Tone adjustment.
- Recommendations.
- AI action proposals.

## Responsibility separation

### Express backend

- Authenticates the user.
- Checks permissions.
- Prepares authorised context.
- Coordinates AI requests.
- Validates approved mutations.
- Executes application changes.
- Persists application data.

### Python service

- Performs AI processing.
- Communicates with managed AI APIs.
- Processes supplied context.
- Produces structured AI outputs.
- Generates recommendations and proposed actions.

### Important security rules

- Python must not independently bypass Express authorisation.
- Python must not directly mutate the main application database by default.
- AI must not be trusted as an authority for user permissions.
- AI outputs must be validated.
- Core application functionality must continue when the AI service is unavailable.

---

# 25. Nexus Write

Nexus Write provides Grammarly-like writing assistance.

### Capabilities

- Spelling.
- Grammar.
- Punctuation.
- Clarity.
- Vocabulary.
- Tone.
- Rewriting.
- Summarisation.
- Translation.
- Explanation.

### Backend requirements

- Accept approved writing analysis requests.
- Validate user access.
- Process text through the AI service.
- Return structured suggestions.
- Support selected-text workflows.
- Respect retention and privacy rules.
- Avoid unnecessary storage of private text.

The backend must not silently overwrite user content.

Suggestions are returned for user review and explicit acceptance through the frontend.

---

# 26. AI Action Approval and Execution

Nexus AI can propose changes to application data.

Examples:

- Creating tasks.
- Updating tasks.
- Assigning tasks.
- Creating projects.
- Creating calendar events.
- Updating supported resources.

### Required workflow

1. AI generates a proposed action.
2. Express validates the proposed action structure.
3. The proposal is returned to the frontend.
4. The user explicitly approves or rejects it.
5. Express receives the approval.
6. Express independently checks current permissions.
7. Express validates the operation.
8. Express executes the operation.
9. The backend returns the actual result.

### Security requirements

- No silent mutations.
- No automatic approval.
- No trust in AI-generated permissions.
- Revalidate permissions at execution time.
- Validate all input.
- Maintain audit records for relevant operations.
- Handle expired or stale proposals.
- Ensure duplicate execution is prevented where appropriate.

---

# 27. Redis and Background Processing

Redis supports performance and distributed application operations.

### Redis use cases

- Caching.
- Rate limiting.
- Presence.
- Typing indicators.
- Real-time coordination.
- Ephemeral state.
- Queue infrastructure.
- Distributed coordination.

### Background processing use cases

- Email delivery.
- Notification delivery.
- Calendar synchronisation.
- File processing.
- Search indexing.
- Integration synchronisation.
- AI processing jobs where appropriate.
- Automation execution.
- Cleanup and expiration tasks.

### Reliability requirements

- Bounded retries.
- Backoff strategies.
- Failure handling.
- Dead-letter or equivalent failure handling where configured.
- Idempotent job execution where appropriate.
- Monitoring.
- Structured logs.

Do not implement infinite retries.

Do not log sensitive information such as passwords, access tokens, or unnecessary recipient details.

PostgreSQL remains the durable source of truth.

---

# 28. Email Delivery

The backend uses an approved email provider.

Email functionality includes:

- Email verification.
- Password recovery.
- Invitation emails.
- Join request notifications.
- Task assignment emails.
- Mention notifications where approved.
- Meeting invitations.
- Important workspace updates.
- Subscription and billing communications.

### Requirements

- Centralised email service.
- Reusable templates.
- Queue-based delivery where appropriate.
- Bounded retries.
- Delivery status tracking.
- Failure handling.
- Deduplication.
- Secure template data.
- Appropriate logging.

Email delivery must not block unrelated application workflows unnecessarily.

---

# 29. Real-Time Architecture

Nexus requires real-time application functionality.

The backend should support real-time events for:

- Messaging.
- Typing indicators.
- Presence.
- Task updates.
- Project updates.
- General notifications.
- Workspace membership changes.
- Relevant permission changes.
- Meeting-related events.

### Requirements

- Authenticated connections.
- Workspace-aware authorisation.
- Secure event delivery.
- Event validation.
- Reconnection support.
- Appropriate event naming.
- Duplicate prevention.
- Distributed coordination where required.

Do not send events to users who lack permission to access the relevant resource.

Redis may coordinate real-time delivery across multiple backend instances.

---

# 30. API Architecture

The backend exposes APIs for the Nexus frontend and approved integrations.

### API design requirements

- Consistent route organisation.
- Request validation.
- Response consistency.
- Authentication.
- Authorisation.
- Pagination.
- Filtering.
- Sorting.
- Appropriate HTTP status codes.
- Centralised error handling.
- API documentation.

### API standards

- Do not expose database implementation details unnecessarily.
- Do not trust client-provided roles.
- Validate all user input.
- Validate workspace and resource access.
- Avoid leaking internal errors.
- Keep API contracts stable where practical.
- Document breaking changes.

The actual route structure and API conventions must follow the existing backend implementation.

---

# 31. Database Architecture

PostgreSQL is the primary persistent database.

The backend must maintain clear relationships between:

- Users.
- Workspaces.
- Workspace memberships.
- Invitations.
- Join requests.
- Roles and permissions.
- Departments.
- Teams and groups.
- Projects.
- Tasks.
- Conversations.
- Messages.
- Notifications.
- Files.
- Documents.
- Calendar events.
- Meetings.
- Forms.
- Subscriptions.
- Integrations.
- Automations.
- Audit records.

### Database principles

- Use appropriate constraints.
- Add indexes for common queries.
- Use transactions for multi-step operations.
- Maintain referential integrity.
- Prevent cross-workspace access.
- Use migrations for schema changes.
- Preserve existing data.
- Avoid destructive migrations without explicit approval.
- Consider query performance.
- Avoid unnecessary duplication.

The actual ORM and migration tooling must be discovered from the repository.

Do not assume a particular ORM.

---

# 32. Audit Logging and Monitoring

Important actions should be auditable.

Examples:

- Authentication events.
- Role changes.
- Membership changes.
- Workspace settings changes.
- Project visibility changes.
- Sensitive file sharing.
- Billing changes.
- Integration connections and disconnections.
- Security-related actions.
- AI-assisted mutations.

### Logging requirements

- Structured logging.
- Appropriate log levels.
- Request correlation where configured.
- Error tracking.
- Job execution logging.
- Security event logging.
- Monitoring for critical failures.

Never log:

- Passwords.
- Raw access tokens.
- Private API secrets.
- CVV.
- Unnecessary private user content.

Avoid logging unnecessary personal information.

---

# 33. Backend Security

Security must be enforced throughout the backend.

### Authentication

- Secure credential handling.
- Password hashing.
- Session and token protection.
- Expiration.
- Revocation.
- Account recovery protection.

### Authorisation

- Server-side permission checks.
- Workspace isolation.
- Resource ownership checks.
- Role validation.
- Protection against privilege escalation.
- Protection against insecure direct object references.

### API security

- Input validation.
- Rate limiting.
- Secure CORS configuration.
- Safe error handling.
- Appropriate security headers.
- Request size limits.
- File upload validation.
- Webhook signature validation.

### Data security

- Secure database credentials.
- Private object storage.
- Secure token storage.
- Appropriate encryption.
- Safe logging.
- Environment secret protection.

### AI security

- AI does not determine user permissions.
- AI cannot silently mutate application data.
- Every mutation requires explicit approval.
- Express rechecks permissions before execution.

---

# 34. Error Handling and Validation

The backend must use consistent validation and error handling.

Requirements:

- Validate request parameters.
- Validate request bodies.
- Validate query parameters.
- Validate resource access.
- Return consistent errors.
- Avoid leaking stack traces in production.
- Log useful diagnostic information.
- Handle external provider failures.
- Handle database failures.
- Handle Redis failures.
- Handle background job failures.
- Handle AI service failures.

A failure in an optional service should not unnecessarily disable unrelated core functionality.

---

# 35. Testing Strategy

The backend must be tested throughout development.

### Testing categories

- Unit tests.
- Service tests.
- Integration tests.
- API tests.
- Database tests.
- Permission tests.
- Security tests.
- Real-time tests.
- Background job tests.
- External provider integration tests where practical.

### Important workflows

- Authentication.
- Workspace creation.
- Workspace switching and membership.
- Invitations.
- Join requests.
- Role changes.
- Privilege escalation prevention.
- Project visibility.
- Task management.
- Messaging.
- Notification separation.
- File access.
- Document access.
- Calendar synchronisation.
- Meeting access.
- Billing.
- Search.
- Integrations.
- Automation.
- AI requests.
- Nexus Write.
- AI action approval.
- Background job retries.
- Workspace isolation.

Do not remove tests to make an implementation appear successful.

---

# 36. Environment Configuration

Inspect the existing environment configuration before adding or changing variables.

Configuration categories may include:

- Application environment.
- API port.
- PostgreSQL connection.
- Redis connection.
- Authentication secrets.
- Frontend origin.
- Object storage.
- Email provider.
- Payment provider.
- Calling provider.
- AI service connection.
- OAuth providers.
- Logging and monitoring.

The actual variable names must be taken from the existing configuration and application code.

### Mandatory rules

- Never overwrite `.env`.
- Never delete environment files.
- Never commit secrets.
- Never print credentials in logs.
- Never place production secrets in example files.
- Keep local, staging, and production configurations separate.
- Document newly required variables.
- Preserve existing deployment configuration.

---

# 37. Suggested Backend Project Structure

The actual structure must be determined from the existing repository.

A possible organisation is:

```text
backend/
├── src/
│   ├── app/
│   ├── config/
│   ├── database/
│   ├── middleware/
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── workspaces/
│   │   ├── memberships/
│   │   ├── invitations/
│   │   ├── permissions/
│   │   ├── teams/
│   │   ├── projects/
│   │   ├── tasks/
│   │   ├── messaging/
│   │   ├── notifications/
│   │   ├── files/
│   │   ├── documents/
│   │   ├── calendar/
│   │   ├── meetings/
│   │   ├── forms/
│   │   ├── billing/
│   │   ├── search/
│   │   ├── integrations/
│   │   ├── automation/
│   │   └── ai/
│   ├── services/
│   ├── jobs/
│   ├── queues/
│   ├── realtime/
│   ├── utils/
│   └── types/
├── tests/
├── migrations/
├── .env.example
├── package.json
└── README.md

ai-service/
├── app/
├── tests/
├── requirements.txt
└── README.md
```

This is illustrative only.

Do not restructure the existing repository simply to match this example.

---

# 38. Development and Execution

Before starting development:

1. Inspect the repository.
2. Read `package.json`.
3. Confirm the Node.js version.
4. Confirm the package manager.
5. Inspect the existing database configuration.
6. Inspect Redis configuration.
7. Review environment variables.
8. Confirm migration tooling.
9. Confirm test scripts.
10. Review frontend integration requirements.

Use the scripts already defined by the repository.

Typical commands may resemble:

```bash
pnpm install
pnpm dev
pnpm lint
pnpm test
pnpm build
```

Database migration commands must be taken from the actual backend package scripts and migration tooling.

Do not blindly run commands from examples in this document.

---

# 39. Deployment and Production Operations

The backend must be deployable independently of the frontend and AI service.

Production readiness includes:

- Secure environment variables.
- PostgreSQL connectivity.
- Redis connectivity.
- Database migrations.
- Object storage configuration.
- Email provider configuration.
- Payment provider configuration.
- Calling provider configuration.
- AI service connectivity.
- CORS configuration.
- Authentication configuration.
- Background worker configuration.
- Real-time infrastructure.
- Monitoring.
- Error tracking.
- Health checks.
- Backup and recovery procedures.

### Deployment principles

- Avoid destructive production migrations.
- Never commit production secrets.
- Verify migrations before deployment.
- Maintain compatibility between frontend and backend API contracts.
- Monitor background workers.
- Verify real-time connectivity.
- Verify external provider callbacks.
- Test critical workflows after deployment.

---

# 40. Scalability and Performance

The backend must be designed for increasing users, workspaces, and concurrent operations.

Important areas:

- Database indexing.
- Query optimisation.
- Pagination.
- Caching.
- Redis coordination.
- Background processing.
- Connection management.
- Real-time scaling.
- File processing.
- Search indexing.
- API rate limiting.
- Efficient event delivery.

Do not introduce unnecessary infrastructure prematurely.

Scale based on actual architectural and performance requirements.

---

# 41. Development Rules for AI Coding Agents

All coding agents must follow:

- `agent.md`
- `phases.md`
- Existing architecture documentation.
- Existing API documentation.
- Relevant module documentation.

### Mandatory rules

1. Read documentation before coding.
2. Inspect existing implementation.
3. Work only on the assigned phase.
4. Preserve existing functionality.
5. Use TypeScript for the main backend.
6. Keep Python limited to the separate AI service.
7. Do not invent APIs.
8. Do not bypass service-level authorisation.
9. Preserve workspace isolation.
10. Do not expose secrets.
11. Never delete or overwrite `.env`.
12. Do not replace existing architecture without approval.
13. Run relevant tests and checks.
14. Update `phases.md`.
15. Commit changes to a dedicated feature branch.
16. Never commit directly to `main`.
17. Never force-push.
18. Never merge without explicit approval.

---

# 42. Current Implementation Status

This README describes the intended backend architecture and product requirements.

It does not mean every described module has already been implemented.

The actual implementation status must be established by inspecting the repository and the `phases.md` tracker.

Use the tracker to record:

- Completed features.
- In-progress features.
- Pending features.
- Blocked features.
- Missing API contracts.
- Outstanding infrastructure dependencies.
- Known security or reliability issues.

Do not report planned functionality as implemented.

---

# 43. Future Enhancements

The following are potential future improvements and are not automatically part of the initial implementation scope:

- Native mobile application APIs.
- Collaborative whiteboards.
- Advanced knowledge base.
- Advanced document collaboration.
- Custom permission builder.
- Workflow marketplace.
- Advanced AI agents.
- Additional third-party integrations.
- Advanced enterprise security monitoring.
- Advanced analytics.
- Offline synchronisation.

These features require explicit approval before implementation.

---

# 44. Definition of Done

A backend feature is complete only when:

1. The requirement is implemented.
2. Existing functionality is preserved.
3. Request validation is implemented.
4. Authentication is enforced where required.
5. Authorisation is enforced server-side.
6. Workspace isolation is verified.
7. Database changes are migrated safely where required.
8. Error handling is implemented.
9. Relevant events and background jobs are handled.
10. Relevant tests pass.
11. TypeScript checks pass.
12. Linting passes.
13. Build checks pass where applicable.
14. API documentation is updated where necessary.
15. `phases.md` is updated accurately.
16. Changes are committed to the appropriate feature branch.
17. The feature branch is pushed when required.
18. Outstanding limitations are documented.

A route returning HTTP 200 does not automatically mean its feature is complete.

---

# 45. Final Objective

The Nexus backend must provide a secure, reliable, scalable, and maintainable foundation for the entire Nexus platform.

It must coordinate users, workspaces, memberships, projects, tasks, conversations, notifications, files, documents, meetings, subscriptions, integrations, automation, and AI-powered workflows.

The Express and TypeScript application remains the authoritative application backend.

PostgreSQL remains the durable source of truth.

Redis supports performance and real-time coordination.

Python/FastAPI provides separate AI processing.

All application resources must respect workspace isolation and server-side permissions.

The ultimate goal is to provide a backend capable of supporting a connected productivity platform across Individual, Company, and Institution workspaces.
