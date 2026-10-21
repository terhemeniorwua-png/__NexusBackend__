---
name: nexus-emailing
description: Email engineering instructions for the Nexus backend. Use when implementing email delivery, verification, password resets, workspace invitations, notifications, email templates, delivery retries, or email provider integrations.
---

# Nexus Emailing Skill

## 1. Purpose

This skill defines how email functionality must be designed, implemented, tested, and maintained in the Nexus backend.

Nexus is a real-time workspace and project management platform. Email supports account security, collaboration, invitations, meeting coordination, and important activity notifications.

Email must be reliable, secure, maintainable, and consistent with the existing backend architecture.

Follow this skill whenever implementing or modifying email-related functionality.

## 2. Technology and Existing Architecture

Use the existing project configuration as the source of truth.

- Runtime: Node.js
- Backend: Express.js
- Language: TypeScript
- Primary database: PostgreSQL
- ORM: Prisma
- Cache and temporary coordination: Redis
- Real-time events: Socket.IO
- Email provider: Use the provider already configured in the project. If none exists, propose a suitable provider before introducing one.

Do not replace existing email infrastructure without a clear reason and explicit approval.

Do not introduce a second email provider or queue system unnecessarily.

## 3. Inspect Before Implementing

Before making email-related changes:

1. Read `agent.md` and `PHASES.md`.
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

Use a structure consistent with the existing repository. A possible organization is:

emailing/
- SKILL.md
- templates/
- services/
- providers/
- utils/

Do not create every suggested directory if the repository already has an established structure.

Responsibilities should be separated as follows:

- **Provider:** Communicates with the configured email service.
- **Email service:** Exposes reusable functions for sending emails.
- **Templates:** Define reusable email content and layouts.
- **Business services:** Decide when an email should be sent.
- **Queue or worker:** Handles asynchronous delivery when the infrastructure supports it.
- **Tests:** Verify email content, delivery behavior, and failure handling.

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

- Workspace invitations.
- Team invitations.
- Project-related invitations where applicable.
- Invitation acceptance or expiration notices when needed.

An invitation must be associated with the correct workspace, inviter, recipient, and permission level.

### Work and project notification emails

Support configurable notifications for events such as:

- Task assignment.
- Task mentions and comments.
- Task status changes requiring attention.
- Project invitations.
- Important workspace announcements.
- Meeting invitations and schedule changes.
- Relevant document or collaboration updates.

Use the actual notification preferences and event rules defined by Nexus.

Do not email users about every Socket.IO event automatically.

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
- Validate the target workspace and any applicable team or project.
- Enforce the allowed roles and invitation permissions.
- Prevent unauthorized privilege escalation.
- Associate the invitation with the intended recipient.
- Define expiration, acceptance, revocation, and duplicate-invitation behavior.
- Ensure that accepting an invitation cannot create unauthorized duplicate memberships.
- Revalidate relevant authorization and invitation state when the invitation is accepted.
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

Nexus may support both in-app notifications and email notifications.

Treat them as related but distinct delivery channels.

- In-app notifications should use the existing notification model and real-time delivery architecture.
- Email notifications should use the email service.
- Notification preferences should determine which optional channels are enabled.
- Socket.IO events must not be treated as a substitute for persistent notification records.
- Email delivery failures should not erase an already-persisted notification.
- Do not send duplicate emails simply because the same event is delivered more than once.

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

1. Inspect the repository and existing email infrastructure.
2. Identify the relevant phase in `PHASES.md`.
3. Define the triggering business event and intended recipient.
4. Determine whether the email is mandatory, optional, or preference-controlled.
5. Design the template and server-side workflow.
6. Implement the provider integration or reuse the existing service.
7. Add database changes only when justified.
8. Add background processing, retry logic, or deduplication when needed.
9. Implement authorization and rate limiting.
10. Write tests for successful and unsuccessful delivery.
11. Run the relevant checks and report any failures.
12. Update documentation and phase progress only when the acceptance criteria have been met.

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
- Required documentation is updated.

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
