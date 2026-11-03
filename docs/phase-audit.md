# Nexus Backend — Phase Audit and Remediation Record

This is an evidence-based audit record for the existing backend. It is kept
separate from `PHASES.md` because that file carries uncommitted user edits in
this working tree; nothing here replaces the roadmap or its phase numbering.

Audit date: 2026-11-03
Branch: `feature/phase-5.1-pm-role-escalation`
Baseline commit: `1baf3b0`

---

## 1. Repository assessment

| Area | Actual implementation |
| --- | --- |
| Runtime | Node.js >= 20, TypeScript (strict) |
| HTTP | Express 5 |
| Database | PostgreSQL via Prisma 6 (`prisma/schema.prisma`) |
| Cache / transient state | Redis (`src/db/redis.ts`), not used as durable storage |
| Real time | Not present in this branch |
| Email | Nodemailer-based transactional email service with bounded retries and webhook |
| File storage | Not present in this branch |
| Tests | `node:test` + `tsx`, DB-gated integration suites |
| API spec | `docs/openapi.yaml` (OpenAPI 3.1) |
| Branding documentation | No branding file found in the repository |

Conventions observed:

- Controllers/routes stay thin; business logic lives in module services.
- Authorization policies live in `src/modules/authorization` and are re-exported
  by the workspaces module for Phase 5 compatibility.
- Every workspace-scoped query is resolved through the caller's membership row;
  request bodies never supply roles or workspace ownership.
- Errors use `AppError` with a stable machine-readable `code`.

Technical debt found but intentionally not changed:

- `package.json` still lists `sequelize` and `sequelize-cli`; nothing imports them.
- Legacy JavaScript middleware/validator files (`src/middleware/*.js`,
  `src/validators/*.js`) are dead code.
- The local `.env` does not set `WORKSPACE_INVITATION_TTL_SECONDS`, so the code
  default applies; no `.env` file was modified.

---

## 2. Phase audit results

The active roadmap numbers workspace management as Phase 4 and membership/onboarding as Phase 5. Statuses below reflect this feature branch and database-backed verification against disposable PostgreSQL databases. Phases 7 and 8 were not merged into this branch and are not counted as implemented.

| Phase | Verified status | Evidence / action |
| --- | --- | --- |
| 0 — Repository audit | COMPLETED | Repository structure, dependencies, documentation, and implementation gaps recorded here. |
| 1 — Core infrastructure | COMPLETED | Health, configuration, error contract, request logging, typecheck, lint, and build pass. |
| 2 — Database architecture | COMPLETED | Prisma migrations deploy to an isolated test database; schema and migration checks pass. |
| 3 — Authentication and identity | COMPLETED | Database-backed account lifecycle tests pass, including rotation, recovery, deactivation, and deletion. |
| 4 — Workspace management | BLOCKED | Core workspace CRUD, type validation, isolation, membership lifecycle, archive/restore, and migrations are verified. Automatic personal-workspace creation, workspace-specific Company/Institution setup, and frontend API integration are incomplete. Personal provisioning also needs an account-deletion retention decision. |
| 5 — Membership and onboarding | BLOCKED | Invitations, discovery, join codes, join requests, expiration, decisions, withdrawal, suspension/restoration, and the authorized reassignment/domain-policy regressions pass API/database tests. Phase 4 is not closed and remains a phase-order blocker. |
| 6 — Roles and access control | BLOCKED | Current `WorkspaceRole` values differ from the Company/Institution role taxonomy in the product requirements. Existing policy and ownership tests pass; a compatible mapping needs product agreement before persisted values change. |
| 7–32 | NOT STARTED | No implementation from these phases is included in this branch. |

### Cross-cutting findings (not fixed here)

1. **Role taxonomy mismatch.** `README.md` defines Company roles
   Owner/Admin/Team Lead/Member/Guest, while the database and API use
   OWNER/PROJECT_MANAGER/MEMBER/COLLABORATOR/VIEWER. Renaming roles is a
   breaking product and data decision and was not done unilaterally.
2. **Project visibility levels.** The schema has `PRIVATE` and `WORKSPACE`; project requirements describe organisation-wide, department/team-only, and private/invitation-only visibility. Resolve this in the project phase before changing the model.
3. **Phase 5 reassignment and domain policy.** Member removal now requires an explicitly selected active workspace member when open task assignments exist; the replacement must have access to each affected project. Transfers, audit records, notifications, and membership removal use one transaction. Email-domain matching records metadata only and never grants workspace membership or a role. Account email verification and invitation acceptance remain the existing identity and membership flows; no domain restriction was added.

---

## 3. Defects corrected in this task

### 3.1 Invitation resend role escalation

`create` checked `assertMayAssignRole`, but `resend` did not. A project manager
could not create a `PROJECT_MANAGER` invitation, yet could resend one that the
owner had created, re-issuing owner-only privilege to an address the owner had
invited. `resend` now applies the same role-assignment guard before issuing a
new token.

- Code: `src/modules/workspaces/invitation.service.ts`
- Regression test: `tests/phase5-workspaces-db.test.ts`

### 3.2 Invitation lifetime

The default `WORKSPACE_INVITATION_TTL_SECONDS` was 7 days. The product rule is
48 hours. The default is now `172800`, and `.env.example` documents it.

- Code: `src/config/env.ts`
- Config: `.env.example`
- Regression test: `tests/env.test.ts`

### 3.3 Acceptance of non-pending invitations

`accept` rejected `ACCEPTED` and `REVOKED` explicitly and expired by timestamp,
but a row already marked `EXPIRED` with a future timestamp would fall through
to membership creation (the transaction later rolled back, but the attempt was
unnecessary and the state handling was implicit). `accept` now:

- rejects `EXPIRED` explicitly, without rewriting the row;
- rejects any non-`PENDING` status before resolving the user or creating a
  membership;
- keeps the in-transaction `status: 'PENDING'` guard for concurrent requests.

- Code: `src/modules/workspaces/invitation.service.ts`
- Regression tests: `tests/phase5-workspaces.test.ts`

### 3.4 Join request transitions and notification consistency

Join request approval, rejection, and withdrawal now use a conditional
`PENDING` plus unexpired update inside the transaction. Concurrent decisions
cannot create duplicate memberships or overwrite a decision that already won.
Request-received notifications are written in the same transaction as the
request and audit event, avoiding a committed request followed by a failed
response because notification persistence failed. Duplicate-membership races
return a conflict response.

- Code: `src/modules/workspaces/join-request.service.ts`
- Regression test: concurrent approval in `tests/phase5-join-requests-db.test.ts`

### 3.5 Phase 6 database test fixture

The ownership tests read the account ID from the wrong `/auth/me` response
shape and did not remove their owned workspaces during teardown. The fixture
now reads `data.user.id` and deletes test workspaces before their owner users.

- Test: `tests/phase6-authorization-db.test.ts`

---

## 4. Verification performed

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npm run typecheck` | Pass |
| Lint | `npm run lint` | Pass |
| Full unit/integration suite | `node --import tsx --test --test-concurrency=1 tests/*.test.ts` with Phase 3–6 DB flags and an isolated PostgreSQL test database | 243 pass, 1 skipped, 0 fail |
| Phase 5 integration suites | `tests/phase5-join-requests-db.test.ts` and `tests/phase5-workspaces-db.test.ts` | 31 pass, 0 fail; includes domain matching and task reassignment regression cases |
| Phase 6 authorization integration suite | `tests/phase6-authorization-db.test.ts` | 18 pass, 0 fail after correcting stale test identity and cleanup assumptions |
| Typecheck | `npm run typecheck` | Pass |
| Lint | `npm run lint` | Pass |
| Formatting | `npm run format:check` | Pass |
| Build | `npm run build` | Pass |
| OpenAPI parse | Python PyYAML load of `docs/openapi.yaml` | Pass |

The one skipped test is the existing optional Phase 2 migration assertion. The database suites ran against disposable databases under `/tmp`; the configured `.env` database was not used. Phase 4 and Phase 5 implementation files were already modified or untracked before this turn and were preserved. Phase 4 remains open, so Phase 5 is not marked complete despite the remediation tests passing.

### Follow-up audit run — 2026-11-03

The standard `npm test` command passed 116 tests with 0 failures and 1 skipped optional Phase 2 migration assertion. Database-backed Phase 3–6 suites were skipped because this run had no explicitly configured test database; therefore this unit run does not independently re-verify their integration evidence above. `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `git diff --check`, and PyYAML parsing of `docs/openapi.yaml` passed. The initial parser invocation using `python` could not run because that executable is unavailable; the same parse succeeded with `python3`.

---

## 5. Remaining work

- Complete Phase 4 personal provisioning after deciding how its automatically owned workspace is handled during account deletion. Implement missing Company/Institution profiles/settings and frontend API integration; then verify every Phase 4 acceptance criterion before closing it.
- Phase 5 remediation decisions are implemented and verified; complete any remaining Phase 5 acceptance criteria before starting Phase 6.
- Resolve the role taxonomy before proceeding through Phase 6.
- Audit Phase 7 and Phase 8 branches if they are brought into the active branch.
- Remove unused Sequelize dependencies and legacy `.js` dead code after approval.
