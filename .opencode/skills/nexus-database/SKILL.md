---
name: nexus-database
description: Specialized database engineering instructions for the Nexus backend. Use when designing or changing PostgreSQL schemas, Prisma models, relations, migrations, queries, transactions, indexes, seeds, database tests, or Redis caching.
---

# Nexus Database Engineering Skill

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

This skill defines how database-related features must be designed, implemented, tested, and maintained in the Nexus backend.

Nexus is a general-purpose Real-Time Workspace & Project Management Platform combining project and task management, team communication, collaborative documents, file management, scheduling, forms, search, automation, billing, integrations, and AI-assisted workflows. It is not developer-only software.

Nexus serves Individual, Company, and Institution workspaces from one shared database architecture. Workspace type changes the applicable organisation hierarchy, roles, and feature access, but must not weaken isolation between workspaces.

The database must support reliable relationships, workspace isolation, role-based and resource-level access, real-time collaboration, data integrity, and future scalability.

Follow this skill whenever implementing or modifying database functionality.

## 2. Technology Stack

Use the existing project configuration as the source of truth.

- Runtime: Node.js
- Backend: Express.js
- Language: TypeScript
- Primary database: PostgreSQL
- ORM: Prisma ORM
- Cache and temporary shared state: Redis
- Real-time communication: the existing WebSocket/real-time implementation. Socket.IO is the planned transport but is not yet installed; inspect the repository before relying on it.
- API architecture: REST APIs with real-time events where appropriate
- AI service: a separate Python/FastAPI service; it does not own the application database

Do not replace PostgreSQL or Prisma with another database or ORM without explicit approval.

Do not introduce another database library merely to perform operations that Prisma already supports.

## 3. Inspect Before Implementing

Before making database changes:

1. Read `AGENTS.md` and `PHASES.md`.
2. Inspect `package.json` and the installed Prisma version.
3. Locate the existing Prisma schema and migration directory.
4. Inspect database configuration, environment variable names, and Prisma Client initialization.
5. Review existing models, enums, relations, indexes, constraints, repositories, services, and tests.
6. Identify which implementation phase the requested task belongs to.
7. Check whether the required model or relationship already exists.

Preserve existing functionality and project conventions.

Do not create duplicate models, database clients, migrations, or competing schema definitions.

Do not reorganize the repository or replace existing files unnecessarily.

## 4. PostgreSQL as the Source of Truth

PostgreSQL is the authoritative store for persistent application data.

Use PostgreSQL for information such as:

- User accounts, profiles, sessions, and security events.
- Individual, Company, and Institution workspaces and workspace memberships.
- Company teams, Institution departments/groups, and their memberships.
- Organisation invitations, join requests, approvals, and ownership transfer records.
- Roles, permissions, project access, resource grants, and audit records.
- Subscriptions, plans, entitlements, seats, usage, and billing state.
- Projects, tasks, assignments, comments, dependencies, milestones, and activity records.
- Documents and document metadata, including version-history foundations.
- Conversations, messages, read states, and persistent notification records.
- Meetings, invitations, calendars, attendance, summaries, and action items.
- Forms, form fields, responses, and survey results.
- Integrations, automation workflows, execution history, and webhook events.
- AI action proposals/approvals, Nexus Write suggestions, and AI job records.

Redis is not a replacement for PostgreSQL.

Do not store the only copy of important business records in Redis.

## 5. Database Modeling Principles

Design the schema around actual business requirements and relationships.

For every model, determine:

- Its purpose and ownership.
- Its primary key.
- Its required and optional fields.
- Its relationships to other models.
- Its unique constraints.
- Its foreign-key constraints.
- Its indexes.
- Its creation and update timestamps.
- Its deletion and retention requirements.
- Its authorization implications.

Use clear, consistent naming conventions.

Prefer singular PascalCase Prisma model names and camelCase field names unless the existing schema establishes another convention.

Use appropriate PostgreSQL types through Prisma, including dates, timestamps, booleans, integers, decimals, strings, and JSON fields where justified.

Use enums for stable, finite sets of states or roles. Do not create enums for values that are expected to be highly dynamic or user-defined.

Do not use JSON fields as a substitute for proper relational modeling when the data needs foreign keys, independent querying, uniqueness, or relational integrity.

Avoid redundant fields that can become inconsistent with their source records.

## 6. Relationships and Referential Integrity

Define Prisma relations explicitly and make the cardinality clear.

Use:

- One-to-one relationships when one record corresponds to at most one other record.
- One-to-many relationships when a parent owns multiple related records.
- Many-to-many relationships when multiple records can associate with multiple other records.

Use explicit join models when a relationship contains additional information, such as a role, membership status, invitation date, assignment metadata, or audit information.

Examples of important Nexus relationships:

- A user can belong to multiple workspaces.
- A workspace can have multiple members.
- A workspace can contain multiple teams, departments, groups, projects, and forms.
- A project can contain multiple tasks, milestones, and conversations.
- A task can have assignments, comments, attachments, dependencies, and activity records.
- Messages belong to conversations and have authors.
- Notifications belong to their intended recipients and remain separate from message unread state.
- Meetings can have multiple participants, calendar links, summaries, and action items.
- Files and documents must have clearly defined ownership and access rules.
- Subscriptions and entitlements belong to the correct workspace or billing owner.
- Automation workflows, integration records, and AI action approvals must retain their owning workspace.

These examples describe intended domain relationships, not permission to duplicate models that already exist.

For every relation, choose suitable `onDelete` and `onUpdate` behavior. Never use cascading deletion indiscriminately.

Add database constraints to protect data integrity even when application-level validation is present.

## 7. Workspace Isolation and Authorization

Nexus is a multi-workspace platform. Workspace boundaries are essential.

For every workspace-owned resource, establish how its workspace is identified and how access is verified.

Requirements:

- Validate that related records belong to the correct workspace.
- Distinguish Individual, Company, and Institution ownership and roles where the schema requires it.
- Prevent users from accessing another workspace's private records without authorization.
- Verify project, task, conversation, document, meeting, file, form, integration, and automation access according to the relevant membership and permission rules.
- Preserve protected Owner rules: only the Owner may remove or demote another administrator, and an administrator cannot remove the Owner.
- Keep project roles separate from organisation roles.
- Do not grant organisation administrators automatic access to private projects, private files, or private meetings.
- Enforce role and resource permissions in the service layer.
- Do not rely on frontend checks to protect database records.
- Avoid accepting workspace ownership or privileged roles directly from untrusted request bodies.
- Use transactions or database constraints when necessary to prevent inconsistent cross-workspace relationships.

A valid foreign key alone does not prove that two records belong to the same workspace. Add appropriate application checks or database constraints where necessary.

## 8. Prisma Schema and Client

Keep Prisma models, enums, relations, and constraints consistent with the actual application requirements.

When adding or changing a model:

1. Inspect related existing models.
2. Define both sides of each Prisma relation where required.
3. Add appropriate constraints and indexes.
4. Consider nullability and default values carefully.
5. Update affected services, validation schemas, and tests.
6. Generate the Prisma Client using the command appropriate to the installed Prisma version and project configuration.
7. Validate the schema and test the affected functionality.

Reuse the existing shared Prisma Client instance.

Do not instantiate a new Prisma Client for every request.

Do not bypass Prisma with raw SQL unless it is justified by a specific requirement. If raw SQL is necessary, use safe parameterization and preserve the project's security conventions.

## 9. Database Migrations

Every intentional database schema change must have a clear migration strategy.

Before creating a migration:

1. Inspect the current schema and migration history.
2. Identify the exact change and affected data.
3. Determine whether existing records need to be backfilled or transformed.
4. Check whether the change can cause data loss or downtime.
5. Review the generated migration before applying it.

Rules:

- Use the migration workflow supported by the installed Prisma version.
- Commit migration files to version control.
- Never modify an already-applied migration simply to make a new change work.
- Never delete migration history to bypass an error.
- Never reset a shared, staging, or production database without explicit authorization.
- Never use destructive database commands as an automatic troubleshooting step.
- Do not use schema-push shortcuts as a replacement for the project's established migration workflow.
- Preserve existing data during schema changes unless deletion is explicitly required and authorized.
- Use staged or expand-and-contract changes when a breaking change requires compatibility across deployments.

If a migration fails, inspect the error and the database state first. Explain the proposed correction before performing any potentially destructive recovery.

## 10. Transactions and Data Consistency

Use Prisma transactions whenever multiple database operations must succeed or fail together.

Examples include:

- Creating a workspace and its initial owner membership.
- Accepting an invitation and creating the corresponding membership.
- Creating a task and its related assignment or activity record when both are required.
- Updating related project records and maintaining consistent derived state.
- Persisting a business operation that requires multiple dependent database writes.

Requirements:

- Keep transactions focused and reasonably short.
- Do not perform slow external API requests inside database transactions.
- Handle failures and rollbacks correctly.
- Consider concurrent updates and race conditions.
- Use unique constraints to protect against duplicate operations.
- Use appropriate transaction isolation when the business operation requires it.
- Avoid calculating important balances, counters, or statuses from stale reads.

Do not assume that a sequence of separate Prisma calls is automatically atomic.

## 11. Indexes and Query Performance

Add indexes based on actual query patterns and relationships.

Consider indexes for:

- Foreign-key fields used in lookups.
- Workspace and project filtering, including workspace type.
- Task status, assignment, and due-date queries.
- Message conversation and chronological retrieval.
- Message unread state and independently tracked general notifications.
- Meeting schedules and participant lookups.
- Calendar event synchronisation keys and external provider identifiers.
- File and document search metadata.
- Form and form-response lookups.
- Subscription, entitlement, and usage queries.
- Automation trigger and execution lookups.
- Unique identifiers and fields used for login or invitations.

Use composite indexes when common queries filter or sort on multiple fields.

Use unique constraints for values that must not be duplicated.

Avoid adding indexes to every field without justification because indexes also increase storage and write costs.

For performance-sensitive queries:

- Select only the fields required by the caller.
- Implement pagination for potentially large collections.
- Avoid N+1 query patterns.
- Limit unnecessary nested relations.
- Use database query plans when performance issues warrant them.
- Verify that indexes support the actual filtering and sorting patterns.

Do not load an entire table into application memory when the database can filter the records.

## 12. Redis and Caching

Use Redis for appropriate temporary or shared state, not as the authoritative persistent database.

Potential uses include:

- Frequently accessed cached data.
- Rate-limiting counters.
- Short-lived verification or coordination state when appropriate.
- Distributed locks only when justified and implemented safely.
- Background-job coordination and queue infrastructure where configured.
- Real-time presence or temporary activity state when appropriate.

Rules:

- Define appropriate expiration times for temporary keys.
- Use consistent key naming conventions.
- Prevent stale cache entries from causing incorrect authorization decisions.
- Invalidate or update caches after relevant database changes.
- Handle Redis unavailability gracefully according to the feature's requirements.
- Never cache sensitive data without a clear security justification.
- Never treat cached permissions as the only authorization check.
- Do not introduce a second caching strategy without a demonstrated need.

PostgreSQL remains the source of truth for durable business data.

## 13. Validation and Error Handling

Validate untrusted input before passing it to database operations.

Use the project's existing request-validation library and patterns.

Validation should cover:

- Required fields and field types.
- Identifier formats.
- Allowed enum values.
- String length and numeric boundaries.
- Duplicate records.
- Valid foreign-key references.
- Relationship ownership and workspace boundaries.
- Pagination limits and sorting options.

Handle known Prisma errors appropriately, including unique-constraint violations, missing records, and foreign-key violations.

Return meaningful API errors without exposing database credentials, SQL details, stack traces, or internal infrastructure information.

Do not hide database failures behind generic success responses.

## 14. Database Security and Environment Variables

Keep database credentials in environment variables.

Never:

- Hardcode database passwords or connection strings.
- Commit `.env` files containing secrets.
- Print database credentials in logs.
- Expose privileged database configuration to the frontend.
- Disable database security to make a connection succeed.
- Use production credentials for local experimentation without explicit authorization.

Preserve the existing environment variable names and connection configuration unless a deliberate, coordinated change is required.

Use separate configuration for development, testing, staging, and production.

Use appropriately restricted database permissions in deployed environments.

## 15. Seeding and Test Data

Keep database seed scripts repeatable and predictable.

Requirements:

- Create only the records required for the intended environment.
- Use deterministic relationships between seeded records.
- Avoid duplicate records when seeds are rerun.
- Never seed production with development users or sample credentials accidentally.
- Never delete real user data as part of routine seeding.
- Use isolated test databases or appropriately isolated test records.
- Clean up only the records created by the test when possible.

Test important relationships, unique constraints, foreign-key behavior, transactions, authorization boundaries, and failure cases.

## 16. Database Testing

For every database-related feature, test the relevant behavior.

Depending on the feature, verify:

- Successful record creation, retrieval, updates, and deletion.
- Correct relationships between records.
- Required fields and validation failures.
- Unique constraints and duplicate handling.
- Foreign-key integrity.
- Workspace isolation.
- Transaction rollback behavior.
- Concurrent requests where race conditions are possible.
- Migration correctness.
- Redis cache invalidation when applicable.

Use the project's existing test framework and conventions.

Do not claim a database feature is complete simply because the Prisma schema validates or the application compiles.

## 17. Database Change Workflow

Follow this workflow for every database task:

1. **Inspect:** Read `AGENTS.md`, `PHASES.md`, relevant skills, schema files, migrations, and affected services.
2. **Branch:** Confirm you are not on `main`; create or use a dedicated feature branch and preserve uncommitted user changes.
3. **Plan:** Identify models, relations, constraints, indexes, migration impact, and affected API behavior.
4. **Implement:** Make the smallest coherent schema and code changes.
5. **Migrate:** Create and review the migration using the installed Prisma workflow.
6. **Generate:** Update Prisma Client when required.
7. **Test:** Run schema validation, relevant automated tests, and the appropriate integration checks.
8. **Verify:** Check that relationships, authorization, workspace isolation, and data consistency remain correct.
9. **Document:** Explain schema changes, migrations, environment requirements, and any follow-up work.
10. **Track and commit:** Update `PHASES.md` only when the corresponding phase's completion criteria have genuinely been met, then commit and push the feature branch. Never merge into `main` without explicit authorisation.

Do not mark a phase complete merely because its schema has been created.

## 18. Definition of Done

A database task is complete only when all applicable requirements are satisfied:

- The schema accurately represents the business requirement.
- Relations and referential integrity are correct.
- Required constraints and indexes are present.
- Workspace isolation and authorization requirements are addressed.
- Migrations are generated and reviewed where needed.
- Prisma Client is updated where needed.
- Relevant services and validation logic are updated.
- Tests pass, or remaining failures are clearly reported.
- No unrelated features or migration history have been damaged.
- No secrets have been exposed.
- Documentation and `PHASES.md` reflect the actual state of the work.
- Changes are committed and pushed to the correct feature branch, not `main`.

## 19. Required Agent Behavior

Always prioritize data integrity, security, maintainability, and consistency with the existing Nexus architecture.

Before making a destructive or irreversible database change, explain the risk and obtain explicit approval.

If the schema or business requirement is unclear, inspect the repository first. If an important ambiguity remains, ask a focused question rather than inventing a relationship.

Do not silently replace existing models, reset databases, delete migrations, or introduce unrequested technologies.

Make changes incrementally and report:

- What changed.
- Which models and relations were affected.
- Which migration was created.
- Which tests and validation commands were run.
- Whether any risks, failures, or incomplete work remain.
