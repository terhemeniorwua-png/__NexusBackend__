# NEXUS BACKEND — AI CODING AGENT INSTRUCTIONS

## 1. Purpose

This document defines the mandatory rules and development standards for any AI coding agent working on the Nexus backend.

The agent is responsible for implementing, maintaining, debugging, testing, and improving the backend while preserving the existing architecture, functionality, security, and project decisions.

These instructions must be followed throughout every development session.

**The agent must read and understand this document before inspecting or modifying the codebase.**

---

## 2. Project Overview

Nexus is a Real-Time Workspace & Project Management Platform that combines:

- Project and task management.
- Team and organisational collaboration.
- Real-time messaging.
- Audio and video meetings.
- File and document management.
- Calendar and scheduling.
- Forms and surveys.
- Notifications and activity tracking.
- Global search.
- Third-party integrations.
- Subscription and billing management.
- AI-powered productivity and assistance.

Nexus supports three workspace types:

1. Individual.
2. Company.
3. Institution.

These are different workspace experiences within one platform, not separate applications.

The backend must support these experiences through a shared, secure, scalable architecture.

---

## 3. Technology Stack

### Main Backend

- Node.js.
- Express.js.
- TypeScript.
- PostgreSQL.
- Redis.
- REST APIs.
- WebSockets or the existing real-time communication implementation.
- Background job processing.
- Private object storage.

### AI Service

- Python.
- FastAPI.
- Managed AI APIs.
- Independently deployable service.

### Supporting Services

- Managed audio/video calling SDK.
- Payment provider.
- Email delivery provider.
- Google and Microsoft integrations.
- Private object storage provider.

### Mandatory Stack Rules

- The main application backend must remain TypeScript.
- Do not convert TypeScript files to JavaScript.
- Do not migrate the Express backend to Python.
- Python is reserved for the independent AI service.
- Do not replace Express.js with another backend framework.
- Do not replace PostgreSQL with another database.
- Do not introduce Prisma, Sequelize, TypeORM, or another ORM without first inspecting the existing repository and obtaining approval if a replacement is required.
- Use the repository's existing ORM, database driver, migration framework, and established conventions.
- Do not introduce unnecessary dependencies.

---

## 4. Documentation That Must Be Read

Before starting any implementation task, the agent must read:

1. `agent.md`
2. `README.md`
3. `phases.md`
4. The available branding documentation.
5. Relevant architecture and feature documentation.
6. Relevant module-specific documentation.

The agent must inspect the actual repository before making implementation decisions.

### Documentation Rules

- Treat `agent.md` as the mandatory development instruction file.
- Treat `README.md` as the backend architecture and technical reference.
- Treat `phases.md` as the authoritative implementation roadmap and progress tracker.
- Treat branding and product documentation as the source of truth for product behaviour and decisions.
- Treat the existing source code as evidence of what has actually been implemented.
- Do not assume that an item documented in README is already implemented.
- Do not invent product requirements when the documentation is unclear.

If documentation conflicts with the existing implementation or another documented decision, investigate the conflict and report it before making a potentially breaking change.

---

# 5. PHASE-BASED DEVELOPMENT

The backend must be developed according to `phases.md`.

### Mandatory Rules

1. Identify the current active phase before implementation.
2. Work only on the active phase.
3. Read all requirements and dependencies for that phase.
4. Inspect the existing implementation before creating new files or modifying existing files.
5. Complete the active phase before moving to the next phase.
6. Do not automatically start the next phase.
7. Update `phases.md` after completing or blocking a phase.
8. Do not mark incomplete functionality as completed.
9. Do not implement future enhancements unless explicitly authorised.

### Phase Statuses

Use only these statuses:

- `NOT STARTED`
- `IN PROGRESS`
- `BLOCKED`
- `COMPLETED`

### Before Starting a Phase

The agent must:

- Identify the phase requirements.
- Identify relevant existing modules.
- Identify dependencies on previously completed phases.
- Identify affected database models and migrations.
- Identify API and frontend integration implications.
- Identify security and permission implications.
- Identify relevant tests.

### When a Phase Is Blocked

The agent must:

- Stop work on the blocked requirement.
- Preserve existing working code.
- Explain the blocker.
- Explain its impact.
- Identify what is required to resolve it.
- Update the tracker to `BLOCKED`.
- Avoid silently skipping the requirement.

---

# 6. MANDATORY GIT AND GITHUB WORKFLOW

**The agent must NEVER implement or commit development changes directly to the `main` branch.**

Every implementation task must be carried out on a dedicated Git feature branch.

This rule applies to all phases, bug fixes, improvements, refactoring, and documentation changes.

## 6.1 Before Making Any Changes

The agent must:

1. Inspect the current Git status.
2. Identify the current branch.
3. Inspect the configured Git remote.
4. Check whether there are uncommitted user changes.
5. Fetch the latest remote branch information.
6. Check whether the current branch is up to date.
7. Create a dedicated branch for the task.

Example:

```bash
git status
git branch --show-current
git remote -v
git fetch origin
```

Do not discard, overwrite, or reset uncommitted user changes.

If there are uncommitted changes that may belong to the user, preserve them. Do not include them in the agent's commit.

## 6.2 Branch Creation

Always create a new branch for the task before implementation.

Use descriptive branch names.

Recommended formats:

```text
feature/phase-1-core-infrastructure
feature/phase-8-project-management
feature/phase-10-realtime-messaging
fix/phase-11-notification-duplication
refactor/database-query-optimisation
docs/backend-api-documentation
```

For a new phase, use:

```bash
git switch -c feature/phase-N-short-description
```

Before creating the branch, verify that the branch name does not already exist.

If a branch already exists, inspect it and determine whether it belongs to the current task. Never overwrite another developer's branch or discard its work.

## 6.3 Main Branch Protection

The following rules are mandatory:

- Never commit implementation changes directly to `main`.
- Never push development changes directly to `main`.
- Never merge feature branches into `main` without explicit user authorisation.
- Never force-push to `main`.
- Never reset `main` to another commit.
- Never rewrite shared Git history.
- Never delete remote branches without explicit authorisation.
- Never use commands that silently discard user changes.

The `main` branch must remain protected from direct agent development work.

## 6.4 Implementation and Commits

After completing the assigned phase or task:

1. Review the changes.
2. Inspect the complete Git diff.
3. Remove accidental changes unrelated to the task without destroying pre-existing user work.
4. Check for secrets and sensitive files.
5. Run relevant tests and quality checks.
6. Stage only files related to the task.
7. Commit the changes to the current feature branch.

Suggested commit formats:

```text
feat(phase-N): implement [feature name]
fix(phase-N): resolve [issue]
refactor(phase-N): improve [module]
test(phase-N): add [test coverage]
docs(phase-N): update [documentation]
```

Do not create meaningless commits such as:

```text
update
changes
fixed
work done
```

## 6.5 Push to the Feature Branch

After committing, push the current branch to the configured GitHub remote.

Example:

```bash
git push -u origin HEAD
```

The agent must verify that the push succeeded.

Never substitute `main` as the push destination.

If the push fails:

- Preserve the local commit.
- Do not delete the branch.
- Do not force-push.
- Report the exact error.
- Explain what is needed to resolve it.

## 6.6 Pull Requests and Merging

After pushing:

- Report the branch name.
- Report the commit hash.
- Report the push status.
- Provide the GitHub pull request URL if one was created or can be verified.
- Do not merge the pull request automatically.
- Wait for explicit user authorisation before merging into `main`.

If the repository supports GitHub CLI and authentication is available, the agent may create a pull request targeting `main` when appropriate.

Creating a pull request does not grant permission to merge it.

## 6.7 Branch Continuity

When continuing work on an existing phase:

- Inspect the current branch.
- Confirm that it is the correct branch for the active task.
- Preserve its existing commits.
- Do not create unnecessary duplicate branches.
- Do not switch to `main` to perform implementation work.

If the user explicitly requests a different branch strategy, follow that instruction.

---

# 7. PRESERVING EXISTING CODE AND FUNCTIONALITY

The agent must be conservative when modifying existing code.

### Mandatory Rules

- Do not delete existing files simply because they are unfamiliar.
- Do not remove existing features while implementing new ones.
- Do not replace working implementations without a clear technical reason.
- Do not rewrite entire modules when a focused change is sufficient.
- Do not rename folders, files, routes, or services unnecessarily.
- Do not change existing API contracts without documenting the reason.
- Do not remove existing environment variables.
- Do not overwrite existing configuration.
- Do not change the application's architecture without approval.
- Do not introduce breaking changes without explaining their impact.

### Before Modifying Existing Functionality

The agent must:

1. Inspect the current implementation.
2. Understand its dependencies.
3. Identify its consumers.
4. Identify related API endpoints.
5. Identify database dependencies.
6. Identify existing tests.
7. Plan the smallest safe change.

If an existing feature must be modified, preserve its intended behaviour unless the task explicitly requires a change.

### Environment Files

Environment files are especially sensitive.

- Never delete `.env`.
- Never overwrite `.env`.
- Never replace existing environment values with placeholders.
- Never print secret values.
- Never commit `.env` or other files containing credentials.
- Update `.env.example` or the existing example configuration safely.
- Add new variables without removing existing ones.
- Report any missing environment variable without inventing its production value.

If an environment configuration change is necessary, explain the required addition or modification.

---

# 8. BACKEND ARCHITECTURE RULES

## 8.1 Express Backend Responsibilities

Express is the authoritative application backend.

It is responsible for:

- Authentication.
- Authorisation.
- User identity.
- Workspace management.
- Organisation membership.
- Projects and tasks.
- Messaging.
- Notifications.
- Files and documents.
- Calendar and meetings.
- Billing and subscriptions.
- Integrations.
- Application data persistence.
- Audit logging.
- API access control.

## 8.2 AI Processing Responsibilities

AI processing can run either in-process in this backend (`AI_PROVIDER=openrouter`, calling OpenRouter
directly) or in the optional independently deployable Python/FastAPI service (`AI_PROVIDER=service`).
The Express backend owns authentication, authorisation, user identity, workspace context preparation
and all application mutations regardless of which AI provider is active.

AI-related processing includes:

- AI conversations.
- Retrieval-augmented generation.
- Contextual assistance.
- Document analysis.
- Meeting summarisation.
- Writing assistance.
- Grammar analysis.
- Tone analysis.
- Rewriting.
- Summarisation.
- Recommendations.
- AI action proposals.

The Python service must remain independently deployable.

Do not move ordinary application business logic into Python.

## 8.3 Express and AI Provider Communication

- Express authenticates users.
- Express verifies user permissions.
- Express prepares authorised context.
- Express communicates with the AI provider through controlled service interfaces.
- The AI provider must not independently bypass application authorisation.
- The AI provider must not directly modify the main application database by default.
- Express remains responsible for application mutations.
- AI actions must be validated and authorised again by Express.
- `AI_PROVIDER=openrouter` runs AI in-process via OpenRouter; `AI_PROVIDER=service` keeps the
  Python/FastAPI service optional. Core Nexus features continue working when no AI provider is
  configured.

## 8.4 Database Rules

- PostgreSQL is the primary application database.
- Use the existing ORM and migration system.
- Use migrations for schema changes.
- Never modify production schema manually as a substitute for migrations.
- Use transactions for operations requiring atomicity.
- Add indexes based on actual query requirements.
- Avoid unnecessary database queries.
- Prevent N+1 query problems.
- Ensure workspace and resource relationships are enforced.

## 8.5 Redis Rules

Redis may be used for:

- Caching.
- Rate limiting.
- Real-time coordination.
- Temporary data.
- Background job infrastructure.
- Presence and ephemeral state.

Redis must not replace PostgreSQL as the permanent source of truth for messages, notifications, or other durable application data.

## 8.6 Storage Rules

- Use private object storage for private files.
- Keep storage credentials on the server.
- Do not expose private bucket credentials.
- Validate access before generating signed URLs.
- Store file metadata in PostgreSQL.
- Never trust client-provided storage paths.
- Enforce workspace and project file permissions.

---

# 9. MULTI-WORKSPACE AND DATA ISOLATION

Nexus supports Individual, Company, and Institution workspaces.

The agent must always preserve workspace isolation.

### Mandatory Rules

- A user's personal workspace is independent of organisation membership.
- Users may belong to multiple workspaces.
- Organisation membership does not automatically grant access to every project.
- Project visibility must be respected.
- Team and department restrictions must be enforced.
- Private projects must remain private.
- Guests must access only explicitly shared resources.
- Organisation administrators must not automatically gain access to private resources unless authorised.
- Removing a user from an organisation must revoke their access to organisation resources.
- Membership removal must not delete the user's personal account or workspace.

Every resource query must enforce the appropriate workspace and resource-level access rules.

Never rely solely on frontend filtering.

---

# 10. ROLES AND PERMISSIONS

The agent must follow the role and permission rules documented in the product documentation.

### Company Roles

- Owner.
- Admin.
- Team Lead.
- Member.
- Guest.

### Institution Roles

- Owner.
- Institution Admin.
- Department Admin.
- Team/Group Lead.
- Member.
- Guest.

### Mandatory Ownership Rules

- Admins may remove ordinary members and guests.
- Only the Owner may remove or demote another administrator.
- Admins cannot remove the Owner.
- Team Leads cannot remove organisation members unless specifically granted that permission.
- The Owner retains ultimate organisation control.

### Authorisation Requirements

- Enforce permissions in backend services.
- Validate permissions for every sensitive operation.
- Prevent privilege escalation.
- Prevent insecure direct object reference vulnerabilities.
- Do not assume that knowing a resource ID grants access.
- Recheck permissions during asynchronous operations where appropriate.
- Recheck permissions before executing approved AI actions.

---

# 11. MESSAGING AND NOTIFICATION RULES

Messaging notifications and general notifications must remain separate.

### Messages Area

The Messages area handles:

- Direct messages.
- Group messages.
- Channel messages.
- Message replies.
- Message mentions.
- Message unread counts.

### General Notification Area

The general notification system handles events such as:

- Task assignments.
- Task comment mentions.
- Meeting invitations and changes.
- Organisation join decisions.
- Important file-sharing events.
- Security and permission changes.
- Other important workspace activities.

### Mandatory Separation

- Direct messages must not appear in general notifications.
- Group messages must not appear in general notifications.
- Channel messages must not appear in general notifications.
- Message @mentions must not create duplicate general notification alerts.
- Message unread counts must remain independent of general notification unread counts.
- Converting a message into a task may generate a general task notification.

Do not merge these notification systems into one unread-count mechanism.

---

# 12. SECURITY REQUIREMENTS

Security must be considered in every phase.

The agent must:

- Validate all incoming data.
- Authenticate protected endpoints.
- Enforce authorisation server-side.
- Hash passwords securely.
- Protect access and refresh tokens.
- Apply rate limits to sensitive endpoints.
- Validate uploaded files.
- Verify payment webhooks.
- Verify external integration webhooks.
- Protect against SQL injection.
- Protect against cross-site scripting where applicable.
- Protect against CSRF where applicable.
- Configure CORS appropriately.
- Avoid leaking internal errors.
- Avoid exposing secrets.
- Use secure cookie settings where cookies are used.
- Apply safe session and token invalidation.
- Use secure service-to-service authentication.
- Avoid trusting client-provided roles, permissions, workspace IDs, or ownership claims.
- Record important security-sensitive operations.

Never weaken security to make a feature work more easily.

---

# 13. API DEVELOPMENT STANDARDS

Follow the existing API conventions.

Where new conventions are needed:

- Keep controllers focused on HTTP concerns.
- Put business logic in services.
- Keep database operations in the established data-access layer.
- Use reusable validation schemas.
- Use consistent error responses.
- Use consistent pagination.
- Use appropriate HTTP status codes.
- Validate query parameters.
- Validate request bodies.
- Validate route parameters.
- Avoid exposing internal database structures unnecessarily.
- Document new endpoints.
- Maintain backward compatibility where practical.

Do not introduce a second API architecture alongside the existing one without a clear reason.

---

# 14. CODE QUALITY AND TYPESCRIPT STANDARDS

- Use TypeScript strictly.
- Avoid `any` unless absolutely necessary and justified.
- Prefer explicit types and interfaces.
- Use the existing project naming conventions.
- Keep functions focused.
- Avoid excessively large services and controllers.
- Avoid duplicated business logic.
- Use dependency injection or the existing service pattern where appropriate.
- Handle asynchronous errors correctly.
- Avoid unhandled promise rejections.
- Avoid circular dependencies.
- Avoid unused imports and variables.
- Avoid unnecessary abstractions.
- Do not suppress TypeScript errors merely to make the build pass.

Code must be maintainable, testable, and consistent with the existing repository.

---

# 15. TESTING REQUIREMENTS

Every phase must include relevant tests.

### Unit Tests
Test:
- Business logic.
- Validation.
- Utility functions.
- Permission checks.
- Data transformations.
- Error handling.

### Integration Tests
Test:
- Authentication flows.
- Database operations.
- API endpoints.
- Workspace isolation.
- Role permissions.
- Messaging.
- Notifications.
- File access.
- Billing.
- External service integrations.

### Security Tests

Pay particular attention to:

- Cross-workspace access.
- Privilege escalation.
- Unauthorised resource access.
- Authentication bypass.
- Token misuse.
- File access vulnerabilities.
- Webhook verification.
- Duplicate payment or event processing.

### Before Completing a Task

Run the relevant commands from the existing package scripts, such as:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

These commands are examples. Inspect the actual `package.json` and use the scripts that exist in the repository.

Never claim a test passed unless it was actually executed.

If a check cannot run, explain why.

---

# 16. DATABASE MIGRATION RULES

- Use the existing migration framework.
- Never replace the migration framework without approval.
- Give migrations descriptive names.
- Ensure migrations are repeatable according to the framework's conventions.
- Use safe schema changes.
- Preserve existing data.
- Avoid destructive changes.
- Include indexes and constraints where appropriate.
- Consider rollback implications.
- Test migrations against the appropriate development or test database.
- Never run destructive production migrations without explicit approval.
- Never expose database credentials in terminal output or logs.

When a migration is added, update the phase completion report.

---

# 17. BACKGROUND JOB AND RETRY RULES

- Use the existing queue or job-processing infrastructure.
- Jobs must be idempotent where possible.
- Retry attempts must be bounded.
- Use exponential backoff where appropriate.
- Avoid infinite retry loops.
- Avoid duplicate email and notification delivery.
- Record job failures.
- Make failed jobs observable.
- Provide safe recovery mechanisms.
- Do not use Redis as the only permanent record of critical business events.

A job must not continue retrying indefinitely when a permanent failure occurs.

---

# 18. ENVIRONMENT AND CONFIGURATION MANAGEMENT

- Validate required environment variables at startup.
- Keep secrets out of source control.
- Do not overwrite existing environment configuration.
- Maintain the existing environment variable naming conventions.
- Update `.env.example` when new configuration is introduced.
- Document new configuration requirements in README.
- Use different configurations for development, testing, and production.
- Never hardcode production credentials.
- Never commit API keys, passwords, private keys, tokens, or database connection strings.

If a new external service is required, report any account setup or credentials that the user must provide.

---

# 19. EXTERNAL SERVICE INTEGRATIONS

When integrating an external provider:

1. Inspect the provider's official documentation.
2. Understand authentication and permission requirements.
3. Implement secure credential storage.
4. Implement timeout and error handling.
5. Validate webhook signatures.
6. Implement idempotency where appropriate.
7. Avoid logging secrets or sensitive payloads.
8. Document environment variables.
9. Write integration tests using mocks or safe test environments.
10. Preserve the ability to operate core features when optional providers are unavailable.

Do not pretend an integration is complete if it only contains placeholder endpoints.

---

# 20. DOCUMENTATION REQUIREMENTS

Update relevant documentation whenever implementation changes affect:

- API endpoints.
- Environment variables.
- Database models.
- Migrations.
- Authentication.
- Permissions.
- Background jobs.
- WebSocket events.
- External integrations.
- Deployment.
- Developer workflows.

Keep `README.md` accurate.

Keep `phases.md` updated.

Do not add documentation describing functionality that has not been implemented.

---

# 21. HANDLING ERRORS AND DEBUGGING

When fixing an issue:

1. Reproduce or understand the error.
2. Inspect the relevant source code.
3. Identify the root cause.
4. Inspect related modules and dependencies.
5. Implement the smallest reliable fix.
6. Add or update tests.
7. Run relevant checks.
8. Review the diff.
9. Commit the fix to the appropriate feature branch.

Do not hide errors by:

- Returning fake successful responses.
- Disabling validation.
- Removing permission checks.
- Suppressing exceptions.
- Ignoring failed database operations.
- Disabling tests.
- Removing functionality.

If the root cause is unclear, investigate further before making speculative changes.

---

# 22. COMPLETION REPORT

At the end of every task or phase, provide a clear report containing:

1. Task or phase completed.
2. Summary of implementation.
3. Files and modules created or modified.
4. Database migrations added or changed.
5. Environment variables added or changed.
6. API endpoints added or modified.
7. Tests executed.
8. Test results.
9. Type checking, linting, and build results.
10. Known limitations or outstanding issues.
11. Git branch name.
12. Commit hash.
13. GitHub push status.
14. Pull request URL, if created.
15. Next recommended phase.

Never report a successful commit, push, test, or deployment unless it has actually succeeded.

---

# 23. ABSOLUTE PROHIBITIONS

The agent must never:

- Commit development work directly to `main`.
- Push development work directly to `main`.
- Merge into `main` without explicit approval.
- Force-push shared branches.
- Delete or overwrite `.env`.
- Commit secrets.
- Delete existing working features unnecessarily.
- Replace the existing ORM without approval.
- Replace the existing backend framework.
- Convert TypeScript to JavaScript.
- Move the main application backend to Python.
- Bypass authentication or permissions.
- Expose private workspace data.
- Implement AI mutations without explicit user approval.
- Use unbounded retry loops.
- Mark incomplete phases as completed.
- Start future phases without authorisation.
- Claim unexecuted tests passed.
- Claim an unsuccessful Git push succeeded.
- Silently discard user changes.
- Make destructive production database changes without explicit approval.

---

# 24. FINAL DEVELOPMENT PRINCIPLE

The agent must prioritise correctness, security, maintainability, and preservation of existing work over implementation speed.

Every implementation must fit the established Nexus architecture.

Every phase must be independently reviewed and tested.

Every completed phase must be committed and pushed to its own GitHub feature branch.

**The `main` branch is not a development branch for the coding agent. Never commit or push directly to it.**

create a API file.

After every phase, write an file update the API file correctly base on the current state of the backend

When uncertain, inspect the repository, consult the documentation, and ask for clarification rather than making assumptions that could damage existing work.




<!--



# NEXUS BACKEND — FULL PROJECT AUDIT, PHASE VALIDATION, REMEDIATION AND CONTINUED DEVELOPMENT

You are working on the **Nexus backend project**.

Your responsibility is to thoroughly study the existing backend, understand its actual architecture and structure, validate the implementation of every phase in `phases.md`, correct incomplete or incorrect implementations, and continue development from the current phase.

This is not a request to rebuild the backend. You must work with the existing project, preserve working functionality, and improve the implementation without introducing unnecessary architectural changes.

The goal is to ensure that every previously completed phase is genuinely implemented, correctly integrated, secure, tested, and consistent with the project documentation before proceeding.

---




# 1. MANDATORY DOCUMENTATION REVIEW

Before executing commands that modify the project, locate and read the following files completely:

1. `agent.md`
2. `README.md`
3. `phases.md`
4. `branding.md`, if present and relevant to backend responsibilities.
5. Any architecture, database, security, API, deployment, or feature-specific documentation referenced by the files above.

Also inspect relevant documentation in the repository, including existing skill files.

Do not assume all documentation is in the same directory. Locate the correct backend versions.

Understand the purpose of each file:

- `agent.md`: Mandatory instructions and restrictions for AI coding agents.
- `README.md`: Backend architecture, technology stack, modules, conventions, and development workflow.
- `phases.md`: The authoritative implementation roadmap, completed phases, current phase, and pending phases.
- Architecture and skill documents: Detailed technical requirements and implementation conventions.

If a required file is missing, report it. Do not invent its contents.

**Important:** When documentation conflicts with actual implementation, investigate the discrepancy. Do not blindly replace existing code to match an outdated example. Establish the intended behaviour using the project documentation and current architecture, then make the smallest safe correction.

# 2. GIT SAFETY AND BRANCH MANAGEMENT

Before inspecting or changing implementation:

1. Inspect the current Git branch.
2. Run `git status`.
3. Inspect recent commits.
4. Identify uncommitted changes and existing user work.
5. Read the Git instructions in `agent.md`.

Mandatory rules:

- Never commit or push development changes directly to `main`.
- Use a dedicated feature branch for this audit and remediation.
- If already on an appropriate feature branch, continue using it.
- If on `main`, create a descriptive feature branch before making changes.
- Never discard, overwrite, or revert existing user changes.
- Do not use `git reset --hard`, `git clean`, force-push, history rewriting, or destructive branch operations.
- Do not merge into `main` without explicit approval.
- Do not commit secrets, credentials, private keys, `.env` files, or other sensitive configuration.

Commit and push completed work incrementally on the feature branch, following the repository's existing Git conventions. Do not push if credentials, connectivity, or repository permissions prevent it; report the issue honestly.

# 3. STUDY THE EXISTING BACKEND BEFORE MAKING CHANGES

Perform a comprehensive inspection of the current backend.

Do not rely exclusively on README examples or the suggested project structure.

Study the actual repository, including:

### Application architecture
- Entry points and application bootstrap.
- Express application setup.
- Route registration.
- Controllers and services.
- Middleware.
- Module boundaries.
- Dependency injection, if used.
- Shared utilities.
- Error handling.
- Validation.
- API response conventions.

### Technology stack
Verify the actual:
- Node.js version requirements.
- TypeScript configuration.
- Express version.
- PostgreSQL integration.
- ORM and migration tooling.
- Redis integration.
- Background job and queue implementation.
- WebSocket or real-time infrastructure.
- Email provider integration.
- Object storage integration.
- Logging and monitoring tools.
- Testing frameworks.
- Installed dependencies and scripts.

Nexus's main backend is TypeScript-based. Do not convert it to JavaScript.

Do not assume Prisma, Sequelize, or another ORM. Discover and follow the ORM and migration tooling already used in the repository.

### Database architecture
Inspect:
- Database configuration.
- Models and entities.
- Migrations.
- Relationships and foreign keys.
- Indexes and constraints.
- Transaction handling.
- Data consistency.
- Soft deletion and archival rules.
- Tenant/workspace isolation.
- Migration history.

### Security
Inspect:
- Authentication.
- Authorisation.
- Session and token handling.
- Role and permission enforcement.
- Input validation.
- Rate limiting.
- CORS.
- Security headers.
- File access control.
- Workspace isolation.
- IDOR and privilege-escalation risks.
- Sensitive data exposure.
- Audit logging.

### Existing functionality
Inspect all implemented modules and their relationships. Do not evaluate a module in isolation if it depends on shared services, events, database models, or other modules.

# 4. PHASE-BY-PHASE IMPLEMENTATION AUDIT

This is one of the most important parts of the task.

Read `phases.md` and identify:

- All completed phases.
- The current active phase.
- Pending phases.
- Phase dependencies.
- Acceptance criteria.
- Any recorded blockers.

You must audit **every phase**, starting from the earliest phase through the current phase.

Do not assume a phase is correctly implemented just because it is marked completed.

For each phase:

1. Read its requirements and acceptance criteria.
2. Identify the relevant backend modules, services, routes, database structures, and integrations.
3. Inspect the actual implementation.
4. Trace important operations through their complete execution paths.
5. Verify database persistence and relationships.
6. Verify authentication and authorisation.
7. Check error handling and edge cases.
8. Check integration with other modules.
9. Inspect existing tests and execute relevant tests.
10. Identify missing, incomplete, incorrect, insecure, or disconnected functionality.

A feature is not complete merely because a route, controller, model, or service exists.

Verify that the entire functionality works across the relevant layers.

## Phase classification

Assign each audited phase one of these statuses:

- **VERIFIED COMPLETE:** All requirements and acceptance criteria are implemented correctly and sufficiently tested.
- **PARTIALLY COMPLETE:** Some requirements work, but others are missing or incomplete.
- **INCORRECT IMPLEMENTATION:** Functionality exists but does not meet the documented requirements or contains defects.
- **NOT IMPLEMENTED:** Required functionality is absent.
- **BLOCKED:** Verification or implementation cannot proceed because of an external dependency, unavailable credentials, infrastructure, or another genuine blocker.

Do not mark a phase complete based on assumptions.

## Important decision rule

For each phase:

**If it is already correctly implemented:**
- Do not rewrite it.
- Do not refactor it unnecessarily.
- Do not recreate existing database structures.
- Do not duplicate working functionality.
- Record it as VERIFIED COMPLETE.
- Proceed to the next phase.

**If it is incomplete or incorrectly implemented:**
- Identify the exact problems.
- Correct the existing implementation.
- Preserve working functionality.
- Add or update the necessary tests.
- Verify the corrections.
- Only then classify the phase as VERIFIED COMPLETE.

**If it is blocked:**
- Do not pretend it is complete.
- Document the blocker and what is required to resolve it.
- Continue with independent work only when doing so will not violate phase dependencies or compromise correctness.

# 5. CREATE A CLEAR AUDIT AND REMEDIATION PLAN

Before making broad implementation changes, prepare an internal phase audit plan.

For every phase, record:

- Phase number and name.
- Current status in `phases.md`.
- Actual implementation status.
- Evidence inspected.
- Missing or incorrect requirements.
- Required corrections.
- Relevant tests.
- Dependencies and blockers.

Use this plan to determine the safest implementation order.

Do not spend time rewriting the roadmap. Keep the existing phase definitions and numbering unless a genuine documentation error requires correction.

If the phase tracker does not clearly identify the current active phase, investigate the existing progress records and repository state. Do not arbitrarily select a future phase.

# 6. REMEDIATE THE EXISTING BACKEND

After the audit, correct incomplete and incorrect implementations in dependency order.

Follow these rules:

1. Fix foundational problems before dependent features.
2. Preserve the existing architecture.
3. Reuse existing services and shared infrastructure.
4. Avoid creating duplicate services, models, routes, or utilities.
5. Avoid introducing unnecessary dependencies.
6. Preserve API contracts unless a documented defect requires a change.
7. Maintain backward compatibility where reasonably possible.
8. Use database migrations for schema changes.
9. Never modify the database schema manually in a way that bypasses the project's migration process.
10. Do not perform destructive data migrations without a safe migration strategy.
11. Maintain transaction consistency.
12. Enforce permissions in backend services and resource queries, not only route middleware.
13. Add regression tests for corrected behaviour.

Do not refactor unrelated code simply because you prefer a different coding style.

# 7. CRITICAL NEXUS ARCHITECTURE AND PRODUCT RULES

The following requirements must be checked wherever they apply.

## A. Multi-workspace architecture

Nexus supports:

- Individual workspaces.
- Company workspaces.
- Institution workspaces.

Users may belong to multiple workspaces.

Personal workspace data must remain independent of organisation membership.

Workspace and organisation data must be isolated. A user must never gain access to another workspace's private data by manipulating resource IDs or request parameters.

## B. Identity and membership

- One Nexus identity per user.
- Organisation membership is separate from team membership.
- Removing an organisation member must not delete their Nexus identity or personal workspace.
- Pending join applicants must not access private workspace resources.
- Membership removal must revoke access appropriately.
- Invitation and join-request expiry must be enforced server-side.
- Email-domain matching alone must not grant organisation membership.

## C. Roles and permissions

Validate role hierarchies and permission enforcement.

In particular:

- Owners retain ultimate workspace control.
- Admins cannot remove or demote Owners.
- Only Owners can remove or demote another administrator.
- Admins may remove ordinary members and guests.
- Team Leads cannot remove organisation members unless explicitly authorised.
- Organisation Admins do not automatically gain access to private projects.
- All permissions must be checked server-side.

Look for privilege escalation, IDOR, and cross-workspace access vulnerabilities.

## D. Projects and tasks

Validate project visibility:

1. Organisation-wide.
2. Department/team-only.
3. Private/invitation-only.

Associated tasks, files, discussions, meetings, and activity must respect project visibility.

Changing visibility must not accidentally expose private resources.

## E. Messaging and notifications

Keep message unread state separate from general notification unread state.

Direct messages, group messages, channel messages, and message @mentions belong in the Messages experience.

General notifications must not incorrectly count message unread events.

Validate real-time delivery, persistence, event handling, deduplication, and retry behaviour.

## F. Redis and background processing

Redis must not become the permanent source of truth for messages, notifications, or other durable application records.

Verify:
- Connection handling.
- Cache invalidation.
- Rate limiting.
- Queue behaviour.
- Retry limits.
- Job failure handling.
- Idempotency.
- Distributed coordination.
- Graceful shutdown.

Prevent infinite retries and uncontrolled job execution.

## G. Email delivery

Inspect the existing email implementation.

Verify:
- Delivery status tracking.
- Bounded retries.
- Failure handling.
- Appropriate logging.
- No unnecessary exposure of recipient addresses or sensitive email data.
- Correct email templates and event integration.
- Correct handling of task assignments, mentions, meeting invitations, team invitations, and other supported events.

## H. File management and storage

Validate private object storage access, upload restrictions, metadata persistence, authorisation, signed URLs, and download permissions.

Do not expose private files through unauthorised public URLs.

## I. Python AI service

The Python/FastAPI AI service is separate from the main TypeScript backend.

The Express backend remains responsible for authentication, permissions, authorised context preparation, validation, and execution of approved actions.

Do not allow the Python service to bypass the Express permission system or independently mutate the main application database unless an explicitly documented architecture requires it.

## J. AI action execution

AI-proposed mutations must require explicit user approval.

The backend must revalidate permissions and request context before executing an approved action.

## K. Integrations and external services

Validate OAuth security, token storage, refresh, revocation, webhook verification, and workspace-level connection isolation.

Personal integrations must not automatically become workspace integrations.

# 8. CONTINUE FROM THE CURRENT PHASE

After auditing all phases and correcting earlier incomplete implementations:

Identify the current active phase in `phases.md`.

Then apply this decision process:

### Scenario 1: Current phase is already correctly implemented

If every requirement and acceptance criterion is implemented, integrated, and sufficiently tested:

- Do not modify working code unnecessarily.
- Record the verification evidence.
- Update the phase tracker only if its status or documentation is inaccurate.
- Return a clear report that the current phase is already complete.
- Do not start the next phase automatically.

### Scenario 2: Current phase is incomplete or incorrectly implemented

If any requirement is missing, defective, insecure, or insufficiently integrated:

- Correct the existing implementation.
- Add the necessary tests.
- Run the relevant checks.
- Verify the complete phase against its acceptance criteria.
- Update the tracker only after successful verification.

### Scenario 3: Current phase is blocked

If implementation cannot proceed because of a genuine blocker:

- Explain the exact blocker.
- Identify the required external action or dependency.
- Avoid marking the phase complete.
- Do not skip dependent work just to advance the tracker.

**Do not automatically advance to the next phase after completing the current phase.** Stop and report completion. Wait for the next instruction.

# 9. TESTING AND VERIFICATION

After each meaningful remediation, run the most relevant checks.

At minimum, use the actual project scripts to perform applicable:

- TypeScript type checking.
- Linting.
- Unit tests.
- Integration tests.
- Database migration checks.
- API tests.
- Permission and security tests.
- Build verification.

Also test relevant edge cases, including:

- Unauthenticated access.
- Unauthorised access.
- Cross-workspace resource access.
- Invalid IDs.
- Missing and malformed input.
- Duplicate requests.
- Concurrent operations.
- Expired invitations.
- Removed membership.
- Database failures.
- Redis failures.
- Queue failures.
- External service failures.

Do not claim a check passed if it was not executed.

Do not use production data or perform destructive production operations during verification.

If a test requires unavailable credentials or infrastructure, report it as blocked rather than silently skipping it.

# 10. UPDATE PROJECT DOCUMENTATION

Keep `phases.md` accurate.

For each phase:

- Mark it complete only when all acceptance criteria are verified.
- Keep incomplete phases incomplete.
- Record blockers accurately.
- Preserve existing phase numbering.
- Record important implementation notes where useful.

Update the README only if the actual backend architecture or development instructions have materially changed.

Do not rewrite documentation unnecessarily.

Do not modify `agent.md` or other instruction files unless an actual contradiction must be corrected and the change is necessary. Report such contradictions before making unrelated documentation changes.

# 11. INCREMENTAL COMMITS AND PUSHES

Follow the mandatory feature-branch workflow.

Commit logically separated, verified remediation work incrementally.

Examples of commit grouping:

- Audit and foundational corrections.
- Security and permission fixes.
- Database and migration corrections.
- Module-specific fixes.
- Current phase implementation.
- Tests and documentation updates.

Use descriptive commit messages.

Push the feature branch after successful commits when remote access is available.

Never push directly to `main`.

Never merge automatically.

Do not commit broken or unverified changes simply to create a commit.

# 12. FINAL REPORT

When the work is complete, provide a detailed report with the following sections:

## A. Repository Assessment
- Backend project structure discovered.
- Actual technology stack.
- Existing architecture.
- Important implementation conventions.

## B. Phase Audit Results

Provide a table:

| Phase | Original Status | Verified Status | Action Taken |
|---|---|---|---|

Include every phase audited, not only phases that required changes.

## C. Remediation Summary
List:
- Defects discovered.
- Incomplete functionality corrected.
- Security issues addressed.
- Database or migration changes.
- Tests added or updated.
- Integration issues corrected.

## D. Current Phase
State:
- Current phase number and name.
- Whether it was already complete or required remediation.
- Requirements verified.
- Remaining work, if any.

## E. Testing Results
Report actual results for:
- Type checking.
- Linting.
- Unit tests.
- Integration tests.
- Migration checks.
- Build.
- Other relevant verification.

Clearly identify failures and blocked checks.

## F. Git Summary
Report:
- Branch used.
- Commits created.
- Whether the branch was pushed.
- Any Git-related blockers.

## G. Remaining Issues
List unresolved defects, external dependencies, missing credentials, and blockers.

## H. Files Changed
List the important files created, modified, or deleted, with a brief explanation.

---

# NEXUS BACKEND — CONTINUED DEVELOPMENT, PHASE IMPLEMENTATION AND VERIFICATION

You are continuing development of the existing **Nexus backend project**.

Your responsibility is to continue implementation from the next incomplete phase in the existing backend `phases.md` roadmap.

You must first study the project documentation, inspect the actual backend architecture, verify previously completed phases, identify the next incomplete phase, and implement it according to its requirements.

This is an existing production-oriented project. You are not building a new backend from scratch.

Your priority is to maintain architectural consistency, preserve existing functionality, enforce security, and ensure that every phase is correctly implemented, integrated, and tested.

---

# 1. MANDATORY DOCUMENTATION REVIEW

Before making any code changes, locate and read the latest versions of:

1. `agent.md`
2. `README.md`
3. `phases.md`
4. `skill.md`
5. `branding.md`, if present and relevant to backend responsibilities.

Also locate and read all relevant supporting documentation, including:

- Backend architecture documentation.
- Database architecture documentation.
- Authentication and authorisation documentation.
- API documentation.
- Security documentation.
- Redis and background job documentation.
- Real-time communication documentation.
- Email integration documentation.
- File storage documentation.
- AI integration documentation.
- Subscription and billing documentation.
- Testing documentation.
- Deployment documentation.
- Feature-specific technical specifications.

Do not assume all documentation is in the backend root directory.

Search the repository and locate the correct backend documentation.

### Documentation responsibilities

- `agent.md`: Mandatory AI agent instructions and restrictions.
- `README.md`: Actual backend architecture, stack, conventions, and development instructions.
- `phases.md`: Authoritative development roadmap and progress tracker.
- `skill.md`: Backend coding standards and implementation practices.
- Architecture documents: Detailed technical requirements and system boundaries.

Read the original documents, not just summaries or previous reports.

If a required document is missing, report it. Do not invent its contents.

If documentation conflicts with the actual implementation, investigate before making changes.

---

# 2. INSPECT THE EXISTING BACKEND PROJECT

Before implementation, thoroughly inspect the current backend.

Do not assume the backend has the structure shown in an illustrative README.

Understand the actual repository and existing implementation.

### A. Application foundation

Inspect:

- Application entry points.
- Express application setup.
- Server bootstrap.
- Route registration.
- Middleware.
- Controllers.
- Services.
- Modules.
- Shared utilities.
- Configuration.
- Dependency injection, if used.
- Error handling.
- Request validation.
- Response formatting.

### B. Technology stack

Verify the actual:

- Node.js version.
- TypeScript version and configuration.
- Express version.
- PostgreSQL integration.
- ORM.
- Migration tooling.
- Redis integration.
- Background job system.
- WebSocket or real-time implementation.
- Email provider.
- Object storage provider.
- Logging and monitoring tools.
- Testing framework.
- Installed dependencies.
- Package scripts.

**Nexus's main backend uses TypeScript. Do not convert it to JavaScript.**

Do not assume Prisma, Sequelize, or any other ORM. Inspect the existing dependencies, configuration, migrations, and implementation.

### C. Database architecture

Inspect:

- Database configuration.
- Models and entities.
- Migrations.
- Relationships.
- Foreign keys.
- Indexes.
- Constraints.
- Transactions.
- Soft deletion.
- Archival behaviour.
- Workspace isolation.
- Data consistency.
- Migration history.

### D. Authentication and security

Inspect:

- Authentication.
- Session and token handling.
- Password security.
- Authorisation.
- Role management.
- Permission enforcement.
- Input validation.
- Rate limiting.
- CORS.
- Security headers.
- File access.
- Audit logging.
- Sensitive data handling.
- IDOR vulnerabilities.
- Privilege escalation.
- Cross-workspace data access.

### E. Existing modules

Inspect all existing modules and how they communicate.

Do not evaluate individual modules without considering their relationships with shared services, events, database models, queues, and other modules.

---

# 3. VERIFY PREVIOUSLY COMPLETED PHASES

Read the entire backend `phases.md`.

Identify:

- Completed phases.
- Current active phase.
- Next incomplete phase.
- Remaining phases.
- Dependencies.
- Acceptance criteria.
- Recorded blockers.

Do not assume a phase is correctly implemented because it is marked complete.

Verify the actual implementation against the requirements.

For each previously completed phase:

1. Read its requirements.
2. Locate its implementation.
3. Inspect routes, controllers, services, models, and migrations.
4. Trace important workflows end to end.
5. Verify database persistence.
6. Verify relationships and constraints.
7. Verify authentication and authorisation.
8. Verify integration with dependent modules.
9. Inspect relevant tests.
10. Run applicable tests.
11. Identify defects and incomplete requirements.

### Phase verification statuses

Use these classifications:

| Status | Meaning |
|---|---|
| VERIFIED COMPLETE | Requirements are implemented correctly and sufficiently tested. |
| PARTIALLY COMPLETE | Some requirements are implemented, but others remain incomplete. |
| INCORRECT IMPLEMENTATION | Functionality exists but contains defects or violates requirements. |
| NOT IMPLEMENTED | Required functionality is absent. |
| BLOCKED | Verification or implementation cannot proceed because of a genuine dependency or external blocker. |

A route existing does not prove a feature works.

A database model existing does not prove the business workflow is implemented.

A passing isolated unit test does not prove the complete feature works.

Verify the complete execution path.

### Decision rules

**If a phase is already correctly implemented:**

- Do not rewrite it.
- Do not unnecessarily refactor it.
- Do not recreate existing database structures.
- Do not duplicate services or routes.
- Record it as VERIFIED COMPLETE.
- Continue to the next phase.

**If a phase is incomplete or incorrect:**

- Identify the exact defects.
- Correct the existing implementation.
- Preserve working functionality.
- Add or update tests.
- Verify the corrections.
- Update its status only when supported by evidence.

**If a phase is blocked:**

- Document the blocker.
- Identify the required external dependency.
- Do not falsely mark it complete.

---

# 4. DETERMINE THE NEXT INCOMPLETE PHASE

After reviewing the documentation and actual implementation, determine the next phase that requires development.

Follow the existing phase order.

Before starting:

- Verify that previous phases are complete.
- Verify that dependencies are satisfied.
- Identify defects that could affect the selected phase.
- Resolve necessary foundational defects first.

Do not skip phases.

Do not arbitrarily change phase numbering.

Do not implement future-phase functionality prematurely.

If the phase tracker is inaccurate, investigate the actual project before correcting it.

Prepare a focused implementation plan for the selected phase.

---

# 5. IMPLEMENT THE NEXT BACKEND PHASE

For the selected phase, follow this process.

## Step 1: Study its requirements

Read the complete phase description and acceptance criteria.

Understand:

- Business requirements.
- API requirements.
- Database requirements.
- Authentication and authorisation requirements.
- External service dependencies.
- Integration requirements.
- Expected behaviour.
- Error scenarios.
- Testing requirements.

Read all supporting technical documents referenced by the phase.

## Step 2: Inspect existing implementation

Before creating anything, search for:

- Existing models.
- Existing migrations.
- Existing routes.
- Existing controllers.
- Existing services.
- Existing middleware.
- Existing validators.
- Existing shared utilities.
- Existing event handlers.
- Existing background jobs.
- Existing tests.

Reuse suitable implementations.

Do not introduce duplicate functionality.

## Step 3: Prepare the implementation plan

Identify:

- Files requiring modification.
- New files genuinely needed.
- Existing modules to reuse.
- Database changes.
- API changes.
- External integrations.
- Security considerations.
- Tests to create or update.

Ensure the implementation fits the existing architecture.

## Step 4: Implement

Implement the entire phase according to its requirements.

Do not implement only the API routes while leaving the business logic incomplete.

Do not implement only database models without completing the required workflows.

Ensure:

- Business logic is implemented in the appropriate services.
- Input validation is enforced.
- Authentication is applied correctly.
- Authorisation is enforced server-side.
- Database operations are consistent.
- Transactions are used where necessary.
- Errors are handled properly.
- API responses follow existing conventions.
- Integrations use existing shared infrastructure.
- Relevant tests are added.

## Step 5: Integrate with existing modules

Verify that the new implementation works with related modules.

For example:

- Authentication and users.
- Workspaces and membership.
- Roles and permissions.
- Teams and departments.
- Projects and tasks.
- Messaging and notifications.
- Files and documents.
- Calendar and meetings.
- Subscriptions.
- Search.
- Integrations.
- Automation.
- AI services.

Only implement integrations relevant to the selected phase.

## Step 6: Test

Run all relevant tests and checks.

Verify the complete feature workflow, including failure scenarios and permissions.

## Step 7: Update documentation

Update `phases.md` after the implementation has been verified.

Document important implementation changes where necessary.

## Step 8: Continue sequentially

After a phase is verified complete, identify the next incomplete phase and continue.

Do not skip phases.

Do not repeatedly rebuild already verified functionality.

---

# 6. CRITICAL NEXUS BACKEND ARCHITECTURE RULES

These rules must be respected throughout development.

## A. TypeScript backend

The main backend uses:

- Node.js.
- Express.js.
- TypeScript.
- PostgreSQL.
- Redis.
- REST APIs.
- Existing real-time infrastructure.
- Background jobs.
- Private object storage.

Use the actual versions and libraries already installed.

Do not convert the backend to JavaScript.

Do not replace the ORM or migration system without explicit approval.

## B. Multi-workspace architecture

Nexus supports:

1. Individual workspaces.
2. Company workspaces.
3. Institution workspaces.

Users may belong to multiple workspaces.

Personal workspace data must remain independent of organisation membership.

All workspace-scoped queries and operations must enforce correct isolation.

Never allow a user to access another workspace's private resources by manipulating IDs or request parameters.

## C. Identity and membership

Maintain one Nexus identity per user.

Remember:

- Organisation membership is separate from team membership.
- Removing organisation membership must not delete the user's Nexus identity.
- Personal workspace data must remain intact.
- Pending join applicants must not access private workspace content.
- Invitation expiry must be enforced server-side.
- Join-request expiry must be enforced server-side.
- Email-domain matching alone must not grant membership.
- Membership removal must revoke access appropriately.

## D. Roles and permissions

Validate role hierarchies and permission enforcement.

Important rules:

- Owners retain ultimate control.
- Admins cannot remove or demote Owners.
- Only Owners can remove or demote another administrator.
- Admins may remove ordinary members and guests.
- Team Leads cannot remove organisation members unless explicitly authorised.
- Organisation Admins do not automatically gain access to private projects.
- Permissions must be enforced in services and resource queries, not only routes.

Protect against:

- Privilege escalation.
- IDOR.
- Cross-workspace leakage.
- Unauthorised administrative actions.

## E. Projects and tasks

Project visibility levels:

1. Organisation-wide.
2. Department/team-only.
3. Private/invitation-only.

Associated tasks, files, discussions, meetings, and activity must respect project visibility.

Changing project visibility must not expose private resources.

## F. Messaging and notifications

Maintain a strict distinction between message unread state and general notification unread state.

Direct messages, group messages, channel messages, and message @mentions belong in the Messages experience.

General notification unread counts must remain independent.

Verify:

- Persistent message storage.
- Real-time delivery.
- Event processing.
- Deduplication.
- Delivery retries.
- Notification persistence.
- Read-state updates.

## G. Redis and background jobs

PostgreSQL remains the durable source of truth.

Redis supports:

- Caching.
- Rate limiting.
- Real-time coordination.
- Ephemeral state.
- Queue infrastructure.
- Distributed coordination.

Do not use Redis as the permanent storage layer for messages, notifications, or other durable application records.

Verify:

- Connection handling.
- Cache invalidation.
- Queue processing.
- Retry limits.
- Job failure handling.
- Idempotency.
- Graceful shutdown.

Prevent infinite retries and uncontrolled job execution.

## H. Email delivery

Use the existing email provider and architecture.

Verify:

- Delivery tracking.
- Bounded retries.
- Failure handling.
- Appropriate logging.
- Email template consistency.
- Event integration.
- Protection of sensitive email data.

Do not expose credentials.

## I. File management

Use private object storage.

Verify:

- Upload validation.
- File size restrictions.
- MIME type restrictions.
- Metadata persistence.
- Access permissions.
- Signed URL generation.
- Download authorisation.
- Safe file handling.

Never expose private storage credentials or make private files publicly accessible without explicit requirements.

## J. Python AI service

The Python/FastAPI AI service is separate from the main TypeScript backend.

The Express backend remains responsible for:

- Authentication.
- Authorisation.
- Context preparation.
- Business validation.
- AI request orchestration.
- Approval validation.
- Execution of approved mutations.

The Python service must not bypass Express permissions or independently mutate the main application database unless explicitly documented.

Core backend functionality must continue operating when the AI service is unavailable.

## K. AI action approval

AI-proposed mutations require explicit user approval.

Before execution, Express must revalidate:

- User identity.
- Workspace context.
- Resource access.
- Current permissions.
- Proposed operation.
- Approval validity.

Never execute sensitive AI actions merely because an AI service proposed them.

## L. Integrations

Maintain isolation between personal and workspace integrations.

Verify:

- OAuth security.
- Token encryption and storage.
- Refresh handling.
- Revocation.
- Webhook verification.
- Scope restrictions.
- Workspace-level connection management.

Disconnecting an integration must not delete data held by the external provider.

---

# 7. DATABASE AND MIGRATION RULES

Database changes must follow the project's existing ORM and migration conventions.

Before creating a migration:

1. Inspect the current schema.
2. Inspect existing models.
3. Inspect migration history.
4. Check whether the required table, column, index, or relationship already exists.
5. Determine whether the change is genuinely necessary.

Rules:

- Never duplicate existing migrations.
- Never recreate existing database tables unnecessarily.
- Do not edit previously applied migrations casually.
- Create new migrations for required schema changes.
- Maintain foreign key integrity.
- Add appropriate indexes.
- Preserve existing data.
- Use transactions where appropriate.
- Handle rollback safely.
- Avoid destructive migrations without an explicit safe migration strategy.

Do not run destructive operations against production databases.

Do not assume that a migration has been applied merely because its file exists.

---

# 8. API DESIGN AND INTEGRATION

Follow the existing API conventions.

Ensure:

- Consistent routes.
- Appropriate HTTP methods.
- Request validation.
- Typed request and response structures.
- Authentication.
- Authorisation.
- Pagination.
- Filtering.
- Sorting.
- Consistent error responses.
- Appropriate status codes.
- API documentation where configured.

Avoid:

- Duplicated endpoints.
- Unnecessary controllers.
- Business logic inside route definitions.
- Inconsistent response structures.
- Unvalidated request parameters.
- Trusting client-supplied workspace or role information.

Never trust the frontend to enforce security.

---

# 9. TESTING AND QUALITY ASSURANCE

Testing is mandatory for every phase.

Use the actual scripts and frameworks configured in the repository.

Run applicable:

- TypeScript type checking.
- ESLint.
- Unit tests.
- Integration tests.
- API tests.
- Database tests.
- Migration checks.
- Permission tests.
- Security tests.
- Build verification.

Test important edge cases:

- Unauthenticated requests.
- Unauthorised requests.
- Cross-workspace resource access.
- Invalid IDs.
- Malformed inputs.
- Duplicate requests.
- Concurrent operations.
- Expired invitations.
- Removed memberships.
- Database failures.
- Redis failures.
- Queue failures.
- External service failures.
- Missing permissions.
- Invalid AI action approvals.

Do not claim that a test passed unless it was executed successfully.

If infrastructure or credentials are unavailable, report the test as blocked.

Never hide failures to make a phase appear complete.

---

# 10. GIT AND BRANCH MANAGEMENT

Before making changes:

1. Inspect the current branch.
2. Run `git status`.
3. Review recent commits.
4. Identify uncommitted changes.
5. Read the Git instructions in `agent.md`.

Mandatory rules:

- Never commit or push development changes directly to `main`.
- Use a dedicated feature branch.
- Continue on an appropriate existing feature branch or create one.
- Preserve existing user changes.
- Never use destructive Git operations.
- Never force-push.
- Never rewrite Git history.
- Never merge into `main` without explicit approval.
- Never commit secrets or `.env` files.

Commit logically separated, verified work incrementally.

Use descriptive commit messages.

Push the feature branch when authorised and remote access is available.

If Git operations fail, report the exact issue.

---

# 11. PHASE TRACKER MANAGEMENT

Keep `phases.md` accurate.

For every phase, record:

- Phase number.
- Phase name.
- Original status.
- Verified status.
- Requirements implemented.
- Important files modified.
- Tests executed.
- Verification results.
- Remaining work.
- Blockers.

Only mark a phase complete after all acceptance criteria are satisfied.

Never mark a phase complete because:

- A route exists.
- A model exists.
- A migration file exists.
- A controller exists.
- A test file exists.
- The code compiles.

Verify the actual functionality.

Do not change phase numbering or delete requirements to make the roadmap appear complete.

---

# 12. CONTINUE THROUGH THE REMAINING PHASES

After completing the selected phase:

1. Verify its acceptance criteria.
2. Run relevant tests.
3. Update `phases.md`.
4. Commit verified work on the feature branch.
5. Identify the next incomplete phase.
6. Verify its dependencies.
7. Continue sequentially.

Do not skip phases.

Do not start a phase whose prerequisites are incomplete unless the work is genuinely independent and does not compromise the architecture.

If a phase is blocked, document the blocker and continue only with independent work that does not depend on it.

Do not automatically stop after one phase if the remaining work is clear, dependencies are satisfied, and the implementation can safely continue.

However, stop when:

- A genuine blocker requires user intervention.
- An architectural decision requires approval.
- A destructive or security-sensitive change requires approval.
- Continuing would require modifying another project or external system outside the authorised scope.
- The user explicitly instructs you to stop after a particular phase.

---

# 13. FINAL COMPLETION REPORT

At the end of the development session, provide a detailed report.

## A. Documentation Reviewed

List all documentation files inspected.

## B. Backend Architecture Assessment

Report:

- Actual technology stack.
- Existing backend architecture.
- Database and ORM.
- Migration tooling.
- Redis implementation.
- Background job infrastructure.
- Real-time infrastructure.
- Existing integrations.

## C. Phase Audit

Provide a table:

| Phase | Previous Status | Verified Status | Action Taken |
|---|---|---|---|

Include every phase audited.

## D. Implementation Summary

For every phase worked on, report:

- Phase number and name.
- Requirements implemented.
- Services created or modified.
- Routes and controllers changed.
- Database changes.
- Integrations.
- Security improvements.
- Tests added or modified.

## E. Testing Results

| Check | Result | Details |
|---|---|---|
| TypeScript | | |
| ESLint | | |
| Unit tests | | |
| Integration tests | | |
| API tests | | |
| Database/migrations | | |
| Security tests | | |
| Build | | |

Report actual results.

## F. Phase Tracker Status

Report:

- Verified completed phases.
- Newly completed phases.
- Partially completed phases.
- Blocked phases.
- Next incomplete phase.

## G. Git Summary

Report:

- Branch used.
- Commits created.
- Whether the branch was pushed.
- Git blockers.

## H. Remaining Work

List unresolved defects, external dependencies, missing credentials, and outstanding requirements.

## I. Files Changed

List important files created, modified, or deleted, with explanations.

---

# FINAL OPERATING INSTRUCTIONS

1. Read all necessary documentation before implementation.
2. Study the actual backend project structure.
3. Verify every previously completed phase.
4. Correct incomplete or incorrect earlier implementations.
5. Identify the next incomplete phase from `phases.md`.
6. Implement phases in the correct order.
7. Preserve existing working functionality.
8. Follow the actual TypeScript backend architecture.
9. Use the existing ORM and migration tooling.
10. Enforce permissions and workspace isolation server-side.
11. Integrate features with existing modules.
12. Test every meaningful implementation.
13. Update `phases.md` based on verified evidence.
14. Never overwrite `.env` files or expose secrets.
15. Never commit directly to `main`.
16. Never merge without approval.
17. Never invent functionality or claim unverified work is complete.

**EXPECTED OUTCOME**

A properly audited, secure, tested, and progressively completed Nexus backend.

Every phase must be verified against the actual implementation, incomplete functionality must be corrected, and new phases must build on the existing architecture without duplicating or breaking previously implemented features.



 -->
