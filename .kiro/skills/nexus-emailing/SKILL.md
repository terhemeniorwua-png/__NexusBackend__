---
name: nexus-emailing
description: Email engineering instructions for the Nexus backend. Use when implementing email delivery, email verification, password resets, workspace and organisation invitations, join-request decisions, billing and subscription notices, meeting and notification emails, templates, delivery retries, webhook verification, or email provider integrations across Individual, Company and Institution workspaces.
---

# Nexus Emailing Skill

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

This skill defines how email functionality must be designed, implemented, tested, and maintained in the Nexus backend.

Nexus is a general-purpose Real-Time Workspace & Project Management Platform serving Individual, Company, and Institution workspaces from one shared backend. Email supports account security, collaboration, invitations and join requests, meeting coordination, billing, and important activity notifications.

Email must be reliable, secure, maintainable, and consistent with the existing backend architecture. It must never be used as a shortcut around server-side authorization, and email content must respect workspace isolation.

Follow this skill whenever implementing or modifying email-related functionality.

## 2. Technology and Existing Architecture

Use the existing project configuration as the source of truth.

- Runtime: Node.js
- Backend: Express.js
- Language: TypeScript
- Primary database: PostgreSQL
- ORM: Prisma
- Cache and temporary coordination: Redis
- Real-time events: the existing WebSocket/real-time implementation. Socket.IO is planned but not yet installed.
- Email provider: Nodemailer or the provider already configured behind the existing delivery service and adapter.

Do not replace existing email infrastructure without a clear reason and explicit approval.

Do not introduce a second email provider or queue system unnecessarily.

## 3. Inspect Before Implementing

Before making email-related changes:

1. Read `AGENTS.md` and `PHASES.md`.
2. Inspect `package.json` and the installed dependencies.
3. Check the existing authentication and notification implementations.
4. Inspect the Prisma schema for users, workspaces, memberships, invitations, and notification records.
5. Check whether an email service, template directory, queue, or provider integration already exists.
6. Inspect the existing environment variable names and configuration patterns.
7. Identify the relevant implementation phase and acceptance criteria.

Reuse existing services and conventions wherever possible.

Do not duplicate email transport configuration or create competing notification systems.

## 4. Email Service Architecture

Keep email delivery separate from route handlers and business logic.

Use a structure consistent with the existing repository. The repository currently organizes email code under `src/services/email/`, with provider transports under `src/services/providers/email/`, templates under `src/services/email/templates/`, and delivery, logging, suppression, and webhook support alongside them.

Inspect the actual tree before adding files. A typical separation is:

- **Provider/transport:** Communicates with the configured email service.
- **Delivery service:** Exposes reusable functions for sending and tracking emails.
- **Templates:** Define reusable email content and layouts.
- **Business services and notifiers:** Decide when an email should be sent.
- **Worker or queue:** Handles asynchronous delivery and retries when supported.
- **Tests:** Verify email content, delivery behavior, privacy, and failure handling.

Do not create a parallel `emailing/` directory or every suggested folder if the repository already has an established structure.

Routes should not contain large HTML email templates or provider-specific implementation details.

## 5. Required Email Use Cases

Design email functionality around actual Nexus requirements.

### Account and authentication emails

Support these where required by the authentication design:

- Email address verification.
- Password reset.
- Password or security change notifications.
- Account-related security alerts.
- Optional sign-in alerts when explicitly included in the product requirements.

Verification and password-reset links or codes must be generated and validated securely.

### Workspace collaboration emails

Support:

- Workspace invitations for Individual, Company, and Institution workspaces.
- Join requests and approval or rejection decisions.
- Team, department, and project invitations where applicable.
- Invitation reminders, acceptance, revocation, and expiration notices when needed.
- Ownership transfer and privileged role-change notices.
- Organisation membership removal notifications where required.

An invitation must be associated with the correct workspace, inviter, recipient, and permission level. Join-request emails must go only to administrators authorised to decide the request.

### Work and project notification emails

Support configurable notifications for events such as:

- Task assignment.
- Task mentions and comments.
- Task status changes requiring attention.
- Project invitations.
- Meeting invitations, reminders, rescheduling, and cancellation.
- Relevant document or collaboration updates.
- Billing, trial, payment, renewal, failure, and subscription entitlement notices.
- Security changes and administrative actions.

Workspace announcements are delivered through the Messages area, not as general notification emails.

Use the actual notification preferences and event rules defined by Nexus.

Do not email users about every real-time event automatically.

Message emails (new direct message, group message, channel message, or message mention) are part of the Messages experience. They must not be repurposed as general notification emails, and they must not cause duplicate general notification alerts.

### Email preferences

Where email notifications are configurable, respect user preferences and notification categories.

Security-critical emails may have different rules from optional activity notifications. Define those rules explicitly rather than applying a blanket opt-out policy.

## 6. Secure Verification and Password Reset

Authentication emails require special care.

For verification and password-reset workflows:

- Generate tokens using cryptographically secure randomness.
- Give tokens a defined expiration time.
- Store only a hash of a token when using a token-based design, where practical.
- Associate each token with the intended user and purpose.
- Make tokens single-use.
- Invalidate tokens after successful use.
- Avoid placing passwords or sensitive personal information in emails.
- Never send a user's existing password.
- Rate-limit requests for verification emails and password resets.
- Avoid revealing whether an email address belongs to an account in public authentication responses.
- Use HTTPS for production links.
- Validate tokens on the server, not only in the frontend.

Do not use predictable IDs, timestamps, or ordinary random-number functions as security tokens.

Never log complete verification tokens, password-reset tokens, or sensitive email links.

## 7. Workspace Invitations and Authorization

Workspace invitations must respect Nexus's permission model.

Requirements:

- Verify that the inviter is authorized to invite members.
- Validate the target workspace and any applicable team, department, or project.
- Enforce the allowed roles and invitation permissions for Company and Institution workspaces.
- Prevent unauthorized privilege escalation, including attempts to invite or promote an administrator.
- Associate the invitation with the intended recipient and correct workspace.
- Define expiration, acceptance, revocation, and duplicate-invitation behavior.
- Ensure that accepting an invitation cannot create unauthorized duplicate memberships.
- Revalidate the inviter's permissions and the invitation state when the invitation is accepted.
- Handle join requests separately: notify only administrators authorised to decide, and revalidate that permission before sending.
- Transfer ownership only through an explicit authorised workflow; never through an invitation link alone.
- Use database constraints and transactions where needed to preserve consistency.

Do not trust a role, workspace ID, or inviter identity supplied directly by an untrusted client.

## 8. Email Templates and Content

Use reusable, maintainable templates.

Every template should have an appropriate:

- Subject.
- HTML body.
- Plain-text alternative.
- Brand identity and consistent styling.
- Clear call to action where required.
- Fallback text for email clients that do not render HTML.
- Footer and support information where applicable.

Use Nexus's existing design system and brand assets when available.

Email layouts should be responsive and readable on mobile devices.

Keep important information understandable without relying entirely on images, color, or complex formatting.

Escape user-provided content before inserting it into HTML templates.

Do not render arbitrary user-supplied HTML as trusted content.

Use absolute HTTPS URLs for production assets and links.

Do not invent support email addresses, company addresses, or other contact details. Use configured project values.

## 9. Email Provider Integration

Keep provider-specific code behind a reusable service or adapter.

Requirements:

- Read credentials from environment variables.
- Validate required configuration at startup or when initializing the provider.
- Handle provider errors and rejected requests.
- Set sensible request timeouts where supported.
- Distinguish accepted messages from delivered messages.
- Record provider message IDs when useful.
- Avoid logging credentials or sensitive message contents.
- Use sandbox or test modes during development where available.

A successful provider API response does not necessarily mean that the recipient received or read the email.

Never hardcode provider API keys or SMTP credentials.

Do not commit real email credentials to GitHub.

## 10. Background Jobs, Retries, and Reliability

Email delivery should not unnecessarily block API requests.

Use an existing queue or background worker when available and appropriate.

If Redis-backed queues are configured, follow the project's existing queue architecture rather than creating a competing system.

Requirements:

- Separate durable business operations from email delivery.
- Retry transient provider failures with bounded exponential backoff and jitter where supported.
- Do not retry permanent failures indefinitely.
- Define a maximum retry count.
- Track failed jobs and provide a recovery strategy.
- Make retry behavior safe against duplicate emails.
- Avoid sending multiple copies of the same notification when a job is retried.
- Do not mark an email as delivered simply because it was queued.
- Use provider webhooks when delivery, bounce, or complaint events need to be tracked and the provider supports them.

A database transaction and an email API call cannot automatically form one atomic operation.

For important workflows, consider a transactional outbox: save the business change and the pending email event in the same PostgreSQL transaction, then let a worker deliver the email.

Use this pattern when the reliability requirements justify the additional infrastructure.

## 11. Email and Database Consistency

Keep persistent email-related records consistent with the existing Prisma schema.

Depending on the requirements, records may include:

- Email verification token hashes and expiry times.
- Password-reset token hashes and expiry times.
- Workspace invitations and their states.
- Notification preferences.
- Email delivery or outbox records.
- Provider message IDs and delivery statuses.

Do not store plaintext security tokens unnecessarily.

Do not create a database model for every email type without a clear requirement.

Use transactions when an email-related database operation involves multiple dependent writes.

Create migrations using the established Prisma migration workflow.

Never reset a shared database or delete migration history to implement an email feature.

## 12. Notification Channels

Nexus supports both in-app notifications and email notifications.

Treat them as related but distinct delivery channels.

- In-app notifications should use the existing notification model and real-time delivery architecture.
- Email notifications should use the email service.
- Notification preferences should determine which optional channels are enabled.
- Real-time events must not be treated as a substitute for persistent notification records.
- Email delivery failures should not erase an already-persisted notification.
- Do not send duplicate emails simply because the same event is delivered more than once.
- Keep the Messages area separate from general notifications. Direct messages, group messages, channel messages, project conversations, announcements, and message mentions belong to Messages; they must not create duplicate general notification records or emails.
- General notification emails cover task, meeting, membership, security, billing, file-sharing, and similar events, with independent unread state from messages.

Where appropriate, use a shared notification service that coordinates channels without coupling the business logic to a specific email provider.

## 13. Rate Limiting and Abuse Prevention

Protect endpoints and workflows that trigger emails.

Apply appropriate limits to:

- Verification requests.
- Password-reset requests.
- Invitation creation.
- Repeated notification-triggering actions.
- Resend operations.

Consider per-account, per-recipient, and per-IP limits as appropriate.

Avoid unrestricted bulk email functionality.

Validate recipients and restrict email content to authorized business operations.

Use provider suppression lists or bounce-handling mechanisms where supported.

Never expose an endpoint that lets arbitrary users send arbitrary emails through Nexus's provider credentials.

## 14. Logging and Observability

Record useful operational information without exposing sensitive content.

Where appropriate, track:

- Email type.
- Recipient identifier.
- Provider message ID.
- Queue or job ID.
- Attempt count.
- Delivery state.
- Failure category.
- Timestamps.

Avoid recording passwords, raw security tokens, full reset links, API keys, or unnecessary message contents.

Distinguish between queued, accepted by provider, delivered, bounced, and permanently failed states whenever the available provider information supports those distinctions.

Do not claim delivery success without evidence.

## 15. Testing

Use the project's existing testing framework.

Test email functionality at appropriate levels.

### Unit tests

Verify:

- Template rendering.
- Subject and content generation.
- Recipient selection.
- Notification preference handling.
- Token creation and validation.
- Retry classification.
- Duplicate-prevention logic.

### Integration tests

Verify:

- The email service calls the configured provider adapter correctly.
- Authentication flows create and consume verification or reset tokens correctly.
- Workspace invitation permissions are enforced.
- Database transactions preserve consistency.
- Failed email delivery does not corrupt business records.
- Duplicate events do not generate duplicate notifications where deduplication is required.

### Security tests

Verify:

- Expired tokens are rejected.
- Used tokens cannot be reused.
- Unauthorized users cannot issue invitations.
- Cross-workspace invitations are rejected when unauthorized.
- Rate limits are enforced.
- Sensitive tokens and credentials do not appear in logs.

Use mocked providers or a sandbox environment during automated tests. Never send real emails to unintended recipients in tests.

## 16. Required Implementation Workflow

For every email-related task:

1. Inspect `AGENTS.md`, `PHASES.md`, the repository, and existing email infrastructure.
2. Confirm the current Git branch; never work directly on `main`.
3. Define the triggering business event and intended recipient.
4. Determine whether the email is mandatory, optional, or preference-controlled.
5. Design the template and server-side workflow.
6. Implement the provider integration or reuse the existing service.
7. Add database changes only when justified.
8. Add background processing, retry logic, or deduplication when needed.
9. Implement authorization, workspace isolation, and rate limiting.
10. Write tests for successful and unsuccessful delivery.
11. Run the relevant checks and report any failures.
12. Update documentation and `PHASES.md` only when the acceptance criteria have been met.
13. Commit and push the feature branch; never merge into `main` without explicit authorisation.

## 17. Definition of Done

An email feature is complete when all applicable requirements are satisfied:

- The correct business event triggers the email.
- The intended recipient is selected securely.
- The template renders correctly.
- Provider configuration uses environment variables.
- Errors are handled without corrupting business data.
- Security tokens and invitation permissions are validated.
- Duplicate delivery risks are addressed.
- Notification preferences are respected where applicable.
- Relevant tests pass, or remaining failures are documented.
- No credentials or sensitive tokens are exposed.
- Workspace isolation and invitation permissions are verified.
- Message notifications remain separate from general notification emails.
- Required documentation is updated, and the work is committed to the correct feature branch.

## 18. Required Agent Behavior

Before implementing an email feature, inspect the existing architecture rather than assuming the provider, folder structure, queue, or data models.

Prefer small, focused changes that preserve existing functionality.

Do not introduce unnecessary dependencies or additional infrastructure.

Do not send real emails, change production provider settings, or perform destructive database operations without appropriate authorization.

If a critical requirement is unclear, ask a focused question instead of inventing product behavior.

After completing the task, report:

- What email functionality was implemented.
- Which services, templates, and models were changed.
- Which environment variables are required.
- Which tests were run and their results.
- Any provider configuration or deployment steps still required.
