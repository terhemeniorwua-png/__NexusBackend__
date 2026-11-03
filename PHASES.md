# NEXUS BACKEND — IMPLEMENTATION PHASE TRACKER

## 1. Purpose

This document defines the implementation roadmap for the Nexus backend.

Nexus is a Real-Time Workspace & Project Management Platform that combines project management, collaboration, communication, file management, scheduling, and AI-powered productivity.

The backend is responsible for application business logic, authentication, authorisation, workspace isolation, data persistence, real-time communication, integrations, notifications, and coordination with the separate Python AI service.

This tracker must be treated as the authoritative implementation sequence for backend development.

## 3. Verified Progress Snapshot — 2026-11-03

| Phase | Status | Evidence / remaining work |
|---|---|---|
| 0 — Repository audit | COMPLETED | Architecture and implementation gaps are recorded in `docs/phase-audit.md`; verification commands are documented there. |
| 1 — Core infrastructure | COMPLETED | Type checking, lint, build, and HTTP foundation tests pass. |
| 2 — Database architecture | COMPLETED | Prisma migrations deploy to an isolated PostgreSQL test database; schema and migration tests pass. |
| 3 — Authentication and identity | COMPLETED | Database-backed lifecycle suite passes, including session rotation, recovery, and account deletion cases. |
| 4 — Workspace management | BLOCKED | Verified email now provisions one private personal workspace. Account deletion now schedules a 30-day recovery period, revokes sessions/tokens, supports password-verified cancellation, and runs an idempotent database purge that preserves shared records. Company/Institution profile and settings requirements are documented for Phase 7. Permanent deletion is held for personal workspaces with file metadata because this repository has no object-storage deletion adapter. |
| 5 — Organisation membership and onboarding | BLOCKED | Phase 5 join, invitation acceptance, discovery, suspension, and reassignment regression suites pass (31 passed, 0 failed). Invitation decline/rejection is not exposed by the current API. Member removal atomically reassigns active tasks only to active workspace members eligible for each project; verified domain matching does not grant membership. Phase 4 remains open and blocks phase closeout. |
| 6 — Roles and access control | BLOCKED | Current database/API roles do not match the Company and Institution role names in the product requirements. A compatible role mapping must be agreed before changing persisted role values. |
| 7–32 | NOT STARTED | No implementation from these phases is included in the active feature branch. |

Phase 4 remains the earliest incomplete phase; do not proceed to Phase 6. On 2026-11-03, the complete suite ran serially against disposable PostgreSQL with database flags for Phases 2–5: 231 passed, 0 failed, 0 skipped, including the Phase 2 migration assertion. A parallel run had one intermittent Phase 4 email retry failure; that suite passed alone (20/20), and the serial full suite passed. The added workspace restoration regression test passed in the targeted workspace integration suite (22/22). Type checking, lint, formatting, build, migration deployment/status, and OpenAPI YAML parsing passed. Phase 4 is not complete; the audit matrix below records the remaining requirements.

Current audit run: `npm test` passed 116 tests with 0 failures and 1 skipped optional Phase 2 migration assertion. The database-backed Phase 3–6 suites were skipped because no test database was configured. `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `git diff --check`, and parsing `docs/openapi.yaml` with PyYAML passed. This unit-only run does not replace the earlier database-backed verification recorded above and does not change any phase status.

## 4. Technology Stack

### Main Backend
- Node.js
- Express.js
- TypeScript
- PostgreSQL
- Redis
- REST API
- WebSockets / Socket.IO or the existing real-time implementation
- Background job processing
- Private object storage

### AI Service
- Python
- FastAPI
- Managed AI APIs
- Independent deployment and scaling

### Supporting Services
- Managed audio/video calling SDK
- Payment provider
- Email delivery provider
- Google and Microsoft integrations
- Object storage provider

**Important:** Inspect the existing repository to identify the actual ORM, database driver, migration framework, validation library, authentication implementation, and other existing dependencies. Do not introduce replacements without a demonstrated need and explicit approval.

---

# PHASE 0 — Repository Audit and Backend Foundation

### Objectives
Understand the existing backend before making changes and establish a reliable development foundation.

### Tasks
- Inspect the complete backend repository.
- Read the README, architecture documentation, branding documentation, and this phase tracker.
- Identify existing modules, services, controllers, routes, middleware, utilities, and database models.
- Inspect package.json and existing dependencies.
- Inspect the current database configuration and migration system.
- Inspect environment configuration without exposing secrets.
- Identify incomplete, duplicated, broken, or unimplemented functionality.
- Verify TypeScript configuration and build scripts.
- Verify linting, formatting, and testing configuration.
- Establish a baseline of existing errors and failing tests.
- Document the current architecture and implementation gaps.

### Completion Criteria
- Existing architecture is documented.
- Build and test baseline is established.
- Existing implementation gaps are recorded.
- No existing functionality has been removed or replaced.
- Development instructions are documented.

---

# PHASE 1 — Application Configuration and Core Infrastructure

### Objectives
Establish the reusable infrastructure required by all backend modules.

### Tasks
- Configure environment validation.
- Establish centralised application configuration.
- Configure Express application and HTTP server.
- Configure PostgreSQL connection and lifecycle management.
- Configure Redis connection and lifecycle management.
- Establish centralised error handling.
- Establish request validation conventions.
- Establish API response conventions.
- Configure structured logging.
- Configure request IDs and correlation IDs.
- Configure CORS and security headers.
- Configure request body size limits.
- Configure health and readiness endpoints.
- Configure graceful shutdown.
- Establish reusable utilities and shared types.

### Completion Criteria
- Application starts reliably.
- Database and Redis connections are verified.
- Invalid environment configuration fails safely.
- Health and readiness checks work.
- Errors are handled consistently.
- Existing API behaviour remains intact.

---

# PHASE 2 — Database Architecture and Data Modelling

### Objectives
Implement a reliable database foundation that supports Nexus's multi-workspace architecture.

### Tasks
- Review existing database models and migrations.
- Define the user identity model.
- Define workspace and organisation models.
- Define workspace membership models.
- Define team and department models.
- Define project and task models.
- Define messaging and conversation models.
- Define notification and activity models.
- Define file and media metadata models.
- Define subscription and billing models.
- Define integration connection models.
- Define calendar and meeting models.
- Define audit log models.
- Define AI interaction and approval models.
- Define indexing and relational constraints.
- Implement migrations using the existing migration framework.
- Establish safe migration and rollback procedures.

### Completion Criteria
- Core database schema is implemented.
- Relationships and constraints are verified.
- Migrations run successfully.
- No destructive migration is introduced without approval.
- Database documentation is updated.

---

# PHASE 3 — Authentication and User Identity

### Objectives
Implement secure user authentication and identity management.

### Tasks
- User registration.
- User login.
- Logout and session invalidation.
- Password hashing and verification.
- Access token and refresh token management.
- Secure token rotation and revocation.
- Email verification.
- Password reset.
- Account profile management.
- Profile image metadata and upload integration.
- Optional two-factor authentication.
- Account security settings.
- Active session management.
- Device and session tracking where supported.
- Authentication middleware.
- Rate limiting for sensitive authentication endpoints.
- Account deactivation and deletion workflows.

### Completion Criteria
- Authentication works securely.
- Refresh token handling is tested.
- Users cannot access another user's account.
- Password recovery works.
- Optional 2FA can be enabled and disabled securely.
- Authentication events are logged appropriately.

---

# PHASE 4 — Workspace Creation and Workspace Management

### Objectives
Support Individual, Company, and Institution workspaces within one Nexus platform.

### Tasks

#### Individual Workspaces
- Automatically create a personal workspace for new individual users.
- Implement personal workspace settings.
- Support additional collaborative workspaces.
- Preserve personal data independently of organisation membership.
- Keep the personal workspace and assets intact for 30 days after account deletion is requested.
- Allow password-verified account recovery during the 30-day period without restoring revoked sessions.
- Permanently remove the personal workspace and exclusively owned relational records after the recovery period.
- Preserve shared workspace content and anonymize historical attribution as `Deleted user`.
- Remove the user's shared-workspace memberships and access during permanent deletion.
- Block deletion requests until organization ownership is transferred and another active owner or administrator remains.
- Do not remove personal-workspace files until their storage objects can be deleted through the configured object-storage provider.

#### Company Workspaces
- Company registration.
- Organisation profile.
- Company workspace configuration.
- Initial Owner assignment.
- Organisation settings.
- Company-specific workspace structure.

#### Institution Workspaces
- Institution registration.
- Institution profile.
- Institution workspace configuration.
- Configurable departments and organisational hierarchy.
- Initial Owner assignment.
- Institution settings.

### Approved account deletion policy — 2026-11-03

- `POST /auth/delete` requires the current password and exact email confirmation. It sets `PENDING_DELETION`, records `deletionRequestedAt` and `scheduledDeletionAt`, revokes active sessions and unused authentication tokens, and sends a transactional email with the scheduled date.
- The recovery period is exactly 30 days. The existing password-verified `/auth/reactivate` flow cancels a pending deletion before the deadline. It clears the schedule but does not restore old sessions; the user must sign in again.
- Permanent deletion removes the marked personal workspace and its workspace-owned relational data, memberships, access, notifications, and pending invitations. A neutral user tombstone remains to preserve foreign keys and shared historical attribution.
- Company, Institution, and other non-personal shared workspaces are not deleted. Organization owners must transfer ownership first. A final active organization administrator cannot request deletion until another active owner or administrator is available.
- Shared projects, tasks, comments, and file records remain. Assignments and memberships for the deleted user are removed; shared content displays the tombstone's `Deleted user` identity.
- This repository has file metadata but no object-storage deletion adapter. Permanent deletion is held when personal workspace file metadata exists, rather than deleting the metadata and orphaning stored objects. Integrating safe object cleanup is a Phase 12 dependency and Phase 4 remains blocked for such accounts.

### Company and Institution profile and settings requirements

These fields and settings are approved product requirements. Phase 4 implements only workspace type and ownership foundations; profile models/APIs and organization administration are assigned to Phase 7 so they can use the organization structure and permission model without expanding the personal-workspace work.

**Company profile:** company name, logo, description, industry/business category, official website, business email, contact information, country/location, organization workspace ID, created/updated timestamps.

**Institution profile:** institution name, logo, description, institution type (university, college, school, research institution, or other), official website, institutional email, contact information, country/location, organization workspace ID, created/updated timestamps. Institution-only fields must not be imposed on Company profiles and vice versa.

**Organization settings:** general profile and contact settings, workspace name and basic preferences, supported notification preferences, member/role views, invitations and member removal, ownership and administrator management, and role-protected security/access settings. Only authorized owners and administrators may change sensitive settings. Subscription, billing, pricing, department hierarchy, logo storage, and complete organization administration are deferred to their designated roadmap phases; no commercial rules are specified here.

#### Shared Functionality
- Workspace creation and updates.
- Workspace switching support.
- Workspace type validation.
- Workspace status management.
- Workspace archival and restoration.
- Workspace ownership management.
- Workspace deletion safeguards.
- Workspace membership isolation.

### Completion Criteria
- All three workspace types can be created.
- Workspace type controls applicable features.
- Users can belong to multiple workspaces.
- Personal workspace data remains independent.
- Workspace isolation is enforced at the backend level.

### Verified Phase 4 requirement status — 2026-11-03

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Create company, institution, and individual workspace records; validate type; make them private by default; assign initial owner | COMPLETED | `WorkspaceType` migration and API/database tests cover all types and private defaults. Individual workspaces cannot be made public. |
| Workspace create, list, retrieve, update, switch validation, soft delete, and archive | COMPLETED | API/database tests verify these operations, authorization, audit history, and deleted workspace access denial. |
| Workspace restoration | COMPLETED | Added owner-only `POST /workspaces/{workspaceId}/restore`, transactional state transition and audit event; targeted regression test verifies role denial, success, repeat restore conflict, and audit. |
| Membership isolation and ownership controls | COMPLETED | Database-backed workspace and Phase 6 policy tests verify membership scoping, owner protections, and cross-workspace denial. Phase 6 implementation was not changed in this audit. |
| Workspace invitations and invitation state handling | COMPLETED | Existing Phase 5 integration tests cover invite/accept, single use, expiry, revocation, and workspace scoping. These capabilities remain implemented by the Phase 5 invitation module. |
| Invitation decline/rejection | NOT STARTED | No invitee decline/rejection endpoint or state transition is present. This is a Phase 5 onboarding gap and was not implemented during this Phase 4 audit. |
| Automatically provision a personal workspace after email verification | COMPLETED | Verification now transactionally creates or adopts one private `isPersonal` workspace and OWNER membership; migration backfills existing active users. |
| Personal workspace archive/delete safeguards | COMPLETED | The ordinary workspace archive/delete routes reject personal workspaces; account deletion owns their lifecycle. |
| Account deletion request, confirmation, and 30-day schedule | COMPLETED | Password and email confirmation, status and timestamps, token/session revocation, rate limiting, response, and transactional email are implemented. |
| Recovery during the grace period | COMPLETED | Existing password-verified reactivation cancels the schedule without restoring old sessions. |
| Permanent deletion of personal relational data and shared-data protection | IN PROGRESS | Idempotent locked worker removes personal relational data, memberships, assignments, profile, and pending invitations while anonymizing shared attribution. It holds accounts with personal file metadata because object storage deletion is not implemented. |
| Last organization owner/administrator protection | COMPLETED | Requests are rejected until organization ownership is transferred and another active owner or administrator remains. |
| Personal workspace-specific settings | IN PROGRESS | Generic workspace name/description/visibility settings remain available; no distinct personal settings model/API is required by the current foundational scope. |
| Company profile and organization settings | NOT STARTED | Approved field and permission requirements are documented above and assigned to Phase 7. |
| Institution profile and organization settings | NOT STARTED | Institution-specific fields are documented above and assigned to Phase 7; department hierarchy remains part of Phase 7. |
| Frontend integration for onboarding, workspace list/switch, account recovery, and management | IN PROGRESS | Backend endpoints and response contracts are documented; frontend integration is outside this backend repository. |
| Workspace lifecycle notifications and real-time events | NOT STARTED | Workspace audit logging exists; no Phase 4 workspace notification or real-time event integration was found in this branch. |

---

# PHASE 5 — Organisation Membership, Invitations and Join Requests

### Objectives
Implement organisation membership and controlled onboarding.

### Tasks
- Organisation membership management.
- Direct invitations.
- Invitation acceptance and rejection.
- Invitation expiration after 48 hours.
- Invitation revocation and resending.
- Public organisation discovery.
- Organisation join links and codes.
- Organisation join requests.
- Join request approval and rejection.
- Join request withdrawal.
- Join request expiration after 7 days.
- Applicant status tracking.
- Email-domain verification.
- Prevent automatic membership based solely on matching email domains.
- Team or department assignment during approval or afterward.
- Support multiple team memberships.
- Pending applicants must not access private workspace resources.
- Membership removal.
- Membership suspension and restoration.
- Ownership transfer.
- Task reassignment when members leave.
- Preserve organisation assets and audit history after member removal.

### Completion Criteria
- Invitations and join requests follow their separate rules.
- Expiration is enforced server-side.
- Applicants cannot access private workspace resources.
- Approved users receive the correct membership.
- Membership removal does not delete the user's Nexus identity or personal workspace.

---

# PHASE 6 — Roles, Permissions and Access Control

### Objectives
Implement granular role-based and resource-level authorisation.

### Tasks
- Define Individual workspace permissions.
- Define Company workspace roles:
  - Owner
  - Admin
  - Team Lead
  - Member
  - Guest
- Define Institution workspace roles:
  - Owner
  - Institution Admin
  - Department Admin
  - Team/Group Lead
  - Member
  - Guest
- Implement organisation-level permissions.
- Implement team-level permissions.
- Implement project-level permissions.
- Implement resource-level permissions.
- Separate organisation membership from team membership.
- Support multiple team memberships.
- Implement permission middleware and reusable authorisation services.
- Enforce permissions in services, not only routes.
- Prevent horizontal and vertical privilege escalation.
- Prevent cross-workspace access.
- Implement permission-aware resource queries.

### Mandatory Ownership Rules
- Admins can remove ordinary members and guests.
- Only the Owner can remove or demote another administrator.
- An Admin cannot remove the Owner.
- Team Leads cannot remove organisation members unless specifically granted permission.
- The Owner retains ultimate organisation control.

### Completion Criteria
- Permission rules are enforced consistently.
- Private resources cannot be accessed through guessed IDs.
- Role escalation is prevented.
- Workspace, team, and project permissions are tested.
- Ownership rules are enforced.

---

# PHASE 7 — Teams, Departments and Groups

### Objectives
Implement collaboration structures within Company and Institution workspaces.

### Tasks
- Add Company profile fields: name, logo reference, description, industry/business category, official website, business email, contact information, country/location, workspace ID, and timestamps.
- Add Institution profile fields: name, logo reference, description, institution type, official website, institutional email, contact information, country/location, workspace ID, and timestamps.
- Keep Company and Institution profile schemas distinct; do not require organization-specific fields on the other type.
- Add general organization profile/settings operations with owner/admin authorization.
- Add supported workspace preferences and notification preferences using the existing notification architecture.
- Reuse Phase 5 membership and Phase 6 role/permission operations for member and administrator management; do not duplicate those APIs.
- Create and manage teams.
- Create and manage departments.
- Create and manage institution groups.
- Assign team leads and department administrators.
- Add and remove members.
- Support multiple team memberships.
- Implement team-specific settings.
- Implement department-specific settings.
- Implement team membership permissions.
- Implement team activity records.
- Implement team-level project access.
- Implement team-level communication access.

### Completion Criteria
- Company and Institution profiles are independently validated and workspace-scoped.
- Only authorized owners and administrators can change sensitive organization settings.
- Profile updates preserve workspace isolation and audit history.
- Teams and departments work independently.
- Users can belong to multiple teams.
- Team permissions do not override organisation-level restrictions.
- Team and department resources respect workspace visibility.

---

# PHASE 8 — Projects and Project Visibility

### Objectives
Implement the shared project management foundation.

### Tasks
- Project creation and management.
- Project descriptions and metadata.
- Project ownership.
- Project managers and contributors.
- Project members and viewers.
- Project status and lifecycle.
- Project milestones.
- Project deadlines.
- Project categories and labels.
- Project activity history.
- Project archival and restoration.
- Project-level settings.
- Project membership management.

### Project Visibility

Implement three visibility levels:

1. Organisation-wide.
2. Department/team-only.
3. Private/invitation-only.

### Important Requirements
- Project visibility must apply to all related resources.
- Project messages, files, meetings, tasks, and activity history must follow project access rules.
- Changing project visibility must not expose previously private resources.
- Organisation Admins must not automatically gain access to private projects unless their permissions explicitly allow it.

### Completion Criteria
- Projects can be created and managed.
- All visibility levels work correctly.
- Project resources inherit the appropriate access restrictions.
- Project access is tested against different workspace roles.

---

# PHASE 9 — Task and Work Management

### Objectives
Implement Nexus task management and project execution capabilities.

### Tasks
- Task creation and updates.
- Task descriptions.
- Multiple assignees where appropriate.
- Task creator and responsible owner.
- Task status.
- Priority levels.
- Start and due dates.
- Subtasks and checklists.
- Labels and categories.
- Task comments.
- Task attachments.
- @mentions.
- Task dependencies.
- Task activity history.
- Task assignment and reassignment.
- Task completion and reopening.
- Task archival.
- Task filtering and sorting.
- Board, List, Timeline, and Calendar views using shared task data.
- Task access control.
- Task notifications.

### Message-to-Task Conversion
- Convert an eligible message into a task.
- Preserve the original message reference.
- Preserve the conversation context.
- Notify relevant assignees.
- Prevent duplicate conversion where appropriate.

### Completion Criteria
- Task lifecycle works.
- Multiple task views use consistent data.
- Task permissions are enforced.
- Message-to-task conversion preserves context.
- Task activity and notification events are generated correctly.

---

# PHASE 10 — Real-Time Messaging and Conversations

### Objectives
Implement Nexus communication infrastructure.

### Conversation Types
- Direct messages.
- Group conversations.
- Team channels.
- Project conversations.
- Announcements.

### Tasks
- Conversation creation.
- Conversation membership.
- Message sending and receiving.
- Real-time message delivery.
- Message persistence.
- Message editing and deletion.
- Replies and threads.
- Reactions.
- @mentions.
- Attachments.
- Read receipts.
- Typing indicators.
- Online presence.
- Message pinning.
- Saved messages.
- Conversation search.
- Message pagination.
- Conversation permissions.
- Unread message counts.
- Message notification separation.

### Channel Management

Channels are controlled by authorised workspace administrators.

- Owners have full control.
- Admins can create and manage channels according to permissions.
- Team Leads may manage channels within assigned teams when authorised.
- Members cannot create channels by default.
- Guests can access only explicitly shared channels.

Support:
- Workspace-public channels.
- Private channels.
- Read-only announcement channels.
- Project-linked channels.

### Completion Criteria
- Messages persist in PostgreSQL.
- Real-time delivery works.
- Conversation membership is enforced.
- Unread counts work independently.
- Channel permissions are enforced.
- Message notifications remain separate from general notifications.

---

# PHASE 11 — Notification and Activity Infrastructure

### Objectives
Implement a centralised notification and activity system.

### Tasks
- Central event service.
- Persistent notification records.
- Activity feed.
- Recipient resolution.
- Notification preferences.
- Notification deduplication.
- Real-time notification delivery.
- Email notification integration.
- Notification read and unread states.
- Notification grouping.
- Notification pagination.
- Notification retention policies.
- Retry and failure handling.
- Notification audit records.

### General Notification Events
- Task assignments.
- Task mentions and comments.
- Meeting invitations.
- Meeting changes.
- Join request decisions.
- Directly shared files.
- Security and access changes.
- Other important workspace activities.

### Strict Message Notification Separation

- Direct messages must appear only in the Messages area.
- Group messages must appear only in the Messages area.
- Channel messages must appear only in the Messages area.
- Message @mentions must not generate duplicate general notification alerts.
- Message-to-task conversion may generate a general task notification.
- General notification counts and message unread counts must remain independent.

### Smart Notification Behaviour
- Important events should alert immediately.
- Less important events may be grouped.
- Relevant activities should remain available in the activity feed.
- Notification preferences must be respected.
- Duplicate alerts must be prevented.

### Completion Criteria
- Events are persisted reliably.
- Notification delivery works.
- Message notifications are separated from general notifications.
- Retry mechanisms are bounded.
- Users can configure notification preferences.

---

# PHASE 12 — File Management and Nexus Drive

### Objectives
Implement secure file storage and management.

### Tasks
- Private object storage integration.
- File upload.
- File download.
- File metadata persistence.
- Signed URL generation where applicable.
- File ownership.
- File sharing.
- Workspace file organisation.
- Project file organisation.
- Folder management.
- File permissions.
- File replacement and versioning foundations.
- File deletion and recovery policies.
- File size and type validation.
- Upload restrictions.
- Secure file access.
- Storage usage tracking.
- File activity history.

### Security Requirements
- Private storage by default.
- Do not expose private storage credentials.
- Validate permissions before issuing access links.
- Validate file metadata and upload constraints.
- Prevent cross-workspace file access.
- Do not trust client-supplied storage paths.

### Completion Criteria
- Files can be uploaded and retrieved securely.
- File access follows workspace and project permissions.
- Metadata is persisted.
- Storage operations are tested.

---

# PHASE 13 — Document Collaboration

### Objectives
Provide document collaboration capabilities within Nexus.

### Tasks
- Document creation.
- Document metadata.
- Document access control.
- Document sharing.
- Document comments.
- Document revisions and version history.
- Document activity.
- Document attachment to projects and tasks.
- Document search indexing.
- Document permissions.
- Integration with Nexus Drive.

### Completion Criteria
- Documents can be managed securely.
- Access permissions are enforced.
- Document history is maintained where supported.
- Documents can be connected to relevant workspace resources.

---

# PHASE 14 — Calendar and Scheduling

### Objectives
Implement the shared Nexus calendar and scheduling infrastructure.

### Tasks
- Calendar creation and management.
- Personal calendars.
- Workspace calendars.
- Team calendars.
- Project calendars.
- Event creation and updates.
- Event invitations.
- Participant management.
- Availability management.
- Recurring events.
- Event reminders.
- Event cancellation.
- Calendar access permissions.
- Calendar aggregation across authorised workspaces.
- External calendar connection foundations.

### Two-Way External Synchronisation
- Google Calendar integration.
- Microsoft Outlook Calendar integration.
- OAuth connection management.
- Event mapping.
- Two-way event synchronisation.
- Conflict detection.
- Duplicate prevention.
- Update and deletion synchronisation.
- Sync history.
- Origin tracking.
- Idempotency to prevent sync loops.

### Privacy
- Private event details must remain hidden from unauthorised users.
- Calendar aggregation must respect workspace membership and permissions.

### Completion Criteria
- Internal calendar operations work.
- Event permissions are enforced.
- Synchronisation is reliable and does not create duplicate events.
- Sync conflicts are handled safely.

---

# PHASE 15 — Meetings and Calling Integration

### Objectives
Integrate the managed audio/video calling SDK.

### Tasks
- Meeting creation.
- Instant meetings.
- Scheduled meetings.
- One-to-one calls.
- Group calls.
- Meeting invitations.
- Meeting participant management.
- Meeting access tokens.
- Meeting join and leave events.
- Meeting chat integration.
- Screen-sharing support through the provider.
- Participant permissions.
- Meeting recordings where supported and authorised.
- Meeting status tracking.
- Project-linked meetings.
- Calendar-linked meetings.
- Meeting notifications.
- Meeting history.

### Security
- Generate provider credentials server-side.
- Validate meeting access.
- Prevent unauthorised meeting joins.
- Respect project and workspace permissions.
- Never expose provider secret keys.

### Completion Criteria
- Meetings can be created and joined.
- Provider integration works.
- Access is permission-controlled.
- Meeting events and notifications are recorded.

---

# PHASE 16 — Forms and Surveys

### Objectives
Implement reusable forms and survey capabilities.

### Tasks
- Form creation.
- Form editing.
- Form publishing.
- Form fields and field types.
- Required and optional fields.
- Form access settings.
- Public and workspace-restricted forms.
- Form sharing links.
- Response submission.
- Response validation.
- Response storage.
- Response permissions.
- Response export foundations.
- Form activity records.
- Survey results and summary foundations.

### Completion Criteria
- Forms can be created and published.
- Responses are validated and stored.
- Access restrictions are enforced.
- Form data remains isolated by workspace.

---

# PHASE 17 — Subscription, Plans and Billing

### Objectives
Implement Nexus subscription and payment management.

### Subscription Structure

#### Individual
- Free plan.
- Premium plan.
- Monthly and yearly billing.
- Optional saved payment method for authorised auto-renewal.

#### Company
- Free plan.
- Paid organisation plans.
- Included seats and additional seat pricing.
- Owner-controlled billing.

#### Institution
- Free plan.
- Institution-specific paid plans.
- Member-category allowances.
- Owner-controlled billing.

### Tasks
- Plan definitions.
- Subscription records.
- Subscription creation.
- 14-day Premium trial without requiring a card.
- Explicit user subscription after trial.
- Monthly and annual billing.
- Payment provider integration.
- Payment verification.
- Webhook processing.
- Payment history.
- Invoice records.
- Saved payment method support through provider tokenisation.
- Explicit consent for recurring charges.
- Subscription renewal.
- Subscription cancellation.
- Failed payment handling.
- Grace periods where applicable.
- Plan upgrades and downgrades.
- Seat and usage tracking.
- Organisation billing ownership.
- Ownership transfer for billing.
- Subscription entitlement middleware.

### Important Rules
- A trial must not silently convert into a paid subscription.
- If the user does not upgrade, the subscription falls back to the applicable Free plan.
- Company and Institution subscriptions belong to the organisation.
- Ordinary organisation members do not separately pay for organisation features.
- Personal subscriptions remain independent of organisation subscriptions.
- Leaving an organisation must not affect the user's personal workspace.
- Downgrades must not silently delete user data.
- Over-limit features should be restricted gracefully.
- Never store raw card details or CVV.

### Completion Criteria
- Payment flows are verified.
- Webhooks are secure and idempotent.
- Subscription entitlements are enforced.
- Personal and organisation billing remain independent.
- Trial expiration and downgrade behaviour work correctly.

---

# PHASE 18 — Global Search and Full Document Search

### Objectives
Implement a unified search service across all workspaces a user is authorised to access.

### Search Categories
- People.
- Workspaces.
- Teams.
- Departments.
- Projects.
- Tasks.
- Messages.
- Conversations.
- Files.
- Documents.
- Meetings.
- Announcements.

### Tasks
- Central search service.
- PostgreSQL full-text search foundation.
- Search indexing.
- Search result ranking.
- Search filters.
- Workspace filters.
- Category filters.
- Recent searches.
- Search suggestions.
- Search pagination.
- Search permissions.
- Index updates on create, edit, and delete.
- Index updates on permission changes.
- Document content extraction.
- Searchable PDF content.
- Searchable Word document content.
- Searchable text document content.
- File metadata and filename search.
- Search history privacy.

### Security Requirements
- Apply permission filtering before returning results.
- Never expose private workspace content.
- Remove access when membership is revoked.
- Do not rely solely on frontend filtering.
- Search indexes must respect resource visibility.

### Completion Criteria
- Search spans authorised workspaces.
- Full document search works for supported file formats.
- Search results respect permissions.
- Indexes remain synchronised with resource changes.

---

# PHASE 19 — Integrations Framework

### Objectives
Create a reusable integrations architecture.

### Supported Integration Categories

#### File Storage
- Google Drive.
- OneDrive.
- Dropbox.

#### Communication
- Gmail.
- Outlook.
- Slack.
- Microsoft Teams.

#### Calendar
- Google Calendar.
- Microsoft Outlook Calendar.

#### Development
- GitHub.
- GitLab.

#### Automation
- Webhooks.
- Supported automation providers.

### Tasks
- Integration registry.
- OAuth connection management.
- OAuth callback handling.
- Token encryption.
- Token refresh.
- Token revocation.
- Integration permissions.
- Personal integrations.
- Workspace integrations.
- Integration enable/disable controls.
- Integration status.
- Sync jobs.
- Integration error handling.
- Integration audit history.

### Important Rules
- Integrations are available to Individual, Company, and Institution workspaces.
- Each workspace independently controls enabled integrations.
- Personal connections and shared workspace connections must remain separate.
- Personal account connections must not automatically become workspace connections.
- Disconnecting an integration must not delete provider-side data.
- Request only necessary OAuth scopes.

### Completion Criteria
- Integration connections are secure.
- Tokens are protected.
- Personal and workspace connections remain isolated.
- Disconnect and revocation work correctly.

---

# PHASE 20 — Automation and Workflow Engine

### Objectives
Build reusable backend automation capabilities.

### Tasks
- Automation definitions.
- Trigger registration.
- Event-based triggers.
- Scheduled triggers.
- Conditional execution.
- Action execution.
- Automation permissions.
- Automation ownership.
- Workspace-specific automation.
- Execution history.
- Failure tracking.
- Retry policies.
- Idempotency.
- Execution limits.
- Automation enable/disable controls.

### Completion Criteria
- Automations execute from authorised triggers.
- Actions respect permissions.
- Failed jobs are recoverable.
- Infinite retry loops are prevented.
- Execution history is available.

---

# PHASE 21 — Python AI Service Integration

### Objectives
Integrate the independently deployable Python AI service with the main Express backend.

### Architecture
- Python.
- FastAPI.
- Managed AI API.
- Independent deployment.
- Express remains the authoritative application backend.

### Tasks
- Define Express-to-Python communication.
- Define authenticated service-to-service requests.
- Define request and response schemas.
- Implement AI service health checks.
- Implement timeouts and failure handling.
- Implement AI request logging.
- Implement usage tracking.
- Implement context retrieval interfaces.
- Implement authorised context preparation.
- Implement source reference handling.
- Implement AI conversation persistence where appropriate.
- Implement AI response streaming where supported.

### AI Capabilities
- AI conversations.
- Workspace-aware assistance.
- Project summaries.
- Task summaries.
- Document analysis.
- Meeting summaries.
- Action-item extraction.
- Writing assistance.
- Research assistance.
- Recommendations.
- Contextual questions and answers.

### Mandatory Architecture Rules
- Express authenticates the user.
- Express verifies permissions.
- Express prepares authorised context.
- Python must not bypass application permissions.
- Python must not independently write to the main application database by default.
- Core Nexus features must continue working when the AI service is unavailable.

### Completion Criteria
- Express and Python communicate securely.
- AI context is permission-filtered.
- Source references are returned where relevant.
- AI failures do not break core application features.

---

# PHASE 22 — Nexus Write

### Objectives
Implement Grammarly-like writing assistance as part of Nexus.

### Capabilities
- Spelling correction.
- Grammar correction.
- Punctuation correction.
- Clarity improvements.
- Vocabulary suggestions.
- Tone detection.
- Tone adjustment.
- Sentence rewriting.
- Paragraph rewriting.
- Summarisation.
- Translation.
- Explanation of corrections.
- Writing improvement recommendations.

### Tasks
- Writing analysis API.
- Selected-text analysis.
- Incremental analysis.
- Debounced processing.
- Suggestion generation.
- Suggestion categorisation.
- Accept and dismiss suggestion support.
- Rewriting endpoints.
- Tone adjustment endpoints.
- User preference support.
- Usage tracking.
- AI provider error handling.

### User Experience Requirements
- Never silently replace user writing.
- Users must accept or dismiss suggestions.
- Preserve original text until a suggestion is accepted.
- Avoid sending unnecessary document content.
- Minimise retention of private text.
- Support integration with Nexus editors and relevant text inputs.

### Completion Criteria
- Writing analysis works.
- Suggestions are returned in a structured format.
- User text is not modified without consent.
- AI service failures are handled gracefully.

---

# PHASE 23 — AI Action Approval and Execution

### Objectives
Allow Nexus AI to recommend and execute approved actions safely.

### Tasks
- Define AI action types.
- Implement read-only AI actions.
- Implement recommendation responses.
- Implement proposed mutation actions.
- Implement approval records.
- Implement approval expiration.
- Implement action validation.
- Recheck user permissions at execution time.
- Execute approved actions through Express services.
- Record execution outcomes.
- Record audit events.
- Prevent duplicate execution.
- Support rejection and cancellation.

### Mandatory Rule
AI must never perform a mutation merely because it suggested the action.

Every mutation requires specific user approval. Express must revalidate permissions before executing the approved action.

### Completion Criteria
- Read, recommend, and act workflows are separated.
- Mutation approval is explicit.
- Permissions are rechecked.
- Duplicate and unauthorised actions are prevented.
- Actions are auditable.

---

# PHASE 24 — Redis, Background Jobs and Event Processing

### Objectives
Implement reliable asynchronous processing and real-time coordination.

### Tasks
- Redis cache management.
- Cache invalidation.
- Rate-limit storage.
- Background job infrastructure.
- Email jobs.
- Notification jobs.
- File processing jobs.
- Search indexing jobs.
- Calendar synchronisation jobs.
- Integration synchronisation jobs.
- AI processing jobs where appropriate.
- Job status tracking.
- Retry policies.
- Dead-letter or failed-job handling.
- Job deduplication.
- Idempotent processing.
- Worker health monitoring.

### Important Rules
- Redis must not be treated as the permanent source of truth for messages or notifications.
- Persistent application data belongs in PostgreSQL.
- Retry attempts must be bounded.
- Failed jobs must be observable and recoverable.
- Prevent infinite retry loops.
- Use appropriate job priorities and concurrency limits.

### Completion Criteria
- Background processing works.
- Jobs survive expected application restarts according to the chosen queue implementation.
- Retry behaviour is bounded.
- Failed jobs can be inspected.
- Redis failures are handled safely.

---

# PHASE 25 — Email Delivery and Communication

### Objectives
Implement reliable transactional and notification email delivery.

### Tasks
- Email provider integration.
- Central email service.
- Email templates.
- Email verification.
- Password recovery emails.
- Organisation invitations.
- Join request updates.
- Meeting invitations.
- Task assignment notifications.
- Mention notifications where applicable.
- Subscription and billing emails.
- Security emails.
- Email preferences.
- Delivery status tracking.
- Bounce and failure handling.
- Retry limits.
- Email delivery logs.
- Provider webhook processing.

### Security and Privacy
- Avoid exposing recipient addresses in unnecessary logs.
- Never log passwords, tokens, or sensitive email contents.
- Prevent duplicate email delivery.
- Respect user notification preferences.

### Completion Criteria
- Transactional email delivery works.
- Templates are consistent.
- Delivery failures are observable.
- Retry attempts are bounded.
- Sensitive information is not exposed in logs.

---

# PHASE 26 — Audit Logging and Security Monitoring

### Objectives
Provide reliable audit trails and security monitoring.

### Tasks
- Central audit logging service.
- Authentication events.
- Session events.
- Role changes.
- Permission changes.
- Workspace membership changes.
- Project visibility changes.
- File access and sharing events.
- Billing changes.
- Integration connection changes.
- AI action approvals and execution.
- Administrative actions.
- Security event classification.
- Audit log access permissions.
- Retention policies.
- Suspicious activity detection foundations.

### Completion Criteria
- Important actions are recorded.
- Audit logs cannot be modified by ordinary users.
- Audit access is permission-controlled.
- Sensitive information is not unnecessarily stored in logs.

---

# PHASE 27 — Reporting and Analytics

### Objectives
Provide workspace-aware reporting and analytics.

### Tasks
- Workspace activity metrics.
- Project progress metrics.
- Task completion metrics.
- Team productivity metrics.
- Member activity metrics.
- Meeting statistics.
- File usage statistics.
- Subscription usage metrics.
- Storage usage metrics.
- Institution-specific reporting.
- Company-specific reporting.
- Individual productivity summaries.
- Reporting date filters.
- Permission-aware analytics.
- Aggregated analytics endpoints.

### Completion Criteria
- Metrics are calculated consistently.
- Reports respect workspace permissions.
- Analytics do not expose private project information.
- Expensive queries are optimised.

---

# PHASE 28 — API Documentation and Developer Experience

### Objectives
Make the backend easy to understand, integrate, and maintain.

### Tasks
- API documentation.
- OpenAPI/Swagger documentation where appropriate.
- Authentication documentation.
- Endpoint request and response examples.
- Error response documentation.
- Pagination standards.
- Filtering and sorting conventions.
- WebSocket event documentation.
- Webhook documentation.
- Integration documentation.
- Environment variable documentation.
- Local development instructions.
- Deployment instructions.
- Database migration instructions.

### Completion Criteria
- API documentation reflects actual implementation.
- Developers can run the backend using documented instructions.
- Environment variables are documented without exposing secrets.
- Examples match real endpoint behaviour.

---

# PHASE 29 — Comprehensive Testing and Quality Assurance

### Objectives
Verify the correctness, security, and reliability of the complete backend.

### Tasks

#### Unit Testing
- Services.
- Utilities.
- Validation.
- Permission functions.
- Business rules.

#### Integration Testing
- Authentication.
- Database operations.
- Workspace management.
- Membership management.
- Projects and tasks.
- Messaging.
- Notifications.
- File management.
- Billing.
- Integrations.
- AI service communication.

#### Security Testing
- Authentication bypass.
- Broken access control.
- Cross-workspace data access.
- Privilege escalation.
- Insecure direct object references.
- Token misuse.
- Rate-limit bypass.
- File access vulnerabilities.
- Webhook verification.
- Injection vulnerabilities.

#### Reliability Testing
- Redis outages.
- Database connection failures.
- External provider failures.
- Background job retries.
- Duplicate events.
- Concurrent requests.
- Real-time reconnection.
- AI service downtime.

#### Performance Testing
- Database query performance.
- API response times.
- Pagination.
- Search.
- Real-time message delivery.
- Background job throughput.

### Completion Criteria
- Critical business flows have automated tests.
- Permission and workspace isolation tests pass.
- No critical known security vulnerabilities remain.
- Build, type checking, linting, and tests pass.
- Outstanding issues are documented.

---

# PHASE 30 — Performance, Scalability and Production Hardening

### Objectives
Prepare the backend for production workloads and future horizontal scaling.

### Tasks
- Database query optimisation.
- Database indexing review.
- Connection pooling.
- Cache strategy.
- Cache invalidation strategy.
- Background worker scaling.
- API rate-limit review.
- Real-time scaling strategy.
- Shared Redis coordination where required.
- File processing optimisation.
- Search optimisation.
- Pagination optimisation.
- Resource usage monitoring.
- Graceful degradation.
- Timeout policies.
- Circuit-breaker patterns where appropriate.
- Load testing.
- Production security review.

### Completion Criteria
- Critical queries are optimised.
- API and worker scaling strategies are documented.
- Rate limiting works across multiple API instances.
- Failure of optional services does not unnecessarily take down core functionality.

---

# PHASE 31 — Deployment and Production Operations

### Objectives
Prepare and deploy the backend and Python AI service.

### Tasks
- Production environment configuration.
- Production database configuration.
- Redis production configuration.
- Object storage configuration.
- Email provider configuration.
- Payment provider configuration.
- Calling provider configuration.
- AI service deployment.
- Express backend deployment.
- Database migration deployment procedure.
- Health checks.
- Readiness checks.
- Logging and monitoring.
- Error reporting.
- Backup strategy.
- Restore procedure.
- Deployment rollback strategy.
- Secret management.
- Domain and CORS configuration.
- Production smoke tests.

### Completion Criteria
- Backend deploys successfully.
- Python AI service deploys independently.
- Production environment variables are verified.
- Database migrations are safe.
- Health checks work.
- Backup and recovery procedures are documented.
- Production smoke tests pass.

---

# PHASE 32 — Final Backend Review and Release Readiness

### Objectives
Verify that the backend is ready for the intended Nexus release.

### Tasks
- Review all completed phases.
- Verify phase completion evidence.
- Check for unfinished endpoints.
- Check for placeholder implementations.
- Check for duplicated business logic.
- Check for missing permission checks.
- Check workspace isolation.
- Check subscription entitlements.
- Check real-time event delivery.
- Check notification separation.
- Check file access security.
- Check search permissions.
- Check AI service boundaries.
- Check environment configuration.
- Check migration consistency.
- Check logging for sensitive information.
- Verify frontend integration contracts.
- Update backend documentation.
- Record known limitations.
- Prepare release notes.

### Completion Criteria
- All required release phases are completed.
- Critical workflows work end to end.
- No unresolved critical security issues remain.
- API documentation is current.
- Deployment and recovery procedures are documented.
- Release readiness is explicitly recorded.

---

# FUTURE ENHANCEMENTS — NOT PART OF THE INITIAL IMPLEMENTATION

These features must remain outside the initial implementation unless explicitly approved and moved into the active phase plan.

Potential future backend capabilities include:

- Advanced collaborative whiteboards.
- Advanced knowledge base and wiki engine.
- Native mobile application support.
- Advanced enterprise security dashboard.
- Custom role and permission builder.
- Advanced workflow marketplace.
- Advanced AI agents and autonomous workflows.
- Expanded analytics and business intelligence.
- Advanced document collaboration.
- Additional third-party integrations.
- Advanced organisation-wide reporting.

Do not begin these features merely because they are listed here.

---

# GLOBAL IMPLEMENTATION RULES

These rules apply to every phase.

## 1. Documentation First
Before making changes:
- Read `README.md`.
- Read the branding and architecture documentation.
- Read `phases.md`.
- Inspect the existing repository.
- Identify the current active phase.

Do not assume that documentation examples describe existing implementation.

## 2. One Phase at a Time
- Work only on the current active phase.
- Do not begin the next phase automatically.
- Do not skip incomplete dependencies.
- Do not implement future enhancements unless explicitly instructed.
- If a dependency is missing, report it rather than building an unrelated replacement.

## 3. Preserve Existing Work
- Do not delete existing files or features unnecessarily.
- Do not overwrite working implementations without justification.
- Do not replace the existing ORM, database framework, authentication system, or other major dependencies without approval.
- Do not change the backend from TypeScript to JavaScript.
- Do not move AI responsibilities into the Express backend; the AI service remains Python/FastAPI.
- Do not overwrite `.env` files.
- Never print or commit secrets.
- Add new environment variables safely and update the example environment file where appropriate.
- Preserve existing API contracts unless a change is necessary and documented.

## 4. Implementation Quality
- Use TypeScript strictly.
- Follow the existing architecture and conventions.
- Keep controllers thin.
- Put business logic in services.
- Validate all incoming data.
- Enforce permissions server-side.
- Use database transactions for operations that require atomicity.
- Use safe and consistent error handling.
- Avoid duplicated business logic.
- Avoid unnecessary dependencies.
- Do not leave fake implementations or placeholder success responses.

## 5. Testing
Before completing a phase:
- Run the relevant tests.
- Run TypeScript type checking.
- Run linting where configured.
- Run the production build where applicable.
- Test important success and failure paths.
- Test permissions and access boundaries.
- Fix regressions introduced by the phase.
- Do not claim tests passed if they were not executed.

## 6. Phase Tracker Updates
After completing a phase:
- Mark the phase as completed.
- Record the implementation summary.
- Record migrations added.
- Record environment variables added or changed.
- Record tests executed and their outcomes.
- Record known limitations.
- Identify the next phase.
- Do not mark incomplete work as complete.

Use these statuses:
- `NOT STARTED`
- `IN PROGRESS`
- `BLOCKED`
- `COMPLETED`

## 7. Git Commit and Push
After completing each phase:
- Review the complete Git diff.
- Ensure no secrets or local environment files are included.
- Run the relevant checks.
- Stage only files belonging to the completed phase.
- Create a descriptive commit.
- Push the commit to the existing configured remote and branch.
- Never force-push.
- Never rewrite existing Git history.
- If pushing fails, preserve the commit and report the exact failure.
- Do not claim a push succeeded unless Git confirms it.

Suggested commit format:

`feat(phase-N): implement [phase name]`

For fixes:

`fix(phase-N): resolve [specific issue]`

For documentation:

`docs(phase-N): update [documentation]`

## 8. Completion Report

At the end of every phase, provide:

1. Phase completed.
2. Features implemented.
3. Files and modules changed.
4. Database migrations added.
5. Environment variables added or changed.
6. Tests and checks executed.
7. Test results.
8. Commit hash.
9. Push status.
10. Known limitations.
11. Next phase.

## 9. Handling Blockers

If a phase cannot be completed:
- Do not silently skip the issue.
- Do not mark the phase completed.
- Record the blocker.
- Explain its impact.
- Identify the required decision or dependency.
- Preserve all working changes.
- Do not proceed to unrelated phases.

## 10. Definition of Done

A phase is complete only when:
- Its requirements are implemented.
- Its acceptance criteria are satisfied.
- Relevant tests pass.
- Type checking and build checks pass where applicable.
- Existing functionality is preserved.
- Documentation and tracker are updated.
- The Git commit is created.
- The commit is pushed successfully, or the push failure is explicitly recorded.

**The phase tracker is the source of truth for implementation progress. Never mark a phase complete based only on partial implementation.**
