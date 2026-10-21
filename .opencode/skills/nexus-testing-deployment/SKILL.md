---
name: nexus-testing-deployment
description: Specialized instructions for testing, validating, securing, deploying, monitoring, and troubleshooting the Nexus backend, including Express APIs, PostgreSQL, Prisma, Redis, Socket.IO, CI/CD, and production releases.
---

# Nexus Testing and Deployment Skill

## 1. Purpose

This skill defines how testing, quality assurance, deployment, and production verification must be handled in the Nexus backend.

Nexus is a real-time workspace and project management platform that combines project management, messaging, collaborative documentation, meetings, notifications, and AI-assisted workflows.

The objective is to ensure that every feature is reliable, secure, maintainable, and deployable without damaging existing functionality or user data.

Follow this skill whenever implementing tests, fixing defects, preparing a release, changing deployment configuration, or troubleshooting production behavior.

## 2. Technology Stack

Use the existing repository configuration as the source of truth.

- Runtime: Node.js
- Language: TypeScript
- Backend: Express.js
- Database: PostgreSQL
- ORM: Prisma
- Real-time communication: Socket.IO
- Cache and temporary coordination: Redis
- Testing: Use the framework already configured in the project.
- Version control: Git and GitHub.
- Deployment: Use the hosting platform already configured for the repository.

Do not introduce new testing frameworks, deployment platforms, or infrastructure without a clear justification.

Do not replace existing dependencies or deployment workflows merely to simplify a task.

## 3. Inspect Before Testing or Deploying

Before making testing or deployment changes:

1. Read `agent.md` and `PHASES.md`.
2. Inspect `package.json` and the available scripts.
3. Review the TypeScript configuration and build process.
4. Inspect environment variable validation and configuration.
5. Review the Prisma schema and migration history.
6. Identify existing tests and testing conventions.
7. Inspect Git status and the current branch.
8. Review the current deployment configuration and CI/CD workflow.
9. Identify the feature or implementation phase being verified.

Do not assume a test command, deployment platform, environment variable, or workflow exists without checking the repository.

Preserve unrelated local changes and uncommitted work.

Never overwrite a user's changes simply to get tests passing.

## 4. Testing Strategy

Use a layered testing strategy.

### Unit testing

Test individual functions and business rules independently.

Examples include:

- Input validation.
- Permission checks.
- Task progress calculations.
- Meeting lifecycle transitions.
- Notification preferences.
- Message-processing rules.
- Email template rendering.
- AI output validation.
- Utility functions.

Unit tests should be fast, focused, deterministic, and independent of external infrastructure where possible.

### Integration testing

Test interactions between related components.

Examples include:

- Express routes and services.
- Services and Prisma.
- PostgreSQL relationships and constraints.
- Redis-backed functionality.
- Socket.IO event handling.
- Email provider adapters.
- AI provider integrations.
- Background jobs and persistence.

Use test databases and mock or sandbox external providers as appropriate.

### End-to-end testing

Verify important user-facing workflows across the backend.

Examples include:

- Registration, login, and authentication.
- Creating a workspace and adding members.
- Creating a project and assigning tasks.
- Sending and retrieving messages.
- Creating and updating meetings.
- Generating meeting summaries.
- Sending notifications.
- Uploading and retrieving authorized files.

Test only the workflows supported by the actual implementation.

Do not claim end-to-end completion when only unit tests or schema validation have passed.

## 5. Testing Framework and Scripts

Inspect the existing testing framework before adding dependencies.

Use the scripts already defined in `package.json`.

Where appropriate, maintain clear scripts for:

- Running unit tests.
- Running integration tests.
- Running the full test suite.
- Generating coverage reports.
- Validating Prisma schema changes.
- Generating Prisma Client.
- Running TypeScript checks.
- Building the production application.

Use the project's existing conventions for script names.

Do not invent commands and report them as successful without running them.

If a required script is missing, propose or implement it consistently with the current project configuration.

## 6. Test Isolation and Test Data

Tests must not accidentally modify development, staging, or production data.

Requirements:

- Use a dedicated test database or an appropriately isolated test environment.
- Never point destructive test setup at production.
- Never run database reset commands against an unverified database URL.
- Use deterministic fixtures and test factories where appropriate.
- Clean up only the test data created by the test.
- Avoid relying on the order in which tests run.
- Avoid sharing mutable test state across unrelated tests.
- Mock external providers when appropriate.
- Ensure tests remain repeatable.

Before running a test that creates, modifies, or deletes database records, verify that its database configuration is safe.

Never use real customer data as routine test fixtures.

## 7. Authentication and Authorization Tests

Nexus is a multi-workspace platform, so authorization is a critical testing requirement.

Test:

- Successful authentication.
- Invalid credentials.
- Expired or invalid authentication tokens.
- Missing authentication.
- Unauthorized role-based actions.
- Workspace membership checks.
- Project and task access restrictions.
- Private conversation access.
- Meeting and transcript access.
- File and attachment permissions.
- Invitation authorization.
- Administrative operations.

Verify that users cannot access another workspace's private resources by changing an identifier in a request.

Test both permitted and forbidden operations.

Do not treat a successful HTTP response as proof that the correct authorization rules are enforced.

## 8. API Testing

Test Express endpoints for correct behavior.

For each important endpoint, verify:

- HTTP status code.
- Response structure.
- Input validation.
- Authentication requirements.
- Authorization requirements.
- Database effects.
- Error handling.
- Pagination and filtering.
- Duplicate requests where relevant.
- Unexpected or malformed input.

Test common failure conditions, including:

- Missing required fields.
- Invalid identifiers.
- Nonexistent records.
- Duplicate records.
- Invalid enum values.
- Expired invitations or tokens.
- Foreign-key violations.
- Database connectivity failures.
- Provider failures.

Ensure error responses are consistent with the project's existing API conventions.

Do not expose stack traces, credentials, internal SQL details, or unnecessary infrastructure information to clients.

## 9. PostgreSQL and Prisma Verification

Before considering database-related work complete:

1. Validate the Prisma schema using the command supported by the installed version.
2. Generate Prisma Client when required.
3. Review any new migration.
4. Run migrations against an appropriate test database.
5. Verify the affected relationships and constraints.
6. Run relevant integration tests.
7. Confirm that existing application functionality remains intact.

Requirements:

- Preserve migration history.
- Do not edit already-applied migrations to disguise schema problems.
- Do not reset shared databases as a routine troubleshooting step.
- Do not use schema-push shortcuts to bypass the established migration workflow.
- Verify data preservation for migrations that change existing columns or relationships.
- Check indexes and query behavior for performance-sensitive operations.
- Verify that transactions and rollback behavior work as intended.

For production releases, apply migrations through a controlled deployment procedure.

If a migration is destructive or irreversible, explain the risks and obtain explicit approval before proceeding.

## 10. Redis and Socket.IO Testing

### Redis

Test relevant behavior such as:

- Successful connection.
- Connection failures.
- Key expiration.
- Cache invalidation.
- Rate-limiting behavior.
- Recovery from temporary unavailability.
- Duplicate-job prevention where Redis-backed jobs are used.

Verify that Redis failure does not silently compromise authorization or durable business data.

### Socket.IO

Test:

- Authentication during connection.
- Authorization before joining private rooms.
- Event payload validation.
- Authorized event delivery.
- Rejection of unauthorized events.
- Disconnect and reconnect behavior.
- Message persistence before successful broadcast.
- Duplicate event handling.
- Multi-instance delivery where configured.

Do not assume that starting the Socket.IO server proves that real-time functionality works correctly.

## 11. Email and AI Provider Testing

Use mocks, sandbox environments, or provider test modes whenever possible.

### Email

Verify:

- Correct recipient selection.
- Template rendering.
- Provider configuration.
- Failure handling.
- Retry behavior.
- Duplicate prevention.
- Verification and password-reset token behavior.

Do not send unintended real emails during automated tests.

### AI integrations

Verify:

- Successful provider responses.
- Timeouts and rate limits.
- Invalid or incomplete AI output.
- Input limits.
- Retry behavior.
- Data authorization before AI processing.
- Safe handling of generated content.
- Correct persistence of processing results.

Do not claim that an AI feature works end to end when only the provider call or database model has been tested.

## 12. Code Quality and Build Checks

Before releasing a feature, run the checks supported by the repository.

Depending on the existing configuration, these may include:

- TypeScript type checking.
- ESLint.
- Unit tests.
- Integration tests.
- Prisma schema validation.
- Prisma Client generation.
- Production build.
- Dependency or vulnerability checks.

Use existing scripts where available.

Fix issues introduced by the current changes.

Do not conceal test failures, suppress important errors, or disable existing checks merely to obtain a successful build.

Distinguish between:

- Checks that passed.
- Checks that failed.
- Checks that could not run.
- Checks that were not executed.

If an unrelated pre-existing failure prevents verification, identify it clearly rather than claiming that the entire project passes.

## 13. Environment Configuration

Keep environment-specific configuration separate from application code.

Typical configuration may include:

- `DATABASE_URL`
- Redis connection configuration.
- Authentication secrets.
- Email provider credentials.
- AI provider credentials.
- Frontend or application URLs.
- File-storage configuration.
- Logging configuration.
- Port and runtime settings.

These are examples only. Inspect the actual configuration before adding variables.

Requirements:

- Never hardcode credentials.
- Never commit populated `.env` files containing secrets.
- Preserve existing environment variable names unless a coordinated change is required.
- Validate required variables at startup.
- Use separate configurations for local development, testing, staging, and production.
- Keep secrets in the deployment platform's secret-management facilities.
- Never print secrets in logs or build output.
- Provide an environment variable example file containing placeholders, not real credentials.

Do not expose server-only variables through frontend-prefixed environment variables.

## 14. Production Build and Startup

Verify that the backend can be built and started using the deployment platform's actual configuration.

Requirements:

- Confirm the correct Node.js runtime version.
- Verify dependency installation and lockfile consistency.
- Confirm TypeScript compilation where applicable.
- Verify Prisma Client generation when required.
- Confirm the production start command.
- Validate environment variables.
- Ensure the server listens on the port supplied by the hosting platform when required.
- Verify database connectivity and migration readiness.
- Ensure startup failures are reported clearly.
- Avoid relying on development-only commands in production.

Do not assume that a successful local development run proves that the production build will succeed.

## 15. CI/CD and GitHub Workflows

Reuse the existing GitHub Actions or other CI/CD configuration where available.

A suitable backend pipeline may include:

1. Checkout the repository.
2. Set up the supported Node.js version.
3. Install dependencies using the committed lockfile.
4. Validate environment configuration for the test environment.
5. Run linting and type checks where configured.
6. Validate the Prisma schema.
7. Run tests against the required isolated services.
8. Build the application.
9. Deploy only when the configured branch, approvals, and checks permit it.

Requirements:

- Keep deployment secrets in approved secret storage.
- Use least-privilege permissions for workflow tokens.
- Pin actions appropriately according to project security practices.
- Avoid printing secrets in workflow logs.
- Separate validation jobs from production deployment jobs.
- Prevent unintended deployments from untrusted branches.
- Do not disable failing workflows without understanding the cause.

Do not replace a working deployment workflow unless the change is necessary and appropriately reviewed.

## 16. Deployment Strategy

Deploy using the platform already configured for Nexus.

Before deploying:

1. Inspect the deployment configuration.
2. Verify the target environment and Git branch.
3. Confirm that required environment variables are configured.
4. Ensure tests and build checks have passed.
5. Review database migration impact.
6. Confirm that the release is compatible with the currently deployed version.
7. Establish a rollback or recovery plan appropriate to the change.

Deploy incrementally where possible.

Use staging or a preview environment before production for changes that could affect data integrity, authentication, authorization, or external integrations.

Do not claim a deployment succeeded unless the hosting platform confirms success and the deployed application has been verified.

## 17. Database Migration Deployment

Treat production migrations as a separate, controlled concern.

Requirements:

- Review generated SQL and data transformations.
- Confirm that a backup or suitable recovery mechanism exists for high-risk changes.
- Prefer backward-compatible schema changes where possible.
- Avoid requiring the old application and new schema to change atomically when the platform cannot guarantee that.
- Use expand-and-contract migrations for risky breaking changes.
- Avoid running multiple competing migration processes concurrently.
- Verify migration status before and after deployment.
- Test rollback or recovery procedures where feasible.

Do not assume that rolling back application code automatically rolls back database changes.

Never perform a production database reset to recover from an ordinary deployment failure.

## 18. Logging and Monitoring

Use the existing logging and monitoring architecture.

Record useful operational information such as:

- Request failures.
- Authentication and authorization failures.
- Database connectivity issues.
- Failed migrations.
- Redis connection problems.
- Socket.IO connection and delivery errors.
- Background job failures.
- Email or AI provider failures.
- Application startup and shutdown events.

Requirements:

- Avoid logging passwords, authentication tokens, API keys, or unnecessary personal data.
- Include useful error context and correlation identifiers where supported.
- Use appropriate log levels.
- Ensure unhandled errors are visible to operators.
- Monitor repeated failures and resource exhaustion.
- Provide health checks that reflect the actual service requirements.

Do not return detailed internal errors to clients simply because they appear in server logs.

## 19. Performance and Reliability

Check for common causes of production instability.

Depending on the affected feature, inspect:

- Slow database queries.
- Missing indexes.
- Unbounded queries.
- Excessive memory usage.
- Resource leaks.
- Unhandled promise rejections.
- Repeated background jobs.
- Connection pool exhaustion.
- Redis dependency failures.
- Socket.IO reconnection behavior.
- Long-running requests.
- Provider timeouts and rate limits.

Do not optimize blindly. Use logs, tests, metrics, query plans, or profiling to establish the actual problem.

Avoid introducing infrastructure or dependencies without a demonstrated requirement.

## 20. Security Verification

Security checks are part of the release process.

Verify:

- Authentication and authorization.
- Input validation.
- Workspace isolation.
- Secure environment configuration.
- Rate limiting.
- Dependency security.
- File-upload validation where applicable.
- Safe error handling.
- CORS and other relevant HTTP security configuration.
- Database permissions and migration safety.
- Protection of private messages, meeting data, and AI-generated content.

Do not disable security controls to make a failing test or deployment pass.

Report unresolved high-risk issues before recommending a production release.

## 21. Troubleshooting Workflow

When a test or deployment fails:

1. Capture the exact error message and relevant logs.
2. Identify the failing command, service, or workflow step.
3. Inspect the related source code and configuration.
4. Determine whether the issue is caused by code, dependencies, infrastructure, environment variables, database state, or permissions.
5. Reproduce the problem safely where possible.
6. Implement the smallest justified fix.
7. Run the relevant regression tests.
8. Verify that the fix does not introduce unrelated changes.
9. Document the root cause and the verification results.

Do not repeatedly change configuration without evidence.

Do not delete migration files, reset databases, remove dependencies, or overwrite environment files as generic troubleshooting steps.

## 22. Rollback and Incident Recovery

Prepare a recovery strategy appropriate to each release.

Depending on the platform and change, this may involve:

- Reverting to a previously deployed application version.
- Disabling a problematic feature through a supported feature flag.
- Restoring compatible environment configuration.
- Applying a forward database migration.
- Restoring data through an approved backup procedure.
- Reprocessing failed background jobs safely.

Requirements:

- Assess database compatibility before reverting application code.
- Preserve evidence needed to investigate the failure.
- Avoid irreversible recovery actions without explicit approval.
- Verify application health after recovery.
- Document the cause, impact, and corrective action.

Do not assume that every migration can be reversed safely.

## 23. Definition of Done

A testing or deployment task is complete when all applicable requirements are satisfied:

- Relevant tests have been run.
- Type checks and build checks have been completed where configured.
- Database changes have been validated.
- Security and authorization checks have been considered.
- Environment configuration is correct.
- The deployment target and branch are verified.
- Migration risks and recovery requirements have been assessed.
- Relevant application health checks pass.
- Failures and incomplete checks are reported honestly.
- No unrelated local work or production data has been damaged.
- Documentation reflects the actual implementation.

## 24. Required Agent Behavior

Always inspect the repository and current Git state before making testing or deployment changes.

Preserve existing functionality, configuration, and user changes.

Never expose secrets or perform destructive production operations without explicit approval.

Never report tests as passed unless they were actually executed and succeeded.

Never report a deployment as successful without confirmation and appropriate verification.

After completing a task, report:

- What was tested or changed.
- Which commands were executed.
- Which checks passed and failed.
- Any environment or migration requirements.
- Whether deployment occurred and how it was verified.
- Any unresolved risks or recommended follow-up work.
