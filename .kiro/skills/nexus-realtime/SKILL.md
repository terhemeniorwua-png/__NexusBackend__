---
name: nexus-real-messaging
description: Specialized instructions for implementing real-time messaging in the Nexus backend, including direct messages, group conversations, administrator-controlled team channels, project conversations, announcements, message persistence, read receipts, typing indicators, attachments, mentions, message-to-task conversion, and strict separation from general notifications across Individual, Company and Institution workspaces.
---

# Nexus Real Messaging Skill

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

## 1. Purpose

This skill defines how real-time messaging must be designed, implemented, tested, and maintained in the Nexus backend.

Nexus is a general-purpose Real-Time Workspace & Project Management Platform serving Individual, Company, and Institution workspaces from one shared backend. It combines project and task management, team communication, collaborative documents, file management, scheduling, forms, search, automation, billing, integrations, and AI-assisted workflows.

Messaging must connect communication to work so that users can discuss projects and tasks without losing the context of the work. It must also remain clearly separated from the general notification system.

The implementation must prioritize message reliability, privacy, authorization, data integrity, and real-time responsiveness.

Follow this skill whenever implementing or modifying messaging functionality.

## 2. Technology Stack

Use the existing repository configuration as the source of truth.

- Runtime: Node.js
- Backend: Express.js
- Language: TypeScript
- Database: PostgreSQL
- ORM: Prisma
- Real-time communication: the existing WebSocket/real-time implementation. Socket.IO is the planned transport but is not yet installed; inspect `package.json`.
- Cache and temporary coordination: Redis
- Authentication: Reuse the existing Nexus authentication system
- File storage: Reuse the existing approved private file-storage service

Do not introduce another database, ORM, authentication system, or real-time framework without explicit approval.

PostgreSQL remains the authoritative store for persistent messages and conversations. Real-time transport delivers events but does not replace database persistence.

Redis may support temporary presence, coordination, or scaling when appropriate. Do not use Redis as the only storage for messages that must survive restarts.

## 3. Inspect Before Implementing

Before making messaging changes:

1. Read `AGENTS.md` and `PHASES.md`.
2. Inspect `package.json` and the installed dependencies.
3. Review the Prisma schema and existing conversation, message, user, and workspace models.
4. Inspect authentication middleware and authorization services.
5. Review the existing real-time server and event-handling architecture.
6. Inspect notification, email, file-upload, and task-management services.
7. Identify the relevant implementation phase and its acceptance criteria.

Reuse existing models and services wherever possible.

Do not create duplicate messaging systems or replace working real-time infrastructure without a clear technical reason.

## 4. Core Messaging Features

Implement the messaging capabilities required by the current Nexus phase.

Potential features include:

- One-to-one direct messages.
- Group conversations.
- Administrator-controlled team channels.
- Workspace and team conversations.
- Project-specific conversations.
- Announcements.
- Task-linked discussions.
- Meeting-related conversations where appropriate.
- Message history and pagination.
- Real-time message delivery.
- Message editing and deletion.
- Replies and threaded discussions.
- Read receipts and unread counts.
- Typing indicators.
- Online presence.
- User mentions.
- Message attachments.
- Search within authorized conversations.
- Message reactions.
- Pinned and saved messages.
- Message notifications within the Messages area, independent of general notifications.
- Converting messages into tasks.
- Linking messages to project decisions or other work records.

These features are examples, not a requirement to implement everything at once.

Follow the current phase and avoid introducing unrequested features.

## 5. Database Design

Use PostgreSQL and Prisma for persistent messaging data.

Inspect the existing schema before adding models.

Depending on the implemented requirements, the data model may include:

- Conversation.
- ConversationMember.
- Message.
- MessageAttachment.
- MessageReaction.
- MessageReadReceipt.
- MessageMention.
- MessageThread or reply relationships.
- Message-related audit or notification records.

Do not create every suggested model automatically. Choose the smallest appropriate schema that supports the required behavior.

### Conversation model

A conversation should represent a clearly defined communication context.

It may include:

- Unique identifier.
- Conversation type: direct, group, team channel, project conversation, or announcement.
- Display name where applicable.
- Workspace relationship where applicable.
- Project or task context where applicable.
- Creator.
- Creation and update timestamps.
- Archive or lifecycle state where required.

Channel creation and management are administrator-controlled. Members cannot create channels by default unless explicitly authorised. Guests only access channels, conversations, and announcements explicitly shared with them.

Conversation membership must not be used to bypass workspace or project access rules. A user who belongs to a workspace does not automatically belong to every channel or project conversation in it.

### Conversation membership

Use an explicit membership model when conversations have multiple participants or membership-specific metadata.

Membership may track:

- Conversation.
- User.
- Conversation-specific role where necessary.
- Joined and left timestamps.
- Last-read position or timestamp where appropriate.
- Mute or notification preferences where supported.

Enforce uniqueness for active membership relationships where the business rules require it.

### Message model

Messages should have a durable identity and a clear relationship to their conversation and author.

Depending on the requirements, fields may include:

- Message identifier.
- Conversation identifier.
- Author identifier.
- Message content.
- Message type.
- Reply-to message identifier.
- Edit timestamp.
- Deletion timestamp or deletion state.
- Creation timestamp.
- Update timestamp.
- Client-generated idempotency identifier where needed.

Use appropriate indexes and constraints for the actual access patterns.

Do not store all messages in one JSON field on the conversation record.

## 6. Relationships and Context

Messaging must integrate with Nexus's workspace and project model.

Where applicable, support relationships such as:

- A conversation belonging to a workspace.
- A conversation associated with a project.
- A conversation associated with a task.
- A message having an author.
- A message replying to another message.
- A message referencing an attachment.
- A message mentioning one or more users.
- A message being converted into a task.

Use explicit relational modeling for persistent relationships.

Do not duplicate entire project, task, or user records inside message content.

When a message references a task or project, validate that the referenced record exists and that the user has permission to access it.

A valid foreign key does not by itself establish that two records belong to the same workspace. Validate workspace consistency in the service layer or through suitable database constraints.

## 7. Authentication and Conversation Authorization

Every protected messaging operation must identify the authenticated user and verify their permissions.

Requirements:

- Authenticate HTTP and real-time connections using the existing authentication system.
- Verify conversation membership before reading or sending messages.
- Enforce workspace, project, and resource access rules, including private projects and guest access.
- Enforce administrator control over channel creation, naming, membership, and archival.
- Prevent users from joining unauthorized real-time rooms.
- Prevent unauthorized access to message history, attachments, and search results.
- Validate participant invitations and membership changes.
- Enforce role-based restrictions for administrative conversation actions.
- Prevent users from impersonating another message author.
- Do not trust user IDs or workspace IDs supplied by untrusted clients.

Do not rely on frontend visibility or button restrictions for security.

Perform authorization checks on the server for every protected action, including actions initiated through sockets.

## 8. Real-Time Transport Architecture

Use the existing real-time server and event conventions. Socket.IO is the planned transport, but it is not installed yet; confirm the actual implementation before writing transport-specific code.

Keep socket event handlers thin. Delegate business rules, persistence, and authorization to reusable services.

Potential events include:

### Client-to-server events

- `conversation:join`
- `conversation:leave`
- `message:send`
- `message:edit`
- `message:delete`
- `message:read`
- `typing:start`
- `typing:stop`
- `message:react`

Use the existing event naming convention if one is already established.

### Server-to-client events

- `conversation:updated`
- `message:new`
- `message:updated`
- `message:deleted`
- `message:reaction-updated`
- `message:read-updated`
- `typing:updated`
- `presence:updated`

These are illustrative event names, not mandatory names if the project already uses different conventions.

Requirements:

- Validate every incoming payload.
- Authenticate the connection.
- Authorize access to the relevant conversation.
- Handle disconnects and reconnections.
- Avoid broadcasting private messages to unauthorized users.
- Use conversation-specific rooms only after access has been verified.
- Handle repeated events safely.
- Avoid broadcasting unnecessary sensitive data.
- Remove stale presence information when connections disappear, where appropriate.

Never treat possession of a conversation ID as proof of membership.

## 9. Message Persistence and Delivery

Persist a message before broadcasting it as a successfully created message.

A typical workflow is:

1. Authenticate the sender.
2. Validate the request.
3. Verify conversation membership and send permissions.
4. Validate referenced replies, attachments, and contextual records.
5. Persist the message in PostgreSQL.
6. Broadcast the persisted message to authorized conversation participants.
7. Update relevant unread state or notification records.
8. Return an acknowledgement containing the persisted message identifier and status.

Do not broadcast an unpersisted message as if it were safely stored.

Handle failures explicitly.

If a database operation fails, do not report successful message creation.

If the message is saved but real-time delivery fails, preserve the message and allow authorized clients to retrieve it through normal history queries or reconnect synchronization.

For systems that require stronger delivery guarantees, consider an outbox or another reliable event-dispatch mechanism.

Do not promise exactly-once delivery from the real-time transport alone.

## 10. Duplicate Prevention and Idempotency

Network interruptions and retries can cause clients to submit the same message more than once.

Where required, implement an idempotency strategy using a client-generated message identifier or another stable request key.

Requirements:

- Scope idempotency keys appropriately to the sender and conversation.
- Add database uniqueness constraints where suitable.
- Return the existing persisted result when a valid request is retried.
- Do not create duplicate notifications or task records from repeated events.
- Validate idempotency keys and reject invalid formats.

Do not rely exclusively on in-memory tracking because it does not reliably survive process restarts or multiple backend instances.

## 11. Message Editing and Deletion

Define clear rules for editing and deleting messages.

Requirements:

- Verify that the user has permission to modify the message.
- Enforce any applicable editing time limits or moderation rules.
- Preserve the distinction between edited and original messages where required.
- Define whether deletion is soft deletion or permanent deletion.
- Handle replies, attachments, reactions, and references consistently.
- Broadcast updates only to authorized conversation participants.
- Ensure that deleted messages do not unexpectedly reappear through history queries or caches.

Do not permanently delete audit-relevant records without considering retention and compliance requirements.

If messages can be converted into tasks or referenced by other records, define how deletion affects those relationships.

## 12. Read Receipts and Unread Counts

Implement read-state tracking in a way that fits the conversation model.

Potential approaches include:

- A per-member last-read message identifier.
- A per-member last-read timestamp.
- Per-message read receipts when individual message-level tracking is required.

Choose the simplest approach that meets the product requirements.

Requirements:

- Update read state only for authenticated conversation members.
- Validate that the referenced message belongs to the relevant conversation.
- Prevent unauthorized users from viewing other participants' read information.
- Calculate unread counts consistently.
- Handle messages arriving while a user is offline.
- Synchronize read state when a user reconnects.
- Avoid unnecessary database writes for repeated identical read updates.

Do not introduce per-message receipt records if a conversation-level read position satisfies the requirements.

## 13. Typing Indicators and Online Presence

Typing indicators and online presence are temporary states.

Use the existing real-time transport and, where needed, Redis for shared coordination across backend instances.

Requirements:

- Show typing status only to authorized conversation members.
- Clear typing status when a user stops typing, leaves, or disconnects.
- Prevent stale typing indicators from remaining indefinitely.
- Avoid broadcasting a typing event for every keystroke.
- Apply suitable throttling or debouncing.
- Support multiple active connections for the same user.
- Avoid marking a user offline simply because one of several connections disconnects.
- Avoid exposing unnecessary presence information across workspace boundaries.

Do not create a permanent PostgreSQL record for every typing event.

Use expiring temporary state when appropriate.

## 14. Replies, Threads, Mentions, and Reactions

### Replies and threads

- Validate that the referenced parent message exists.
- Verify that the parent message belongs to the same conversation.
- Enforce conversation authorization.
- Prevent invalid or cyclic reply relationships where relevant.
- Retrieve replies using efficient, paginated queries.

### Mentions

- Parse and validate mention references.
- Verify that mentioned users are eligible to participate in or access the conversation.
- Prevent unauthorized users from being added to conversations through mentions.
- Create appropriate notification records when the product rules require them.
- Avoid duplicate notifications from repeated processing.

### Reactions

- Validate supported reaction values.
- Verify conversation access.
- Enforce uniqueness where one reaction per user and message is the intended rule.
- Broadcast reaction updates only to authorized participants.

Do not treat mentions or reactions as permission-granting operations.

## 15. Attachments and File Security

Reuse the existing Nexus file-storage implementation.

Do not store large binary attachments directly in message records unless explicitly required by the architecture.

Requirements:

- Validate file type, size, and upload permissions.
- Verify that the uploader may attach the file to the conversation.
- Enforce access checks when retrieving attachments.
- Prevent unauthorized public access to private files.
- Use signed URLs or another secure retrieval mechanism where appropriate.
- Avoid trusting file extensions alone to establish file type.
- Apply malware scanning where required by the deployment and threat model.
- Handle attachment deletion and retention consistently.
- Do not expose permanent storage credentials or privileged storage URLs.

An attachment must not become accessible to a user merely because they know its identifier.

## 16. Connecting Messages to Tasks and Projects

A key Nexus capability is communication connected directly to work.

Where supported, allow authorized users to:

- Discuss a specific task in context.
- Reference projects and teams.
- Convert a message into a task.
- Link a discussion to a project decision.
- Share meeting follow-ups in the relevant conversation.

Requirements:

- Verify access to the related project or task.
- Reuse the existing task service and task workflow.
- Validate required task fields.
- Respect assignment and role permissions.
- Record the source message or conversation relationship where useful.
- Prevent duplicate task creation when requests are retried.
- Avoid creating tasks automatically from ordinary messages without explicit product authorization.

Do not duplicate task business logic inside the messaging service.

## 17. Notifications and Email Integration

Use the existing Nexus notification and emailing services.

### Mandatory separation

Direct messages, group messages, channel messages, project conversations, announcements, and message mentions belong in the **Messages** area. They must never create duplicate alerts in the general notification bell.

Message unread counts and general notification unread counts are independent. Marking messages as read must not clear general notifications, and clearing general notifications must not clear message unread counts.

Converting a message into a task may generate a general task notification because the resulting task is a general work event. The original message notification remains in Messages.

### Message notification triggers

Potential triggers include:

- New direct messages.
- Group and channel mentions.
- Replies to relevant messages.
- Invitations to conversations.
- Important task-linked discussions.
- Messages requiring attention.

Requirements:

- Respect user notification preferences and muted conversations or channels.
- Avoid sending email for every message by default.
- Deduplicate notifications where necessary, including repeated mention processing.
- Persist important message notification state before attempting real-time delivery.
- Handle offline recipients.
- Avoid exposing private message content in unauthorized notifications.
- Use email delivery only for appropriate offline or digest notifications where configured, and keep that email in the Messages category.

Do not create a separate notification database or email provider solely for messaging. Do not route message events through the general notification service merely because it already exists.

## 18. Message Search and Pagination

Message history must remain efficient as conversations grow.

Requirements:

- Paginate message history.
- Prefer cursor-based pagination for large or frequently updated conversations where appropriate.
- Use deterministic ordering, such as creation timestamp plus a unique identifier.
- Fetch only the required fields.
- Add indexes based on actual conversation, author, timestamp, and filtering patterns.
- Avoid retrieving all messages into application memory.
- Validate search terms and pagination limits.
- Restrict searches to conversations the requesting user is authorized to access.

Use PostgreSQL search capabilities or an approved search service according to the project's actual requirements.

Do not introduce a dedicated search engine without a demonstrated need.

## 19. Database Transactions and Consistency

Use Prisma transactions when multiple database operations must succeed or fail together.

Examples include:

- Creating a conversation and its initial memberships.
- Accepting an invitation and creating membership.
- Persisting a message and its required associated records.
- Converting a message into a task while recording the relationship.
- Creating a notification record with a related business operation where required.

Requirements:

- Keep transactions short.
- Avoid external network calls inside transactions.
- Use foreign keys and unique constraints.
- Handle concurrent requests and race conditions.
- Do not assume that several independent Prisma calls are atomic.
- Consider an outbox when reliable event dispatch is required.

Create and review migrations using the existing Prisma workflow.

Never reset a shared or production database to resolve an ordinary messaging issue.

## 20. Validation, Rate Limiting, and Abuse Prevention

Validate all HTTP and real-time input.

Validation should cover:

- Conversation identifiers.
- Message content and maximum lengths.
- Message types.
- Reply identifiers.
- Attachment references.
- Reaction values.
- Mentioned user identifiers.
- Pagination parameters.
- Membership and role changes.

Apply suitable rate limits to:

- Message creation.
- Conversation creation.
- Invitations.
- Reactions.
- Typing events.
- Search requests.
- Attachment uploads.

Use appropriate per-user, per-conversation, or per-IP limits depending on the operation.

Escape user-generated content before rendering it in HTML.

Never execute code or render untrusted message content as executable HTML.

Do not allow a user to bypass application rules by sending real-time events directly.

## 21. Security and Privacy

Follow these rules throughout implementation:

- Never trust client-supplied author identifiers.
- Never expose private conversation data through logs or unrestricted broadcasts.
- Never hardcode secrets.
- Keep credentials in environment variables or the approved secret-management system.
- Avoid logging full message content unless explicitly necessary and authorized.
- Apply workspace and conversation access checks to every retrieval operation.
- Protect message attachments independently of their parent messages.
- Avoid storing sensitive data in Redis longer than necessary.
- Define retention and deletion rules for messages and associated files.
- Avoid leaking conversation details through error responses.

Authorization must remain server-side and independent of frontend visibility.

## 22. Performance and Scalability

Design for increasing numbers of users, conversations, and messages.

Requirements:

- Use indexes aligned with actual queries.
- Paginate large result sets.
- Avoid N+1 query patterns.
- Keep socket event payloads reasonably small.
- Avoid broadcasting large conversation histories.
- Load older messages on demand.
- Use Redis adapters or equivalent shared real-time coordination when multiple backend instances require shared room delivery.
- Handle reconnection and message synchronization.
- Monitor slow queries and event-processing failures.
- Avoid excessive writes for typing indicators and repeated read receipts.

Do not add infrastructure prematurely. Scale based on demonstrated requirements.

## 23. Testing

Use the existing project test framework.

### Database tests

Verify:

- Conversation creation.
- Membership uniqueness.
- Message persistence.
- Reply relationships.
- Editing and deletion rules.
- Read-state updates.
- Attachment relationships.
- Task conversion consistency.

### Authorization tests

Verify:

- Non-members cannot retrieve messages.
- Unauthorized users cannot join private real-time rooms.
- Cross-workspace access is denied.
- Users cannot impersonate message authors.
- Unauthorized users cannot edit or delete messages.
- Attachments cannot be retrieved without permission.

### Real-time tests

Verify:

- Messages are broadcast after persistence.
- Database failures do not produce false success.
- Unauthorized events are rejected.
- Repeated requests do not create duplicate records.
- Reconnection allows users to retrieve missed messages.
- Typing and presence states are cleaned up correctly.

### Reliability tests

Verify:

- Notification failures do not corrupt saved messages.
- Duplicate events are handled safely.
- Pagination produces consistent ordering.
- Rate limits are enforced.
- Concurrent operations preserve database integrity.

Mock external services where appropriate. Do not send real emails or upload unintended files during tests.

## 24. Required Implementation Workflow

For every messaging task:

1. Read `AGENTS.md` and `PHASES.md`.
2. Confirm the current Git branch and never implement directly on `main`.
3. Identify the relevant phase and acceptance criteria.
4. Inspect existing models, services, real-time handlers, and notification code.
5. Define the data relationships and authorization rules, including workspace type and guest access.
6. Plan database, API, and real-time event changes.
7. Implement the smallest coherent change.
8. Add schema migrations where required.
9. Validate HTTP and socket payloads.
10. Add persistence, idempotency, and error handling.
11. Implement message notifications through the Messages area, without duplicating them into general notifications.
12. Implement file handling through existing private-storage services.
13. Add unit and integration tests, including cross-workspace denial and duplicate notification checks.
14. Run relevant validation, tests, and build checks.
15. Document changed events, API behavior, and any configuration requirements.
16. Update `PHASES.md` only when the relevant acceptance criteria have been met.
17. Commit and push the feature branch; never merge into `main` without explicit authorisation.

## 25. Definition of Done

A messaging feature is complete when all applicable requirements are satisfied:

- Messages are persisted correctly.
- Conversation relationships are valid.
- Authorization is enforced on HTTP and socket operations.
- Workspace isolation is maintained.
- Real-time delivery works as intended.
- Failed delivery does not destroy persisted messages.
- Duplicate submissions are handled appropriately.
- Read receipts, typing, and presence behave consistently where implemented.
- Message notifications remain in the Messages area and are not duplicated in general notifications.
- Message and general notification unread counts remain independent.
- Notifications respect existing preferences and services.
- Attachments are protected.
- Database migrations are reviewed where required.
- Relevant tests pass, or remaining failures are documented.
- No secrets or private message content are unnecessarily exposed.
- Documentation reflects the actual implementation.
- Changes are committed and pushed to the correct feature branch, not `main`.

## 26. Required Agent Behavior

Always inspect the existing Nexus implementation before changing messaging functionality.

Prefer incremental changes and preserve existing features.

Do not introduce new infrastructure without a clear requirement.

Do not claim real-time messaging works merely because a real-time server starts. Verify persistence, authorization, delivery, and reconnection behavior where relevant.

Before destructive database changes, explain the risk and obtain explicit approval.

After completing a task, report:

- What functionality was implemented.
- Which models, routes, services, and socket events changed.
- Which migrations were created.
- Which tests were run and their results.
- Any incomplete work, configuration requirements, or deployment steps remaining.
