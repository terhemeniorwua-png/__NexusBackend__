# NEXUS BACKEND — IMPLEMENTATION PHASE TRACKER

## 1. Purpose

---

## Progress Dashboard

| Metric | Count |
|---|---|
| **Project** | Nexus Backend |
| **Numbered phase definitions** | 30 |
| **Current active phase** | Phase 7 — Teams, departments and groups |
| **Aggregate progress** | Not calculated: legacy and canonical phase lists contain duplicate and missing phase numbers |

_Update the phase-specific status beside its acceptance criteria. Do not use the retired 24-phase aggregate counts._

**Roadmap numbering reconciliation (2026-11-05):** The file contains a legacy 24-phase dashboard and milestone summary, duplicate legacy/canonical sections for Phase 7, and canonical phase headers through Phase 32. The canonical numbered definitions total 30 because Phases 6 and 29 have no canonical section. Existing phase scopes and numbering are preserved; Phase 7 remains the active phase. The earlier summary list's use of Phases 5–7 for different scopes is historical and does not supersede the canonical Phase 7 section below.

---

Nexus is a Real-Time Workspace & Project Management Platform that combines project management, collaboration, communication, file management, scheduling, and AI-powered productivity.

The backend is responsible for application business logic, authentication, authorisation, workspace isolation, data persistence, real-time communication, integrations, notifications, and coordination with the separate Python AI service.

This tracker must be treated as the authoritative implementation sequence for backend development.

## 3. Verified Progress Snapshot — 2026-11-03

| Phase | Status | Evidence / remaining work |
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

#### Phase 1 — Foundation and infrastructure `[x]`

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

**Blockers / Notes:** Verified on 2026-10-21. `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm test` (14/14 tests) pass. The built server was smoke-tested against an ephemeral PostgreSQL 16 container and local Redis: liveness returned 200, readiness returned 200 with both dependencies up, and `SIGTERM` triggered graceful shutdown. No domain models were created; Phase 2 must add the core Prisma models and first migration. Known advisory note: `npm audit` still reports issues in Prisma 6 CLI tooling (`deepmerge-ts`) and legacy Sequelize (`uuid`); these were not force-fixed because that would require breaking upgrades or unrelated dependency removal outside Phase 1. Phase 1.1 remediation on 2026-11-01: corrected the global rate-limit error handler in `src/app.ts`, which previously registered a new Express middleware and logged on every 429, causing unbounded middleware stack growth; the handler now only delegates the 429 to the central error handler. Regression tests in `tests/foundation.test.ts` cover within-limit requests, the standard 429 body and request id, no stack or `AppError` leakage, continued blocking, and route-level limiter behavior. Verification: the targeted foundation suite passes 8/8, `npm test` passes 100 tests with 1 skipped, and `npm run typecheck`, `npm run lint` and `npm run build` pass.

---

#### Phase 1.2 — Redis-backed distributed rate limiting `[x]`

**Objective:** Ensure every Express rate limiter uses shared Redis counters across backend instances and fails closed when distributed enforcement is unavailable.

**Deliverables:**
- The global limiter is created through the shared `createRateLimiter` middleware and uses the Redis-backed store.
- Route-specific authentication, invitation and workspace limiters use the same store and key convention.
- The in-process fallback was removed. Redis unavailability produces a controlled `503 RATE_LIMIT_UNAVAILABLE` response.
- Counters use `rl:{namespace}:{client-key}` keys with a millisecond TTL; the global limiter uses the `:global` namespace.
- The store reuses the shared Redis client from `src/db/redis.ts` and does not open a connection per request. The server remains responsible for connect/disconnect lifecycle.
- Health endpoints remain exempt from the global limiter. Client identity uses `req.ip` and the existing `TRUST_PROXY` setting rather than an arbitrary forwarded header.
- Tests cover shared counters, window rollover, fail-closed behavior, route-level limiters, proxy-header handling and failure cleanup, with a gated real-Redis integration test.

**Dependencies:** Phase 1 and Phase 1.1 complete.

**Verification criteria:**
- Global and route-level limiter tests pass.
- Counters are shared by two limiter instances using the same Redis key space.
- Redis failure returns the documented fail-closed response.
- Type checking, linting and build pass.

**Blockers / Notes:** Verified on 2026-11-01. Implemented in `src/services/cache/rate-limit-store.ts`, `src/middleware/rate-limit.ts` and `src/app.ts`. The store now requires a ready shared Redis client, uses an atomic Lua increment with a millisecond TTL, and throws `RateLimitStoreUnavailableError` (`503 RATE_LIMIT_UNAVAILABLE`) when Redis cannot confirm a counter. Decrement and reset operations log failures without creating unhandled rejections. The global limiter now uses the same middleware and store as the route-specific limiters with the namespace `${RATE_LIMIT_NAMESPACE}:global`; the health endpoints remain skipped. No new dependency or environment variable was added: `REDIS_URL`, `RATE_LIMIT_NAMESPACE`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` and `TRUST_PROXY` are reused. Tests: `tests/rate-limit-redis.test.ts` covers shared counters, window rollover, two applications sharing the global counter, fail-closed global and route-level behavior, untrusted forwarded addresses and failure cleanup. The gated real-Redis suite passes 8/8 with `RUN_REDIS_TESTS=true REDIS_TEST_URL=redis://localhost:6379/15`. The full `npm test` suite passes 107 tests with 2 skipped DB integration suites. `npm run typecheck`, `npm run lint`, `npm run build` and `npm run format:check` pass. The Phase 4, 5 and 6 DB suites now connect the test Redis before creating the app so their rate-limited requests use the distributed store.

---

#### Phase 1.3 — Remove obsolete legacy JavaScript middleware and validators `[x]`

**Objective:** Remove the legacy CommonJS middleware and validator files that were superseded by the TypeScript application shell and module-level Zod schemas.

**Deliverables:**
- Removed `src/middleware/authorization.js`, `src/middleware/logger.js` and `src/middleware/validator.js`.
- Removed `src/validators/avatar.js`, `src/validators/login.js`, `src/validators/registration.js` and `src/validators/verification.js`; the now-empty `src/validators` directory was removed.
- Preserved the active implementations: `src/middleware/validation.ts`, `src/utils/logger.ts`, `src/middleware/request-logger.ts`, `src/middleware/authenticate.ts`, `src/modules/authorization/*`, `src/modules/auth/auth.schemas.ts` and `src/modules/users/users.schemas.ts`.
- Confirmed that no tracked source, test, script or documentation references the removed files or their exported symbols.
- No runtime dependency, API contract, environment variable or database schema changed.

**Dependencies:** Phases 1, 1.1 and 1.2 complete.

**Verification criteria:**
- No `.js` files remain under `src/`.
- No imports, requires, dynamic imports or string references to the removed modules remain.
- The validation, authorization and logging tests continue to pass.
- Type checking, linting, build and formatting checks pass.

**Blockers / Notes:** Verified on 2026-11-01. The audit found seven tracked CommonJS files with no references anywhere in `src`, `tests`, package scripts or documentation. `authorization.js` additionally imported the removed `models` module and `src/services/pin`, so it could not execute against the current tree. The active TypeScript validation middleware (`src/middleware/validation.ts`) and module schemas (`auth.schemas.ts`, `users.schemas.ts`) replace `validator.js` and the four files in `src/validators`; `src/utils/logger.ts` and `request-logger.ts` replace `logger.js`; `authenticate.ts` and `src/modules/authorization` replace `authorization.js`. Verification: `find src -name '*.js'` returns no files, the stale-reference search returns no matches, and `npm test` passes 107 tests with 2 skipped integration suites. `npm run typecheck`, `npm run lint`, `npm run build` and `npm run format:check` pass. Generated `dist/` output is ignored and was not edited.

---

#### Phase 2 — Database architecture and migrations `[x]`

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
- Documented placeholders for future models (messages, meetings, AI usage, integrations) without full implementation

**Dependencies:** Phase 1

**Verification criteria:**
- Fresh database setup runs all migrations without errors
- Seed script populates test data reproducibly
- Uniqueness, foreign-key, and index constraints verified by tests or migration review
- Migration application verified against a disposable database
- Recovery procedure tested: backup/restore, failed-migration resolution and forward corrective migration
- Data integrity verified after each tested recovery
- Migration history and schema drift checked before and after recovery
- Evidence documented in `docs/migration-recovery.md`
- Remaining limitations explicitly acknowledged; no claim is made that every migration has a tested down path

**Blockers / Notes:** Verified on 2026-10-21. Schema covers User/UserProfile/Session/AuthToken, Workspace/WorkspaceMembership, Team/TeamMembership, Project/ProjectMembership, Task/TaskAssignee/TaskDependency, Comment, Notification, Invitation, FileAttachment, AuditLog with enums, timestamps, soft deletes where needed, unique composite keys, foreign keys with appropriate cascade/restrict, and indexes. Migration `20261021023018_phase2_nexus_core_schema` created/applied; Prisma client regenerated. Seed script created and tested against ephemeral PostgreSQL (2 users, 1 workspace, 1 team, 1 project, 1 task, 1 comment, 1 invitation, 1 notification). Future models documented in `docs/planned-models.md`. No existing Phase 1 code rebuilt. Dependencies Phase 1 satisfied. The rollback/recovery criterion is satisfied by Phase 2.2: Prisma has no automatic down migrations, so recovery uses backup/restore, failed-migration resolution and forward corrective migrations, verified in `docs/migration-recovery.md`.

---

#### Phase 2.1 — Database model audit `[x]`

**Objective:** Audit the Phase 2 schema against the planned-model list, determine whether any missing models are a genuine defect, and document the result without making unjustified schema changes.

**Deliverables:**
- Compared `prisma/schema.prisma` with `docs/planned-models.md` and the roadmap.
- Confirmed the active ORM and migration system is Prisma (`@prisma/client` 6.19.3); the Sequelize packages in `package.json` are unused.
- Verified all 21 current models and 16 enums against implemented modules, routes, services and tests.
- Classified every deferred model by its roadmap phase and dependency.
- Confirmed no implemented Phase 1–6 feature requires messages, meetings, AI usage, generic integrations or generic webhook models.
- Confirmed `EmailWebhookEvent` covers the Phase 4 provider-webhook requirement, while generic `WebhookSubscription` and `WebhookDelivery` remain Phase 20 work.
- Documented the audit decision, implemented model inventory, deferred-model mapping and change policy in `docs/planned-models.md`.
- Made no Prisma schema or migration changes.

**Dependencies:** Phase 2 complete.

**Verification criteria:**
- The schema validates and the Prisma client generates.
- All six existing migrations apply to a disposable test database.
- The migration history matches the schema with no drift.
- Phase 2 database tests pass.
- The audit result is documented and the deferred models remain out of scope until their roadmap phases.

**Blockers / Notes:** Audited on 2026-11-01. `npx prisma validate`, `npx prisma generate`, `npx prisma migrate deploy` and `npx prisma migrate diff --exit-code` pass; the migration diff reports no difference. `tests/database-phase2.test.ts` passes 2/2 with `RUN_PHASE2_DB_TESTS=true` against a disposable PostgreSQL 16 container. Conclusion: the deferred models are not a Phase 2 defect; adding them now would be premature. The full database-enabled suite currently reports 176 passed and 10 failed, all failures confined to the pre-existing Phase 6 ownership-transfer integration tests. Those failures are unrelated to Phase 2.1: `tests/phase6-authorization-db.test.ts` reads `data.id` instead of `data.user.id` from `/api/v1/auth/me`, and `src/modules/workspaces/workspace.routes.ts` registers `/:workspaceId/owner` while the OpenAPI contract and tests use `/:workspaceId/owner/:userId`. The Phase 6 blocker is recorded here and left untouched under the Phase 2.1 scope.

---

#### Phase 2.2 — Database migration rollback and recovery `[x]`

**Objective:** Establish and verify a safe recovery strategy for Prisma migrations without assuming that every migration has a reversible down path.

**Deliverables:**
- Documented the difference between application deployment rollback, schema reversal, failed-migration recovery and backup restoration.
- Reviewed all six committed migrations and classified their operations and reversal risks.
- Confirmed Prisma Migrate is the active migration system and that it does not provide automatic down migrations.
- Documented the recovery policy in `docs/migration-recovery.md`.
- Added `scripts/verify-migration-recovery.sh`, which tests baseline migration, schema drift, backup/restore, failed-migration resolution and forward corrective migration against a disposable database.
- Preserved all existing migration files and migration history; no migration was edited, deleted or reset.
- Verified that a backup restores data, a failed migration can be resolved, and a forward corrective migration preserves existing rows.
- Updated the Phase 2 verification criteria to distinguish migration application, recovery testing, data integrity, evidence and remaining limitations.

**Dependencies:** Phases 2 and 2.1 complete.

**Verification criteria:**
- All committed migrations apply to a disposable database.
- The resulting schema matches `prisma/schema.prisma` with no drift.
- A backup/restore round trip preserves sentinel data.
- A failed migration is recorded by Prisma and can be marked rolled back.
- A forward corrective migration preserves existing data and restores the intended schema shape.
- The database returns to a known-good six-migration state after testing.
- The verification procedure is repeatable through the script.
- Remaining production backup, restore and deployment limitations are documented.

**Blockers / Notes:** Verified on 2026-11-01 against a disposable PostgreSQL 16.15 container using `nexus_test`, `nexus_shadow`, `nexus_probe`, `nexus_probe_corrective` and `nexus_restore` databases. The six committed migrations apply successfully, `prisma migrate diff` reports no difference, and `tests/database-phase2.test.ts` passes 2/2. `scripts/verify-migration-recovery.sh` passed all six stages: baseline application and drift check, sentinel-data backup/restore, failed-migration `P3018` detection and `migrate resolve --rolled-back`, forward add-column and corrective drop-column migrations with data preserved, and final known-good restore. A separate restore into `nexus_restore` also reported the schema up to date. No per-migration down scripts exist by design; destructive changes rely on verified backup restoration or forward corrective migrations. No shared, staging or production database was accessed. The repository still lacks automated backup scheduling, retention, encryption, point-in-time recovery and a staging deployment rollback exercise; those remain Phase 23/24 work. The pre-existing Phase 6 DB test failures remain documented and unchanged.

---

#### Phase 3 — Authentication and account lifecycle `[x]`

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

**Blockers / Notes:** Verified on 2026-10-21. Session strategy decided: a short-lived HS256 access token (15 min) returned in the body and sent as `Authorization: Bearer`, plus an opaque 32-byte refresh token delivered in the httpOnly `nexus_rt` cookie whose SHA-256 digest is stored in `Session.refreshTokenHash`. Every authenticated request re-checks the session row, so sign-out, password change and password reset revoke access immediately. The refresh token rotates on every use and keeps `previousRefreshTokenHash`, so a replayed token triggers `SESSION_REUSE_DETECTED` and revokes every session of the account. Cookie-authenticated requests must also send `x-csrf-token` (HMAC of the session id under a key derived from `JWT_ACCESS_SECRET`); body-supplied refresh tokens are exempt. Implemented as `src/modules/auth` (service, controller, routes, session, one-time token, access token, CSRF and security-event modules), `src/modules/users` (profile read/update), `src/middleware/authenticate.ts`, `src/middleware/rate-limit.ts`, `src/services/cache/rate-limit-store.ts` (Redis with in-memory fallback), `src/services/password.ts` (bcrypt, 72-byte limit enforced in the schema and the service) and `src/services/email` (delivery seam with a logging sender; the provider adapter is Phase 4 work). Rate limits cover login, registration, verification and password requests per IP address and per account using `express-rate-limit` v8 with a `RATE_LIMIT_NAMESPACE`-prefixed Redis key. Verification, reset and email-change tokens are single-use, expiring, stored only as digests, and the newest token invalidates older ones of the same purpose. Account events are written to `AuditLog` with a null `workspaceId` and never contain passwords, tokens or links. Schema changes: `AuthToken.targetEmail` made optional, `AuditLog.workspaceId` made nullable with a `createdAt` index, and `Session.previousRefreshTokenHash` added with a unique index — applied through migrations `20261021105314_phase3_auth_lifecycle` and `20261021105500_phase3_session_rotation`. Verification: `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check` pass; `npm test` passes 63/63 with `RUN_PHASE2_DB_TESTS=true RUN_PHASE3_DB_TESTS=true DATABASE_URL=postgresql://nexus:nexus@localhost:5433/nexus_test` against an ephemeral PostgreSQL 16 container and local Redis. The suite covers the full register → verify → login → logout flow, expired and reused token rejection, refresh rotation and replay detection, CSRF enforcement, session revocation on sign-out and password reset, rate limiting of brute-force attempts, blocked access for unverified accounts, email change confirmation, deactivation, deletion with anonymisation, profile updates and the audit trail. Phase 4 replaced the logging email sender with the transactional provider adapter, so the one-time links are now delivered through the outbox.

---

#### Phase 3.1 — Account reactivation and deactivation hardening `[x]`

**Objective:** Close the account-lifecycle gap left by Phase 3: a deactivated account had no supported recovery path, and deactivation left outstanding credentials that could restore access.

**Deliverables:**
- Self-service reactivation for a deactivated account using its email address and password
- Reactivation that never creates a session and requires a fresh sign-in
- Return an unverified account to `PENDING_VERIFICATION` with a new verification email
- Reject reactivation for active, suspended, deleted and non-deactivated accounts
- Revoke every session and invalidate every outstanding one-time token on deactivation
- Prevent email-change confirmation from activating a suspended or deactivated account
- Security event logging for successful and failed reactivation attempts
- API, OpenAPI and README documentation

**Dependencies:** Phases 2, 3, 4

**Verification criteria:**
- A deactivated account can reactivate and sign in again
- Reactivation returns no access token, refresh token or session
- Old access and refresh tokens stay invalid after reactivation
- Deleted and suspended accounts cannot reactivate themselves
- Pre-deactivation verification, reset and email-change tokens cannot restore access
- Reactivation is rate limited and does not reveal whether an account exists
- The Phase 3 authentication suite passes against PostgreSQL and Redis

**Blockers / Notes:** Implemented on 2026-11-01. The original Phase 3 audit findings were not present in the repository, git history, pull requests or issues, so the expected behaviour was derived from the existing account lifecycle and the product requirement that deactivation be reversible. The endpoint is `POST /api/v1/auth/reactivate` with the same `{ email, password }` contract and rate limiters as sign-in. It restores `ACTIVE` only when the address was already verified; otherwise it restores `PENDING_VERIFICATION` and sends a fresh verification link, so reactivation cannot bypass email verification. Active accounts return `409 ACCOUNT_ALREADY_ACTIVE`, suspended accounts `403 ACCOUNT_SUSPENDED`, non-deactivated pending accounts `409 ACCOUNT_NOT_DEACTIVATED`, and deleted or unknown accounts or a wrong password return the same `401 INVALID_CREDENTIALS` response after a bcrypt timing equaliser. The status update is conditional on `status = DEACTIVATED` and `deletedAt IS NULL`, so concurrent requests cannot both succeed. Deactivation is now one transaction that sets the status, revokes every session and marks every unused `AuthToken` as used, not only `EMAIL_VERIFICATION`; reactivation also revokes any remaining session and token before returning the new status. `confirmEmailChange` rejects suspended and deactivated accounts before updating the address, closing the path where a pre-deactivation email-change token could set the status back to `ACTIVE`. Reactivation and failure events are written to `AuditLog` without passwords or tokens. No schema migration was required. The Phase 3 integration suite now has 37 tests, including nine reactivation and credential-invalidation cases; it passes 37/37 with `RUN_PHASE3_DB_TESTS=true TEST_DATABASE_URL=postgresql://test:test@localhost:55435/nexus_test NODE_ENV=test node --import tsx --test tests/auth-phase3.test.ts` against an ephemeral PostgreSQL 16 container and Redis database 15. The full Phase 2-5 database-enabled suite passes 166/166 with the same database and Redis database 15; `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check` and `prisma validate` pass. Remaining limitation: there is no administrator role or suspension endpoint, so reactivation is self-service only; administrative recovery would need an explicit privileged workflow in a later phase.

**Follow-up verification (2026-11-01):** A code review found that valid credentials rejected for an ineligible account were not consistently recorded as failed reactivation events. Those status failures and a concurrent reactivation loss are now audited, and tests assert the status-specific audit reasons. A PostgreSQL trigger test verifies that a failure while revoking sessions rolls back the deactivation status change as well. The updated Phase 3 integration suite passes 39/39; the complete Phase 2–5 database-enabled suite passes 168/168 against a disposable PostgreSQL 16 database. Redis was unavailable in this environment, so rate-limit tests exercised the configured in-process fallback. `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check` and `git diff --check` pass. No schema change was needed. Commits `2256a7d` (`Account Reactivation`) and `a1bad1f` (`fix(phase-3.1): preserve concurrent failure audit`) are pushed to `origin/feature/phase-3.1-account-reactivation`.

---

#### Phase 3.2 — Account deletion and workspace ownership `[x]`

**Objective:** Prevent account deletion while the account remains the owner of any persisted workspace.

**Deliverables:**
- Block deletion for owned workspaces in every persisted state, including `ACTIVE`, `ARCHIVED`, and soft-deleted rows
- Preserve the existing requirement that ownership be transferred to an existing workspace member before account deletion
- Keep a rejected deletion side-effect free, including sessions and one-time tokens
- Serialize account deletion against workspace creation and ownership transfer
- Keep workspace ownership transfer atomic and restricted to active accounts
- Align the transfer route with its documented `/workspaces/{workspaceId}/owner/{userId}` contract

**Verification criteria:**
- Active, archived, soft-deleted, and mixed-status owned workspaces block account deletion
- Membership and workspaces owned by another account do not block deletion
- A successful ownership transfer permits deletion by the previous owner
- A failed transfer leaves ownership unchanged and deletion blocked
- Database failure rolls back deletion changes
- Concurrent workspace creation or ownership transfer cannot attach a workspace to a deleted account
- Phase 3 account lifecycle tests and broader regression checks pass

**Blockers / Notes:** The root defect was an account deletion count filtered by both `deletedAt: null` and `status: 'ACTIVE'`, which omitted archived workspace rows. The workspace model has only `ACTIVE` and `ARCHIVED` states; workspace deletion is soft and sets `deletedAt` while retaining the `ownerId` foreign key (`ON DELETE RESTRICT`). There is no permanent workspace removal path, so any retained row with `ownerId` equal to the account remains relevant, even if soft-deleted. Deletion returns the existing `409 WORKSPACE_OWNERSHIP_TRANSFER_REQUIRED` response until the current owner transfers each workspace to an existing, active member. The ownership check, session revocation, token invalidation, profile anonymisation, and user update now run in one transaction after locking the user row. Workspace creation and ownership transfer take compatible owner-row locks and revalidate account state inside their transactions; transfer also conditionally updates the workspace only if the caller remains its owner. No schema migration was required. The Phase 3 integration suite passes 48/48; the complete regression suite with Phase 2–5 database suites and Phase 6 unit tests passes 177/177. `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and `git diff --check` pass. Redis was unavailable, so rate limits used the existing in-process fallback. The separate Phase 6 database suite still has pre-existing fixture defects: it reads the user ID from the wrong `/auth/me` response shape and its teardown deletes users before owner-restricted workspace rows. The new Phase 3 integration tests cover the transfer endpoint and its concurrency behavior. Implementation commit `d851cb1` (`fix(phase-3.2): guard account deletion against retained ownership`) is pushed to `origin/feature/phase-3.2-account-deletion-ownership`.

---

#### Phase 3.3 — Atomic refresh-token rotation `[x]`

**Objective:** Prevent concurrent refresh requests from successfully consuming the same session refresh-token state.

**Deliverables:**
- Compare-and-swap a refresh only while the session still contains the presented token hash and remains unrevoked and unexpired
- Preserve existing expired, revoked, invalid-token, and refresh-token reuse responses
- Return a replacement token only after the conditional database update succeeds
- Add real PostgreSQL coverage for two simultaneous refresh requests against one session

**Verification criteria:**
- One of two concurrent requests using the same original token succeeds, and the other receives the established reuse failure
- The stored current and previous token hashes match the successful rotation
- Failed persistence returns no replacement token and leaves the previous token state intact
- Existing refresh, expiry, replay, and logout tests pass

**Blockers / Notes:** Implemented on 2026-11-01. The defect was a lookup by refresh-token hash followed by an unconditional update by session ID, allowing concurrent requests to overwrite each other's replacement hash and both receive a token. Rotation now uses a Prisma `updateMany` compare-and-swap matching the session ID, original refresh-token hash, `revokedAt: null`, and future expiry; the replacement token is returned only after one row is changed and the new hash is read back. A losing request is identified through `previousRefreshTokenHash` and follows the established replay policy: `SESSION_REUSE_DETECTED` and revocation of the account's sessions. No schema or API changes were needed. A deterministic PostgreSQL test locks the session row until both concurrent refresh updates are waiting, then releases them together; exactly one request succeeds, the loser gets the reuse failure, and the database retains the winner's replacement hash and the original previous hash. A trigger-injected persistence failure returns no refresh cookie and leaves the original hashes intact. The Phase 3 PostgreSQL suite passes 52/52, including refresh success, expiry, revocation, invalid token, race, persistence failure, replay, CSRF, and logout checks. The repository-wide `npm test` passes 97 tests with one opt-in Phase 3 DB suite skipped; its loopback HTTP tests required local networking access and passed on rerun. `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and `git diff --check` pass. Tests used a disposable PostgreSQL 16 database; Redis was unavailable, so the existing rate-limit fallback was used. No known rotation race remains. By existing policy, a concurrent loser is indistinguishable from reuse and revokes the session family, so an ordinary simultaneous refresh retry can require a fresh sign-in. Implementation commit `7c7be30` (`fix(phase-3.3): make refresh rotation atomic`) is pushed to `origin/feature/phase-3.3-atomic-refresh-token-rotation`.

---

#### Phase 3.4 — Account deletion transaction consistency `[x]`

**Objective:** Keep account deletion and security-state changes consistent when a database operation fails or deletion requests race.

**Deliverables:**
- Keep ownership validation, session revocation, one-time token invalidation, profile anonymization, and account deletion in one database transaction
- Preserve workspace ownership safeguards and existing error responses
- Verify rollback when a later deletion operation fails after session and token updates have executed
- Verify successful deletion commits session revocation and concurrent deletion requests serialize safely

**Verification criteria:**
- Workspace ownership rejection leaves the account and sessions unchanged
- A failure during session revocation or a later account update rolls back account, session, token, and profile changes
- Successful deletion commits account anonymization and session revocation
- Concurrent deletion requests produce one successful deletion and one already-deleted response
- Authentication remains usable after a rolled-back deletion and revoked after a successful deletion

**Blockers / Notes:** Verified on 2026-11-01. The audit described a prior ordering bug: session revocations committed before the account-deletion transaction, so a later transaction failure could leave an active account signed out. That defect was already corrected in Phase 3.2 (`d851cb1`): `deleteAccount` locks the user row with `FOR UPDATE`, checks ownership before mutation, then revokes sessions, invalidates unused one-time tokens, anonymizes the profile, and updates the user inside one Prisma PostgreSQL transaction. Phase 3.4 made no production-code change because this transaction strategy is present; it strengthened integration coverage. A PostgreSQL trigger now fails the final user update after session, token, and profile writes have run, and the test verifies all those records roll back and the account's access token remains usable. Success tests assert `ACCOUNT_DELETED` revocation is committed and the old access token is rejected. A deterministic row-lock test verifies two simultaneous deletion requests return one `204` and one `409`; another races refresh against deletion and verifies the final account and session are deleted/revoked regardless of which update wins the session row. The existing ownership rejection test confirms no account or session changes occur when ownership remains unresolved. The Phase 3 PostgreSQL suite passes 55/55. `npm test` passes 97 tests with one opt-in Phase 3 database suite skipped (that suite was run separately); `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and `git diff --check` pass. Tests used the disposable PostgreSQL 16 database. Redis was unavailable, so rate limits used the existing in-process fallback. The `AccountDeleted` audit event is written after commit via `recordSecurityEvent`, whose established contract makes audit-write failures best-effort and non-fatal; this log row is the only database operation outside the atomic account/session transaction. The flow performs no external calls. Test commits `118cf64` (`test(phase-3.4): verify account deletion rollback`) and `ec29ff8` (`test(phase-3.4): cover refresh deletion race`) are pushed to `origin/feature/phase-3.4-account-deletion-transaction-consistency`.

---

#### Phase 3.5 — Authentication debug cleanup `[x]`

**Objective:** Remove obsolete commented-out debug logging from the authentication module without changing runtime behavior.

**Deliverables:**
- Remove only obsolete commented `console.log` statements in authentication service and controller code
- Preserve active code, useful comments, and all runtime logging

**Verification criteria:**
- Authentication-module search finds no remaining commented `console.log` statements
- Diff contains no executable logic changes
- Authentication unit and PostgreSQL integration tests, typecheck, lint, and formatting checks pass

**Blockers / Notes:** Verified on 2026-11-01. Removed four commented debug statements: registration-stage logs for `hashing`, `creating user`, and `queueing email` from `auth.service.ts`, and the `handler reached` log from `auth.controller.ts`. Also removed the two standalone `// ...` placeholder comments interspersed in the same obsolete service debug block. No active logging, explanatory comments, executable logic, or authentication behavior was changed. The auth-module search returns no commented `console.log` calls. `tests/auth-unit.test.ts` passes; `tests/auth-phase3.test.ts` passes 55/55 against disposable PostgreSQL. Typecheck, lint, format check, and `git diff --check` pass. Implementation commit `7de01e0` (`chore(phase-3.5): remove commented auth debug logs`) is pushed to `origin/feature/phase-3.5-auth-debug-cleanup`.

---

#### Phase 4 — Transactional email and delivery infrastructure `[/]`

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

**Blockers / Notes:** Verified on 2026-10-21 except for the two external checks that cannot be performed locally, see below. Provider decision: the transport is provider agnostic and speaks SMTP, because Resend, Brevo and Amazon SES all expose an SMTP endpoint, so only the connection details change when the provider changes. `nodemailer` was already a dependency and is now used for the SMTP transport; no new dependency was added. Two additional transports exist for non-production use: `console` records the delivery metadata without sending, `disabled` accepts messages without sending them. Production requires `EMAIL_PROVIDER=smtp`. Implemented as `src/services/providers/email` (`types.ts` with the `EmailTransport` and `EmailMessage` contracts, `smtp-transport.ts`, `console-transport.ts`, `error-classification.ts` that decides whether a failure is transient from the SMTP reply code, and `index.ts` with `createEmailTransport`), `src/services/email` (`delivery.service.ts`, `suppression.service.ts`, `webhook.service.ts`, `worker.ts`, and the rewritten `index.ts` seam that keeps the Phase 3 `setEmailSender`/`getEmailSender` contract), `src/services/email/templates` (`layout.ts` renders a responsive branded HTML document and the plain-text alternative from one shared document model and escapes HTML output, `account.ts`, `collaboration.ts`, `index.ts`) and `src/modules/webhooks/email-webhook.routes.ts`. Templates: `account_verification`, `password_reset`, `password_changed`, `email_change_verification`, `security_notification`, `workspace_invitation`, `team_invitation`, `project_invitation`, `task_assignment`, `mention`, `meeting_invitation`. The Phase 3 template file `src/modules/auth/auth-email-templates.ts` was removed and the auth module now uses the shared renderer. Delivery state is stored in PostgreSQL in three new models: `EmailDelivery` (template, recipient, status, attempt count, next attempt, provider message id, accepted and failed timestamps, idempotency key), `EmailSuppression` (bounced and complained addresses) and `EmailWebhookEvent` (provider event id, type and payload), applied through migration `20261021120000_phase4_transactional_email`; the webhook event id is unique per provider, which migration `20261021130000_email_webhook_event_provider_scope` changes from a global to a `(provider, providerEventId)` key, so a provider change cannot reject a new event of the new provider. The delivery path is a transactional outbox: a send writes a `QUEUED` row, and a background worker claims due rows with `FOR UPDATE SKIP LOCKED`, so several instances can run it safely, and it stops with the server. BullMQ is not installed and the general queue infrastructure belongs to a later phase, so the outbox was chosen instead of adding Redis queue infrastructure now; the outbox rows stay the source of truth and can be handed to BullMQ later. Transient failures are retried with exponential backoff and jitter up to `EMAIL_MAX_ATTEMPTS`; permanent failures stop immediately; a unique idempotency key per logical send prevents a second row and a second provider send. The provider webhook is `POST /api/v1/webhooks/email`, mounted before the JSON body parser so the signature is verified over the raw body; it accepts `sha256=<hex>` and `t=<ts>,v1=<hex>` signatures, answers `200` for every verified payload including unknown events so the provider does not retry, and applies delivery, bounce and complaint events, where a bounce or complaint adds the address to the suppression list and stops further mail to it. Repeated events are applied once. Phase 3 was wired to the new service: the auth service sends branded verification, password reset, email change, email change notice and password changed emails with a per-token idempotency key, and no verification token, reset link or message body reaches the application log. Tests: `tests/email-phase4.test.ts` (12 unit tests) covers template rendering in HTML and plain text, configuration validation, transport error classification and webhook signature verification. `tests/email-phase4-db.test.ts` (8 integration tests) runs against PostgreSQL and a local SMTP capture server in `tests/helpers/smtp-server.ts`, so no provider credentials and no outbound mail are needed; it covers enqueue, claim, delivery, idempotent sends, transient retries, permanent failures, the attempt limit, suppression, webhook idempotency, webhook signature rejection and the log safety of verification tokens. The full suite is 86 tests, all passing. Provider follow-up on 2026-10-21: the deployment was switched to Brevo, so the environment file was rewritten to the names the configuration reads and the SMTP transport was verified against the live `smtp-relay.brevo.com` relay, which accepted the connection, the credentials and a real test message, so the sending address is an authorised sender. Three additions came with that change. The application builds the SMTP message id itself, with the id of the delivery row as the local part, so a provider event that carries the message id matches the delivery exactly and the recipient is only a fallback. The Brevo event names are mapped explicitly: `hard_bounce` and `blocked` are bounces that suppress the address, `soft_bounce` is temporary and does not suppress, and `spam` and `unsubscribe` are complaints that suppress. Brevo does not sign its events, so the webhook endpoint accepts a shared token in the URL (`POST /api/v1/webhooks/email/{token}`) next to the HMAC signature, and both mechanisms are compared in constant time. The configuration now reads the environment file from `src/.env` first and from `.env` in the working directory second, with the process environment always winning, and it is not read at all in the test environment so a test run can never reach a real database or a real provider. The environment file of the deployment was also repaired: a PEM certificate that was stored under `CORS_CREDENTIALS` was moved to `TLS_CERTIFICATE`, the legacy key names were renamed to the names the configuration reads, and a duration was converted to seconds. Remaining external checks: (1) the sending domain still needs its SPF, DKIM and DMARC records, and the transactional event webhook still has to be configured in the Brevo account with the URL that ends in the webhook token; (2) the invitation, task assignment, mention and meeting invitation templates are scaffolded only, because those business events are delivered by Phases 5, 8 and 15 and cannot be triggered end-to-end before then. Follow-up on 2026-10-21 after Phase 5: the workspace invitation template is exercised end-to-end by the Phase 5 integration suite, which asserts the content of the delivered mail; the team, project, task assignment and meeting invitation templates stay scaffolded until the phases that trigger them.

---

#### Phase 4.1 — Bounded email delivery retries `[x]`

**Objective:** Remove the infinite email retry path found in the Phase 4 audit and guarantee that every delivery attempt sequence ends in a terminal state.

**Deliverables:**
- One bounded retry decision shared by provider failures and unexpected worker errors
- Attempt counter persisted atomically on claim and never reset by retry scheduling
- Retry exhaustion transitions the delivery to `FAILED`
- Permanent provider failures continue to stop immediately
- Existing idempotency, suppression and webhook processing preserved
- Regression tests for transient, permanent, unexpected, exhausted, duplicate and recovery cases

**Dependencies:** Phase 4

**Verification criteria:**
- A transient failure retries with backoff and succeeds when the provider recovers
- Repeated transient failures stop at `EMAIL_MAX_ATTEMPTS`
- A permanent failure does not retry
- Unexpected transport or worker errors obey the same limit
- An exhausted row never reaches the provider again
- Concurrent workers do not claim or send the same row twice

**Blockers / Notes:** Verified on 2026-11-01. Root cause: the provider-error branch already checked `attempts < maxAttempts`, but the unexpected-error catch in `processPending` called `markRetry` unconditionally. Any thrown error — from the transport, the suppression lookup, or an outcome persistence write — therefore returned the row to `QUEUED` forever while each claim incremented `attempts`. The retry decision is now centralized in `retryOrFail`: it schedules exponential backoff with jitter only while `delivery.attempts < delivery.maxAttempts`, and otherwise writes the terminal `FAILED` state with the last error and `failedAt`. Both the provider retry path and the unexpected-error path use it. `claimDue` now excludes rows whose attempts are already exhausted, and `failExhaustedQueued` repairs any legacy `QUEUED` row at or past its limit before the claim runs, so stale rows never reach the provider again. The counter is still incremented atomically in the claim query and is not reset by a retry. Permanent failures still fail immediately. No schema migration or new environment variable was needed. The existing policy settings are `EMAIL_MAX_ATTEMPTS` (default 5, maximum 10), `EMAIL_RETRY_BASE_DELAY_MS` and `EMAIL_RETRY_MAX_DELAY_MS`. Delivery idempotency, suppression, provider webhook verification and event deduplication are unchanged. `tests/email-phase4-db.test.ts` now has 18 integration tests, adding repeated transient failures up to the limit, terminal state after exhaustion, repair of an exhausted queued row, unexpected transport failure bounded at the limit, recovery after a temporary worker failure, retry counter persistence, and concurrent workers claiming and sending only once; the Phase 4 suite passes 18/18. With the Phase 2–5 database suites enabled the full suite passes 189/189. `npm run build`, `npm run typecheck`, `npm run lint` and `npm run format:check` pass. Remaining limitation: delivery is at-least-once. If the provider accepts a message but the process fails before `markAccepted` persists that outcome, a retry can send one duplicate; provider-side idempotency would be needed for exactly-once delivery. Rows left in `SENDING` by a hard worker crash are not automatically reclaimed; this phase only bounds retries and repairs exhausted `QUEUED` rows. The separate Phase 6 database suite currently fails for pre-existing reasons unrelated to this change (its `/auth/me` fixture reads `data.id` while the endpoint returns `data.user.id`, and the repository `.env` supplies an invalid `TRUST_PROXY` value through `prisma.config.ts`); it is outside Phase 4.1.

---

#### Phase 4.2 — Recipient email privacy in logs `[x]`

**Objective:** Remove recipient email addresses from the transactional email logs without losing the delivery metadata needed to operate and troubleshoot the outbox.

**Deliverables:**
- Recipient addresses removed from the queued, console, disabled and logging-sender events
- Error text from providers, workers and persistence failures redacted before logging
- Delivery ID, template, provider, attempt, maximum attempts, retry delay and failure category retained
- Regression tests for queued, sent, provider-failure, unexpected-worker-failure and development-transport logs

**Dependencies:** Phase 4.1

**Verification criteria:**
- `email_delivery_queued` contains no recipient address or `to` field
- Structured log metadata contains no recipient address
- Provider responses and unexpected worker errors cannot reintroduce an address through their message or stack
- Operational metadata for correlation and retry diagnosis remains available
- Existing delivery, retry, suppression and webhook behaviour is unchanged

**Blockers / Notes:** Verified on 2026-11-01. The audit identified `email_delivery_queued`, which logged the `to` field. The field was removed; the event still carries the delivery ID and template so a message can be correlated through the outbox and provider message ID. The same recipient field was present in the `console` and `disabled` transports and the legacy logging sender, so those lifecycle events were corrected together while keeping delivery ID, template, subject and provider where available. A small `src/services/email/log-privacy.ts` helper now redacts email-shaped text from unexpected worker errors, retry-persistence failures and worker-pass failures, including the serialized stack; provider error codes are redacted before being logged. The raw provider error can still be stored in `EmailDelivery.lastError` for operational recovery, but it is never written to the application log by these paths. No delivery, retry, suppression, webhook or queue behaviour changed, and no schema or environment change was needed. Tests: `tests/email-phase4.test.ts` adds redaction and development-transport coverage; `tests/email-phase4-db.test.ts` adds queued/sent, provider-error and unexpected-worker-error assertions, verifies required metadata, and checks that the delivery still reaches `ACCEPTED` or `FAILED` as appropriate. The test SMTP helper now clears its envelope buffer after a simulated 451 or 550 so a pooled connection cannot leak state into the next case; this removed an existing intermittent Phase 4 failure. The Phase 4 database suite passed on three consecutive runs (21 subtests). The Phase 4 unit suite passes 18/18, the full suite with the Phase 2–5 database integrations enabled passes 194/194, and `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check` and `git diff --check` pass. The pre-existing Phase 6 database suite failures documented in Phase 4.1 are unchanged and outside this phase.

---

#### Phase 4.3 — Task assignment and mention email integration `[/]`

**Objective:** Connect the existing `task_assignment` and `mention` templates to reusable post-commit notifiers that the authoritative task and comment workflows can call after they persist an assignment or mention.

**Deliverables:**
- Reusable task-assignment notifier around the existing template and transactional outbox
- Reusable mention notifier around the existing template and transactional outbox
- Recipient validation against active workspace and project membership
- Suppression-list handling and task/comment link generation from configuration
- Stable per-event idempotency and non-fatal delivery failure handling
- PostgreSQL integration tests for context, reassignment, duplicate processing, suppression, ineligible recipients and failure isolation
- Runtime callers from the authoritative task assignment and comment/mention workflows

**Dependencies:** Phase 4.2, Phase 9, Phase 14

**Verification criteria:**
- The existing task-assignment and mention templates have real runtime callers
- Task assignment triggers the expected email to the new assignee
- A mention triggers the expected email to the mentioned workspace member
- Correct recipients and contextual data are used
- Duplicate processing and comment edits do not enqueue duplicate emails
- Existing task, comment, in-app notification and email behaviour remains intact
- Relevant tests pass

**Blockers / Notes:** Partially implemented on 2026-11-01 and extended on 2026-11-03. The repository does not yet contain the Phase 9 task service, task routes or assignment workflow, nor the Phase 14 comment creation/mention parsing workflow, so the notifier-only option was retained rather than implementing those future phases without authorization. `src/services/task-assignment-notifier.ts` turns a persisted `TaskAssignee` into the existing `task_assignment` email. `src/services/mention-email-notifier.ts` turns a persisted comment mention into the existing `mention` email. Both require an active user with workspace access and project membership (or workspace management/project ownership), enforce existing address suppression, and call the existing non-fatal `sendEmail` outbox seam. Links are built from `EMAIL_APP_URL` plus the configurable `TASK_ASSIGNMENT_LINK_PATH` and `COMMENT_MENTION_LINK_PATH`. Task idempotency uses the persisted assignment timestamp; mention idempotency uses the comment and recipient, so repeated processing or a comment edit cannot enqueue a second email. Lookup and delivery failures are caught and reported without modifying task, comment or notification data. Tests: the task-assignment integration suite has 7 PostgreSQL/outbox tests and the mention integration suite has 10, covering valid delivery, reassignment, duplicate events, edited comments, invalid/unresolved mentions, self-mentions, suppression, ineligible recipients, delivery failure and preservation of in-app notifications. After merging the current `main`, the full suite with the Phase 2–5 database integrations enabled passes 265 tests with two intentionally skipped database suites (Phase 6 and Phase 7), 267 total. `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check` and `git diff --check` pass. The completion criteria are not met because no production task-assignment or comment/mention runtime caller exists, and the schema has no notification-preference model, so suppression is the only preference mechanism currently available. Phase 4.3 stays in progress until the Phase 9 assignment workflow and Phase 14 comment/mention workflow call these notifiers after a successful commit and the end-to-end paths are verified.

---

#### Phase 4.4 — Mention, meeting and team-invitation email integration `[/]`

**Objective:** Connect the existing mention, meeting-invitation and team-invitation templates to their authoritative collaboration workflows without duplicating event parsing, invitation creation or notification state.

**Deliverables:**
- Post-commit mention email integration using existing persisted comment and workspace membership data
- Post-commit pending meeting-invitation email integration using the invitation workflow's authorized context, including workspace/project context
- Post-commit team-invitation email integration using a persisted `TEAM` invitation, its owning team and a digest-verified single-use token
- Configurable frontend paths rooted at `EMAIL_APP_URL`, including the team acceptance link
- Stable event idempotency, existing suppression enforcement and non-fatal delivery failures
- Tests for recipient selection, template context, duplicate processing, suppression, invitation status and failure isolation
- Runtime callers from the mention, meeting-invitation and team-invitation workflows

**Dependencies:** Phase 4.2, Phase 7 teams, Phase 14 messaging/mentions, Phase 17 meetings

**Verification criteria:**
- All three existing templates have runtime callers
- Mention events target the mentioned workspace member, excluding the author
- Meeting mail is sent only for a valid pending invitation and does not independently grant access
- Team mail is sent only for a valid pending `TEAM` invitation and never creates, revokes, expires or accepts an invitation
- Invitation tokens never appear in logs, outbox metadata or idempotency keys
- Repeated events do not enqueue duplicate messages
- Existing reschedule/cancellation behavior is preserved
- Relevant tests, type checks, lint and build pass

**Blockers / Notes:** Partially implemented on 2026-11-01 and extended on 2026-11-03. `src/services/collaboration-email-notifier.ts` is the post-commit integration boundary. It resolves mention recipients from active users with workspace membership, excludes the comment author, uses the persisted task/comment context, and enforces the existing suppression list. Meeting invitations are gated on `PENDING`, accept optional workspace/project context, validate the recipient and start time, and build the join link from `EMAIL_APP_URL` plus `MEETING_INVITATION_LINK_PATH`. Team invitations load a persisted `Invitation` of type `TEAM`, require a pending, unexpired invitation bound to an active workspace, team and inviter, verify `hashSecret(token)` against the stored `tokenHash`, and build the acceptance link from `EMAIL_APP_URL` plus the new `TEAM_INVITATION_LINK_PATH`. The token is used only for the link and its digest; it is never logged, stored in outbox metadata or embedded in the idempotency key. Team idempotency uses the invitation and the persisted token digest, so re-processing the same token collapses into one outbox row while a resend with a new token creates one new mail. A team invitation lookup, status, token or delivery failure returns a result without modifying the invitation, so acceptance validation, expiration and single-use semantics stay in the owning workflow. The notifier never creates, revokes, expires or accepts an invitation.

The repository still has no meeting schema, meeting routes, meeting participant management or meeting invitation workflow, no team invitation creation/acceptance workflow, and no comment creation/mention parsing workflow. The Phase 7 team service only adds existing workspace members, and `Invitation.teamId` / `Invitation.projectId` remain schema placeholders without relations. Therefore none of the three notifiers has a production runtime caller yet, and the unit and PostgreSQL/outbox suites exercise the boundaries directly. Notification preferences are still not modelled; the existing address suppression list is the only email preference control. The meeting reschedule/cancellation requirement also cannot be verified because no meeting lifecycle exists; the notifier remains invitation-creation only and should not be treated as implementing updates or cancellations. Phase 4.4 remains in progress pending the authoritative Phase 7, Phase 14 and Phase 17 workflows and end-to-end tests.

---

#### Phase 4.5 — Project invitation email integration and final email audit `[/]`

**Objective:** Connect the existing project-invitation template to the authoritative project invitation workflow, then complete the Phase 4 email subsystem audit.

**Deliverables:**
- Post-commit project invitation email integration using a persisted `PROJECT` invitation, its project and a digest-verified single-use token
- Project name, inviter, workspace context, expiration and a configurable acceptance link
- Stable idempotency, existing suppression enforcement and non-fatal delivery failures
- A final audit of delivery, retries, terminal failures, deduplication, logging privacy, all five collaboration integrations, and webhook verification/idempotency/suppression/bounce/complaint handling
- Tests for delivery, duplicates, resend, expiration, wrong type, missing or archived project, invalid recipient, inactive inviter, token mismatch, suppression and failure isolation
- Documentation of the remaining runtime-caller dependency

**Dependencies:** Phases 4.1–4.4 and Phase 8 projects.

**Verification criteria:**
- Project mail includes the project name, inviter, workspace context, expiration and the configured acceptance link
- Only a pending, unexpired `PROJECT` invitation for a live project in an active workspace is emailed
- Invitation tokens never appear in logs, outbox metadata or idempotency keys
- Repeated processing does not enqueue duplicate messages
- Sending never creates, accepts, revokes or expires an invitation
- Existing delivery, retry, privacy, webhook, suppression, bounce and complaint tests pass
- Typecheck, lint, format and build pass

**Blockers / Notes:** Implemented on 2026-11-03. `notifyProjectInvitation` in `src/services/collaboration-email-notifier.ts` loads a persisted `Invitation` of type `PROJECT`, requires a pending, unexpired invitation in an active workspace with an active inviter, resolves the live (non-archived) project by `projectId` and `workspaceId`, verifies `hashSecret(token)` against the stored `tokenHash`, and builds the acceptance link from `EMAIL_APP_URL` plus the new `PROJECT_INVITATION_LINK_PATH`. The template now renders the project name, workspace name, inviter, expiry and role when supplied. The raw token is used only for the link and its digest: it is never logged, stored in outbox metadata or embedded in the idempotency key. Idempotency uses the invitation and token digest, so re-processing one token collapses into one outbox row while a resend with a new token creates one new mail. A lookup, status, project, token or delivery failure returns a result without modifying the invitation, so acceptance validation, expiration and single-use semantics stay in the owning workflow. The notifier never creates, revokes, expires or accepts an invitation.

The repository still has no project invitation creation/acceptance workflow. The Phase 8 project service adds an existing workspace member and sends an in-app notification; it does not issue project invitation tokens, and `Invitation.projectId` has no Prisma relation. The notifier is therefore the tested integration boundary that the Phase 8 workflow must call after committing an invitation, and Phase 4.5 remains in progress until that caller and an end-to-end acceptance path exist. The final audit confirmed the retry bound, terminal `FAILED` state, deduplication, log redaction, webhook verification/idempotency, suppression and bounce/complaint handling. Verification on 2026-11-03: the Phase 4 delivery suite passes 20/20, the collaboration suite 17/17 (including the project invitation cases), task assignment 7/7 and the focused unit suites 48/48; the database-enabled full suite (Phases 3, 4 and 5) passes 284 of 286 tests with 2 skipped and 0 failures; typecheck, lint, format check and build pass. All five collaboration handlers exist, but only the notifier boundaries are exercised; task assignment, mention, meeting, team and project workflows are still absent. Notification preferences are not modelled; the existing address suppression list is the only email preference control.

---

#### Phase 4.6 — Email integration, security, and regression verification `[/]`

**Objective:** Verify the Phase 4 email delivery and security protections, connect all collaboration templates to real workflows, and keep the phase open while required workflows are missing.

**Deliverables:**
- Regression verification for bounded retries, recipient privacy, webhook verification/idempotency, suppression, bounces and complaints
- Safe request and error logging for invitation and webhook URL tokens
- Real workflow callers for task assignment, mentions, meeting invitations, team invitations and project invitations
- Accurate Phase 4 status and remaining dependency documentation

**Dependencies:** Phases 4.1–4.5 and the owning task, messaging, meeting, team and project workflows.

**Verification criteria:**
- Retry counters persist, failures terminate at the configured limit, and duplicate processing stays bounded
- Recipient addresses, invitation tokens and webhook URL tokens are not exposed in logs
- Existing webhook, suppression, bounce and complaint protections pass regression tests
- All five collaboration templates have callers from their authoritative application workflows
- Typecheck, lint, build, and relevant unit and database tests pass

**Blockers / Notes:** Partially verified on 2026-11-01. The retry, privacy, webhook, suppression, bounce and complaint paths pass their existing Phase 4 tests. The audit fixed request/error log exposure of invitation and webhook URL tokens by redacting those paths and sanitized error details; an obsolete `console.log(req.url)` middleware registration was removed from `src/app.ts`. Focused tests pass 27/27; the Phase 4 PostgreSQL/SMTP suite passes 20/20; task-assignment outbox integration passes 7/7; workspace invitation HTTP/database integration passes 19/19; the full suite passes 108 with 0 failures and 1 skipped suite; typecheck, lint, build and format check pass. However, none of the five collaboration email handlers has a production workflow caller: the task-assignment notifier is only exercised by tests and the Phase 9 task workflow is absent; mention and meeting handlers are only exercised by tests and their Phase 14 / Phase 17 workflows are absent; the team and project invitation handlers are only exercised by tests and their Phase 7 / Phase 8 invitation workflows are absent. Workspace invitations continue to use only the workspace template. Phase 4 and Phase 4.6 remain in progress; do not mark them complete until the five real workflow integrations exist and are verified. Notification preference records are not implemented; existing email suppression is honored. The 2026-11-03 Phase 4.5 audit re-ran the delivery, retry, privacy, webhook, suppression and bounce/complaint suites and added the project invitation handler and its unit and PostgreSQL/outbox coverage; the audit found no regression in the webhook implementation, which was left unchanged.

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
- At finalization, personal-only relational data is removed while a neutral user tombstone remains to preserve foreign keys and shared historical attribution. Authentication sessions and tokens are revoked when deletion is scheduled.
- Company, Institution, and other shared workspaces remain. A deleting owner may arrange an explicitly accepted ownership transfer during the recovery period; billing responsibility requires separate acceptance. Any owned workspace without an accepted successor is suspended at finalization and remains suspended until an authorized platform administrator assigns a new owner.
- Shared projects, tasks, comments, and collaboration records remain with deleted-author attribution changed to `Deleted user`; access is revoked through the deactivated tombstone. Shared workspace and collaboration attachments remain. Purely personal attachments are deleted only after the 30-day recovery period; failures leave finalization retryable and preserve metadata until storage deletion succeeds.
- The private storage adapter is integrated with bounded deletion classification based on personal workspace ownership and sharing/reference relationships. Each result is audited; ambiguous or shared files are retained.

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
| Invitation decline/rejection | COMPLETED | Authenticated, recipient-bound `POST /invitations/{token}/decline` transitions pending invitations to `DECLINED`, records the audit event, and prevents reuse. The Phase 5 PostgreSQL suite now covers this lifecycle. |
| Automatically provision a personal workspace after email verification | COMPLETED | Verification now transactionally creates or adopts one private `isPersonal` workspace and OWNER membership; migration backfills existing active users. |
| Personal workspace archive/delete safeguards | COMPLETED | The ordinary workspace archive/delete routes reject personal workspaces; account deletion owns their lifecycle. |
| Account deletion request, confirmation, and 30-day schedule | COMPLETED | Password and email confirmation, status and timestamps, token/session revocation, rate limiting, response, and transactional email are implemented. |
| Recovery during the grace period | COMPLETED | Existing password-verified reactivation cancels the schedule without restoring old sessions. |
| Permanent deletion of personal relational data and shared-data protection | IN PROGRESS | Idempotent locked worker removes personal-only relational data and personal-only files after storage deletion succeeds, anonymizes retained attribution, and preserves shared workspace/collaboration records and files. Storage failures are audited and retryable. |
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

### Backend audit update — 2026-11-03

**Status: IN PROGRESS.** Audit found and corrected invitation lifecycle races and missing archived-workspace guards. The rest of the Phase 5 service/routes were present on inspection; the Phase 5 PostgreSQL integration suites could not be run because no test `DATABASE_URL` is configured and the local PostgreSQL instance has no role for the current OS account. Do not treat code inspection or the unit suite as database-backed completion evidence.

| Requirement area | Audit result | Evidence / remaining verification |
|---|---|---|
| Workspace membership, role restrictions, isolation, and ownership transfer | Existing implementation found; no change required | Central workspace policies and service transactions are in place. Database-backed route and cross-workspace tests are present but were skipped without the guarded test database. |
| Invitation creation, recipient binding, acceptance/rejection, 48-hour expiry, revoke/resend, single use | Existing implementation found; lifecycle race guards strengthened | Invitation state and token digest are conditionally checked; targeted PostgreSQL regressions were added but are not yet executed. |
| Duplicate invitation prevention | Fixed race found during audit | Creation now serializes on the workspace row, expires stale pending records before checking, and maps uniqueness conflicts to the established 409 response. Concurrent duplicate integration test added, not yet run. |
| Archived/deleted workspace invitation behavior | Missing behavior fixed during audit | Archive transaction expires already-due pending invites and revokes the rest; creation, resend, acceptance, preview, decline, and switching now reject unavailable workspaces/states. Regression test added, not yet run. |
| Join discovery/codes, approval/rejection/withdrawal, 7-day expiry, applicant privacy and email-domain handling | Existing implementation found; no change required | Implemented in `join-request.service.ts`; dedicated unit and PostgreSQL test suites exist. PostgreSQL suite was skipped in this run. |
| Membership removal, task reassignment, preservation of personal identity/assets and audit history | Existing implementation found; no change required | `phase5-workspaces-db.test.ts` covers member removal, workspace access revocation, audit history and owner removal protection. `phase5-task-reassignment-db.test.ts` and `phase5-join-requests-db.test.ts` cover reassignment-required and successful transactional reassignment. These suites still require execution against the verified disposable database. |
| Frontend API contract compatibility | Static contract review passed | Frontend workspace service paths/payloads align with registered workspace routes and response envelope. No live authenticated backend flow was exercised. Invitation UI is a separate frontend roadmap phase. |

**Changes:** `src/modules/workspaces/invitation.service.ts`, `src/modules/workspaces/workspace.service.ts`, and `tests/phase5-workspaces-db.test.ts`; no schema or migration change and no endpoint or payload change. `docs/API.md` and `docs/openapi.yaml` describe the archive and invitation lifecycle behavior.

**Validation:** Full backend `npm test` passed 197 tests with 0 failures; guarded PostgreSQL suites, including Phase 5, were skipped because no test database URL/role is available. Backend typecheck, lint, and production build passed. `npm run format:check` remains failing on the unrelated pre-existing `src/modules/auth/account-deletion.service.ts`; changed TypeScript files pass formatting. Frontend focused workspace/provider/page tests passed 16/16 and frontend `npx tsc --noEmit` passed. Live frontend/backend verification remains unperformed.

**Verification continuation — 2026-11-03:** The required database preflight could not proceed: `RUN_PHASE5_DB_TESTS=true` was not available to the process and `TEST_DATABASE_URL` was unset. Per the safety gate, no connection was attempted, so database identity is unverified, no migration was applied, and none of the three requested PostgreSQL suites was run. The test helper can fall back to `DATABASE_URL`; that fallback was not used. Non-database checks run in this continuation: `npm run lint`, `npm run typecheck`, and `npm run build` all passed. The build emitted Prisma's existing deprecation warning for `package.json#prisma`.

**Remaining before completion:** provide the required test-only environment variables and verify the exact disposable database identity before applying migrations; then run `phase5-workspaces-db.test.ts`, `phase5-join-requests-db.test.ts`, and `phase5-task-reassignment-db.test.ts` (including concurrency/archive regressions). Phase 5 remains **IN PROGRESS** until database-backed acceptance tests pass.

---

#### Phase 7 — Teams and organizational structure `[/]`

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

**Blockers / Notes:** Verified on 2026-10-23. The team module is implemented at `src/modules/teams/` with `team.schemas.ts` (Zod validation for create, update, member add/update, lead change), `team.types.ts` (TeamSummary, TeamMemberSummary, TeamLeadSummary response shapes) and `team.service.ts` (full CRUD: create, list, get, update, archive, delete; membership: addMember, updateMemberRole, removeMember; lead management: changeLead). The HTTP layer lives in `team.routes.ts` and is mounted at `/api/v1/workspaces/:workspaceId/teams` via `src/routes/index.ts`. Authorization is enforced through the Phase 6 centralized module: workspace OWNER and PROJECT_MANAGER have full team capabilities; TEAM_LEAD may update and manage members of their own team; workspace MEMBER may list and view teams; workspace COLLABORATOR and VIEWER have no default access. The role that a client sends in a request body is never trusted. Every create, update, archive, delete, membership add/update/remove, and lead change is written to the `AuditLog` table inside the same transaction. Notifications are sent to affected members on add, role change, removal and lead assignment using `createNotification` from `src/services/notifications`. `TeamAuditAction` constants (`team.created`, `team.updated`, `team.archived`, `team.deleted`, `team.member_added`, `team.member_role_changed`, `team.member_removed`, `team.lead_changed`) were added to `src/services/audit.ts`. Team creation automatically adds the creator as a team member (TEAM_LEAD for OWNER/PM, MEMBER otherwise) and optionally adds a specified lead. Deleting a team is a soft-delete (`deletedAt` set); archived teams are filtered from the default list but visible with `?includeArchived=true`. Tests: `tests/phase7-teams.test.ts` (35 unit tests covering capability matrices, schema validation, audit constants) and `tests/phase7-teams-db.test.ts` (integration tests covering full lifecycle, member management, lead management, authorization enforcement, audit trail, and notifications). Verification: `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check` all pass; `npm test` passes 136/137 (1 skipped — Phase 7 DB tests requiring `RUN_PHASE7_DB_TESTS=true`). Committed in two chunks on `feature/phase-7-teams` (90ee444 and 8245c69), pushed to `origin/feature/phase-7-teams`.

**Audit update — 2026-11-03:** The team HTTP lifecycle passed 38/38 PostgreSQL tests after fixing the route dependency wiring, explicit organization-owner/admin team capabilities, current `/auth/me` fixture shape, and test cleanup. The full Phase 7 acceptance criteria below remain incomplete: Company/Institution profile and settings APIs, institution groups, and team integrations with project/channel workflows are absent. Keep Phase 7 in progress and do not advance to Phase 8 until these requirements are implemented and verified.

**Progress update — 2026-11-04:** Added separate workspace-scoped `CompanyProfile` and `InstitutionProfile` records, provisioned them in the workspace-creation transaction, and backfilled existing company/institution workspaces in migration `20261104120000_phase7_organization_profiles_groups`. Added organization-owner/admin profile update routes and separate institution-group lifecycle/member routes. Institution groups are independent from departments; members only see groups they belong to, while owners/admins can manage groups. Group writes, membership changes, audit entries, and notifications use the same database transaction. Workspace member removal and account deletion clean up group membership and lead references. Updated `docs/API.md` and `docs/openapi.yaml` (71 paths). Schema validation/client generation, TypeScript, build, focused organization schema tests (3/3), the full unit suite (222 passed, 0 failed, 2 skipped), and the Phase 7 PostgreSQL HTTP suite (40/40) pass. All migrations, including the new migration, deployed to a disposable PostgreSQL 16 container. Phase 7 remains **IN PROGRESS**. Outstanding requirements include organization preferences, logo upload/reference management, team/department settings and project integration verification, and channel access integration. The project/channel pieces depend on the project and messaging modules, which are not exposed yet; do not start their roadmap phases early.

**Notification preference decision and implementation — 2026-11-04:** Notification preferences belong to Phase 7. Members can independently enable or mute each existing in-app `NotificationType` within each workspace; all are enabled by default. The shared notification writer honors these preferences, while email and message unread state remain independent. Preferences are persisted against the active workspace membership and cascade on membership removal. API operations and migration `20261104130000_phase7_notification_preferences` are documented in `docs/API.md`, `docs/openapi.yaml`, and `docs/migration-recovery.md`. The four organization schema tests pass; the Phase 7 PostgreSQL HTTP suite passes 40/40 with default, workspace-isolation, authentication, access-control, and notification-suppression coverage. Prisma validation/client generation, typecheck, build, targeted ESLint, the standard suite (223 passed, 0 failed, 2 skipped), OpenAPI reference validation, migration drift verification, and the migration recovery script pass. Audit also found and corrected a schema mismatch: the prior institution-group migration contains `deletedAt`, which was absent from the Prisma model; the schema now matches the migration, with no additional migration required. Phase 7 remains **IN PROGRESS**.

**Department settings progress — 2026-11-05:** Added institution department rename via `PATCH /workspaces/{workspaceId}/departments/{departmentId}`. Active department heads and institution owners/admins may rename a department; access is scoped to the institution workspace. Duplicate names return a conflict, and the update plus audit record is transactional. Route, API documentation, OpenAPI, and authorization/IDOR/duplicate/audit regression coverage are added. The five organization schema tests pass and the Phase 7 PostgreSQL HTTP suite passes 40/40, including owner rename, unauthorized-member denial, cross-workspace concealment, duplicate-name conflict, and audit persistence. The standard suite passes 224/224 with 2 database-gated skips; typecheck, build, targeted ESLint/formatting, OpenAPI validation, and `git diff --check` pass. Repository-wide lint still fails on unused `data` in unrelated `tests/billing-service.test.ts:202`; repository-wide format check still reports 12 unrelated files. Phase 7 remains **IN PROGRESS**; department deletion and other unspecified settings are not implemented.

**Team-project access progress — 2026-11-05:** `requireProjectAccess` now grants base project-member capabilities to active members of an active team linked to that project, with a same-workspace lookup. Explicit project memberships remain valid for separately invited workspace members. Team membership does not grant project-management capabilities, and organization-role ceilings remain enforced. Added unit regression coverage for team access, non-member denial, explicit project membership, and cross-workspace team references, plus a Phase 7 PostgreSQL integration case. Unit tests and TypeScript checks pass; PostgreSQL integration remains unverified because no disposable test database credentials are configured. No HTTP routes or response contracts changed, so `docs/API.md` and `docs/openapi.yaml` required no change in this follow-up. Phase 7 remains **IN PROGRESS**. Logo upload/storage still requires the private object-storage adapter; team communication access still depends on a channel module, which is not present. The uncommitted account-deletion changes in the working tree conflict with the approved 30-day recovery policy earlier in this roadmap and are not considered verified Phase 7 work.

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

### Approved commercial and membership rules

These approved prices and rules are recorded in the Phase 3 product decision log. `src/modules/billing/` now contains server-owned pricing, billing routes/service, persistence models, Paystack adapter, transaction verification, signed webhook handling, encrypted provider tokens, and lifecycle calculations. This work is in progress; merchant test credentials and test-mode payment verification are not configured.

| Plan | Monthly | Annual | Included members | Extra active member |
|---|---:|---:|---:|---:|
| Pro | $10/month | $50/year | 15 | $0.50/member per selected billing period |
| Business | $15/month | $70/year | 25 | $1/member per selected billing period |

- The workspace owner counts once and consumes an included seat.
- Only active memberships with active accounts count. Pending invitations, suspended, removed, and deactivated memberships do not count. Admin roles do not have a separate billing exclusion.
- Additional members use the base subscription cadence, including annual billing on annual plans.
- Upgrades and seat increases apply immediately only after server-verified successful payment and are prorated. Downgrades, seat reductions, and cancellation take effect at renewal/period end; paid access remains through the already-paid period. Seat conflicts never cause automatic member or data deletion.
- No automatic refunds. Refund requests are handled manually under the business's approved policy and applicable law.
- Failed-payment policy is deferred; retry behavior, grace periods, notifications, access timing, and additional-seat treatment remain undecided. Do not invent failure timelines or grant paid access without verified payment.

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

### Current implementation status — in progress

- `src/modules/billing/` includes routes, service, Paystack HTTP client, webhook signature verification, provider token encryption, subscription/checkout/payment/event persistence, active-seat lookup, proration, and lifecycle policy.
- Migration `prisma/migrations/20261103160000_phase3_paystack_billing/` is authored but has not been applied to a verified disposable database.
- Automated policy and Paystack adapter tests are being added. They do not establish live merchant USD support or actual Paystack test-mode behavior.
- Membership activation is not yet transactionally gated by committed paid seats; this remains a release blocker. Provider/database reconciliation on partial failures also requires validation.
- USD merchant enablement, legal review, and Paystack Dashboard/test-mode setup remain external dependencies. Requirements and setup are in the frontend repository's `docs/SUBSCRIPTION_BILLING_BACKEND_REQUIREMENTS.md`.

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

## Project Decisions and Blockers

### Current Phase

**Current phase:** Phase 7 remains in progress. Team lifecycle, organization profiles, supported workspace and notification preferences, institution groups, department settings, private logo lifecycle, and project/team/department access integration are implemented in the current working tree. Channel integration is blocked because this backend has no Channel model, route, or messaging module; implementing one here would start the later messaging phase. Phase 8 must not begin until the Channel dependency is implemented and verified. The Phase 3/7 PostgreSQL lifecycle suites have now been verified against a disposable PostgreSQL 16 database. Phase 4.6 also remains in progress; the roadmap does not define how its email workflow dependencies are sequenced against Phase 7/8, so treat this as a recorded sequencing ambiguity rather than skipping the dependency.

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

| Phase | Date | Result |
|---|---|---|
| 1 — Foundation and infrastructure | 2026-10-21 | `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check` and the unit suite pass. |
| 2 — Core domain schema | 2026-10-21 | Migrations apply to PostgreSQL 16, the constraint and index checks pass, the `npm test` suite passes with the database integration tests enabled. |
| 3 — Authentication and account lifecycle | 2026-10-21 | 63 tests pass with the database integration tests enabled, covering the full account lifecycle, the session rotation, the CSRF enforcement, the rate limits and the audit trail. |
| 4 — Transactional email | 2026-10-21 | 86 tests pass. The live provider was verified separately: the SMTP relay accepted the connection, the credentials and a real test message. The sending domain DNS and the provider webhook still have to be configured in the provider account. |
| 4.1 — Bounded email delivery retries | 2026-11-01 | Infinite retries removed. The unexpected-error path now uses the same `EMAIL_MAX_ATTEMPTS` limit as provider failures, exhausted rows are moved to `FAILED`, and legacy exhausted queued rows are repaired before claiming. The Phase 4 suite passes 18/18 with PostgreSQL and the SMTP capture server; the full Phase 2–5 database-enabled suite passes 189/189. `npm run build`, `npm run typecheck`, `npm run lint` and `npm run format:check` pass. |
| 4.2 — Recipient email privacy in logs | 2026-11-01 | Removed recipient addresses from the queued event and the console, disabled and logging-sender lifecycle events. Email-shaped error text is redacted before logging, including unexpected worker, persistence and worker-pass failures. Delivery ID, template, provider, attempt and failure category remain. New unit and PostgreSQL integration tests pass, the Phase 4 database suite passed three consecutive runs, the full Phase 2–5 database-enabled suite passes 194/194, and build, typecheck, lint and format check pass. |
| 4.3 — Task assignment email integration | 2026-11-01 | Partial. The reusable task-assignment notifier and 7 PostgreSQL/outbox integration tests pass, including reassignment, duplicate events, suppression, ineligible recipients and delivery failure isolation. No runtime caller exists because the Phase 9 task workflow is not implemented, so the phase remains in progress. |
| 4.4 — Mention and meeting-invitation email integration | 2026-11-01 | Partial. Added post-commit notifier boundaries and configurable application links for both existing templates. Four focused unit tests pass; typecheck, lint and build pass. No comment mention or meeting workflow exists to supply authoritative runtime callers; the phase remains in progress pending Phases 14 and 17. |
| 4.5 — Team and project invitation email integration | 2026-11-01 | Deferred / not started. The current invitation workflow is workspace-only. Team and project invitation creation and acceptance depend on Phases 7 and 8; optional schema fields do not provide those workflows. Phase 4.6 must track these outstanding integrations or their dependencies when that phase is defined. |
| 4.6 — Email integration, security, and regression verification | 2026-11-01 | Partial. Retry, recipient privacy, token-path logging, webhook verification/idempotency, suppression and bounce/complaint checks pass. The full suite is 108 passed, 1 skipped; dedicated Phase 4, task assignment, and workspace-invitation database suites pass. All five collaboration templates still lack production workflow callers, so Phase 4 and 4.6 remain in progress. |
| 5 — Workspaces, memberships and invitations | 2026-10-22 | 125 tests pass with every database integration suite enabled, covering the workspace lifecycle, the membership rules, the invitation flow and the audit trail. `npm run build`, `npm run typecheck`, `npm run lint` and `npm run format:check` pass. A timing-sensitive flaky test in the Phase 4 retry suite was fixed (50 ms sleep added between consecutive `processPending` calls). Verified across 4 consecutive runs with 0 failures. |
| 6 — Roles, permissions and authorization | 2026-10-23 | 97 tests pass (1 skipped — DB integration tests requiring `RUN_PHASE6_DB_TESTS=true`). `npm run build`, `npm run typecheck`, `npm run lint` and `npm run format:check` all pass. 44 new unit tests cover the full workspace, project and team capability matrices. DB integration tests cover cross-workspace access denial, role enforcement, owner-removal protection and ownership transfer with audit log. |
| 7 — Teams and organizational structure | 2026-10-23 | 136 tests pass (1 skipped — DB integration tests requiring `RUN_PHASE7_DB_TESTS=true`). `npm run build`, `npm run typecheck`, `npm run lint` and `npm run format:check` all pass. 35 new unit tests cover team capability matrices, all schema validators and audit constants. DB integration tests cover the full team lifecycle, member management, lead assignment, authorization enforcement, audit trail and notifications. |

---

_Last updated: 2026-11-03. Phases 1 to 7 are implemented and verified, together with corrective Phases 3.1–3.5, 4.1 and 4.2. Phases 4.3, 4.4, 4.5 and 4.6 are partially implemented: the email notifier boundaries are ready, but their runtime callers wait for the owning task, messaging, meeting, team and project workflows. The document also describes the planned state of the later phases._

## Phase 3 account deletion remediation — 2026-11-05

**SUPERSEDED by the Phase 3 account deletion policy correction below:** This historical note described ownership-transfer and collaborator-removal prerequisites and an unintegrated storage adapter. Current policy permits scheduling deletion with untransferred owned workspaces suspended; ownership transfer is optional and accepted by the recipient, billing responsibility requires separate acceptance, and purely personal attachments are deleted after the recovery period while shared attachments remain. The 30-day recovery period and immediate session revocation remain current.


**Phase 7 audit update — 2026-11-05:** Organization profile/settings and supported workspace/in-app notification preferences were already present. Added private S3-compatible company/institution logo upload, read and deletion with authorization, content-signature validation, bounded 2 MB size, SigV4 requests, timeout, and audit records. Added team-to-department management, transactional propagation of linked project department relationships, and an API operation to associate existing projects with same-workspace teams/departments. Project access now follows active team membership; department-only projects inherit access from their department members, while a team relationship narrows access to team members. Existing membership changes are checked dynamically, so removing membership revokes inherited access. Channel integration remains blocked because no channel subsystem exists. Account deletion was aligned with the approved 30-day recovery period; scheduling retains ownership and subscription responsibility, suspends owned workspaces, and records optional recipient ownership transfer and separate billing acceptance. Sessions are revoked immediately; the recovery endpoint clears the schedule only before its deadline. Verification is recorded in the session report; database-gated integration remains unverified where the isolated test database is unavailable. Phase 7 remains **IN PROGRESS**, and Phase 8 was not started.

**Phase 7 remaining-blocker remediation — 2026-11-05 (superseded):** This earlier implementation used a read-only `HEAD` existence check and retained personal attachment bytes and metadata. That behavior was replaced by the approved personal-file deletion policy in the completion update below. Its reported database test counts describe the earlier code and are not evidence for the current implementation.

## Phase 3 account deletion policy correction — 2026-11-05

The approved product decision is a 30-day scheduled deletion and recovery period; the earlier immediate-deletion addenda are superseded. The request revokes sessions and authentication tokens immediately, but finalizes only at the exact server-calculated deadline. Recovery is identity-verified and competes transactionally with finalization. Owned workspaces and collaboration records are retained; untransferred owned workspaces are suspended. Recipient ownership acceptance and separate billing acceptance are required. Scheduled subscription cancellation is reversible before the deadline, while outstanding invoices and financial records are retained. The backend worker now anonymizes account identity while preserving user tombstones and shared records. Additive schema migration tracks deletion suspension, transfer acceptance and billing owner. Frontend notices and legal drafts now state the approved product behavior and distinguish pending legal review.

**Phase 3 account deletion verification status — 2026-11-05:** The earlier implementation note below is superseded on personal-file handling by the approved policy correction and current completion update. The cancellation worker rechecks the current workspace owner and deadline before provider cancellation; platform administrator owner assignment is guarded by a database-provisioned `isPlatformAdmin` flag. The disposable PostgreSQL lifecycle suite passes 71/71. Paystack sandbox behavior, live email delivery, and legal/accounting retention periods remain external verification/review dependencies.

**Phase 7 account lifecycle verification update — 2026-11-05 (superseded):** This earlier note predates the disposable PostgreSQL run and the privacy-request implementation recorded below. Its observations about legal review and absent frontend policy drafts remain relevant; its test status is historical.

**Personal attachment policy correction — 2026-11-05:** The current approved decision is to delete purely personal attachments after the 30-day recovery period, retain shared workspace and collaboration attachments, and preserve personal attachments when an account is recovered. This supersedes the earlier read-only retention note above.

**Phase 7 completion and frontend dependency update — 2026-11-05:** Implemented the approved storage classification and idempotent deletion of personal-only attachment objects with per-file audit outcomes; shared workspace and collaboration references are preserved. Added incoming ownership-transfer listing/rejection and privacy-request submission, owner retrieval, platform-admin review/decision, and task-comment redaction APIs. Corrected the ownership-transfer initiation OpenAPI response and malformed flow descriptions. Against a disposable PostgreSQL 16 database, the Phase 3 lifecycle/privacy suite passes 71/71, including concurrent redaction conflict handling, and the Phase 7 team/organization/project suite passes 43/43. The regular `npm test` suite passes 243 tests with 2 database-gated skips; typecheck, ESLint, production build, `git diff --check`, and OpenAPI lint (0 errors, 27 existing style warnings) pass. `npm run format:check` reports 9 files, including pre-existing modified files; the three newly added privacy service files were formatted. Invoice listing remains blocked because no invoice model or safe workspace/payer authorization mapping exists; payment records are not invoices. The backend has no messaging/channel records for message redaction, and the frontend remains a separate repository. Phase 7 remains **IN PROGRESS**; Phase 8 was not started. Legal/accounting must confirm applicable retention periods, and product/billing owners must define invoice issuance, payer access and workspace mapping before that API can be safely implemented.
