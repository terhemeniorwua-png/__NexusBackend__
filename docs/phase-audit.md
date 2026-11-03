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

---

## 6. Merged-branch audit — 2026-11-03

### Documentation and roadmap findings

The repository uses `AGENTS.md` and `PHASES.md`; the requested filenames
`agent.md`, `phases.md`, and `skill.md` do not exist. No `branding.md` or
separate backend architecture/security/API skill document was found. The
current `PHASES.md` contains overlapping phase numbering: an email Phase 4.6
is still in progress, the workspace Phase 4 section is also present, and a
Phase 7 completion note conflicted with the fuller Phase 7 acceptance criteria.
The tracker now records Phase 7 as in progress and holds Phase 8. Invitation
decline is implemented and its stale `NOT STARTED` row is corrected.

### Phase status from source and verification

These classifications apply to the project-level 0–32 roadmap supplied for
this audit. The repository contains a second 1–24 roadmap; the number collision
is a documentation issue and must be resolved before future phase advancement.

| Phase | Verified status | Evidence / remaining work |
| --- | --- | --- |
| 0 — Repository audit | VERIFIED COMPLETE | Architecture, actual modules, dependencies, missing services and documentation drift recorded in this audit. |
| 1 — Core infrastructure | VERIFIED COMPLETE | TypeScript, lint, build and HTTP foundation/unit checks pass. |
| 2 — Database architecture | VERIFIED COMPLETE | Eleven migrations deploy on isolated PostgreSQL; Phase 2 schema/constraint tests pass 2/2. |
| 3 — Authentication and identity | VERIFIED COMPLETE | Database lifecycle suite passes 59/59, including account deletion, recovery and shared-record preservation. |
| 4 — Workspaces / transactional email | PARTIALLY COMPLETE | Workspace lifecycle and email persistence work. Personal file deletion is safely held because no private object-storage deletion adapter exists; Phase 4.6 still lacks several production workflow callers. |
| 5 — Membership and onboarding | VERIFIED COMPLETE | Join, invitation decline/acceptance, expiry, suspension, reassignment and isolation DB suites pass 34/34. |
| 6 — Roles and access control | VERIFIED COMPLETE | Authorization DB suite passes 20/20; centralized policy unit coverage runs in the standard test suite. Custom roles remain explicitly deferred. |
| 7 — Teams and organization structure | PARTIALLY COMPLETE | Team lifecycle DB suite passes 38/38. Company/Institution profiles and settings, institution groups and project/channel integrations remain absent. |
| 8 — Projects and project visibility | PARTIALLY COMPLETE | Project schema and authorization policy exist; no project HTTP/business workflow is registered. |
| 9 — Tasks and work management | PARTIALLY COMPLETE | Task schema and assignment notifier exist; task CRUD/workflow APIs and their integrations are absent. |
| 10 — Messaging | NOT IMPLEMENTED | No persistent conversation/message service, route or realtime delivery path found. |
| 11 — Notifications and activity | PARTIALLY COMPLETE | Notification persistence/service and audit writes exist; complete event producers, read-state APIs and activity feed are absent. |
| 12 — Files and storage | PARTIALLY COMPLETE | File metadata exists; private upload/download authorization, object storage adapter and signed URL workflow are absent. |
| 13 — Document collaboration | NOT IMPLEMENTED | No document collaboration module or routes found. |
| 14 — Calendar and scheduling | NOT IMPLEMENTED | No calendar/scheduling module or routes found. |
| 15 — Meetings and calling | NOT IMPLEMENTED | No meeting provider integration or meeting routes found. |
| 16 — Forms and surveys | NOT IMPLEMENTED | No forms/surveys module or routes found. |
| 17 — Subscription and billing | PARTIALLY COMPLETE | Pricing and lifecycle policy helpers exist; billing persistence, routes and payment-provider integration do not. |
| 18 — Search | NOT IMPLEMENTED | No search service or API routes found. |
| 19 — Integrations | NOT IMPLEMENTED | No OAuth integration framework or provider connection routes found. |
| 20 — Automation | NOT IMPLEMENTED | No workflow/automation engine found. |
| 21 — Python AI integration | NOT IMPLEMENTED | No Express-to-FastAPI orchestration module found. |
| 22 — Nexus Write | NOT IMPLEMENTED | No writing assistance API/integration found. |
| 23 — AI action approval | NOT IMPLEMENTED | No approval or approved-action execution service found. |
| 24 — Redis/jobs/events | PARTIALLY COMPLETE | Redis-backed rate limiting and bounded email delivery worker exist; no general durable job/event processing layer exists. |
| 25 — Email delivery | PARTIALLY COMPLETE | Outbox, retries, privacy, webhooks and notifier tests work; real task/mention/meeting/team/project workflow callers are incomplete. |
| 26 — Audit/security monitoring | PARTIALLY COMPLETE | Transactional audit records are written for sensitive workspace/team changes; a complete security monitoring pipeline is absent. |
| 27 — Reporting and analytics | NOT IMPLEMENTED | No reporting or analytics API/module found. |
| 28 — API documentation | PARTIALLY COMPLETE | Human route index and OpenAPI include the registered team routes; no automated route/spec parity check exists. |
| 29 — Testing and QA | PARTIALLY COMPLETE | Unit and selected PostgreSQL suites pass; the full product security, integration and external-service matrix is not implemented. |
| 30 — Performance hardening | NOT IMPLEMENTED | No load/performance verification or production query review artifact found. |
| 31 — Deployment operations | NOT IMPLEMENTED | No complete production deployment/operations implementation found. |
| 32 — Release readiness | NOT IMPLEMENTED | The backend remains a partial product build; release criteria are not met. |

### Remediation and verification in this audit

- Fixed `/api/v1` router construction to instantiate and inject the already
  imported join-request service; otherwise application creation failed with
  `ReferenceError: joinRequestService is not defined`.
- Preserved explicit team membership for organization roles while restoring
  mapped owner/admin team capabilities for teams they belong to. No access is
  granted to every team based only on an organization role.
- Corrected stale Phase 5/6/7 database fixtures for the current `/auth/me`
  response, Redis-backed rate limiter setup, last-owner conflict responses,
  cross-workspace non-member concealment, and cleanup of test-owned workspaces.
- Corrected account deletion after a co-owner transfer: deletion now blocks
  only when the user is the last active owner/admin, while still preserving a
  primary `Workspace.ownerId` transfer safeguard. Account-deletion rate-limit
  keys normalize IPv6 addresses.
- Updated `docs/API.md` and `docs/openapi.yaml` with the eleven team operations
  (six nested path shapes); the OpenAPI document parses with 57 paths and no
  unresolved component references.
- PostgreSQL integration results: Phase 3 59/59; Phase 4 email 54/54; Phase 5
  membership/onboarding 34/34; Phase 6 authorization 20/20; Phase 7 team
  lifecycle 38/38. Phase 2 schema checks pass 2/2.
- Standard `npm test`: 197 passed, 0 failed, 2 skipped. The skips are opt-in
  database suites; the named DB suites above were run separately on disposable
  PostgreSQL databases after deploying all 11 migrations.

Phase 7 remains the earliest incomplete item in the project-level sequence.
Do not start Phase 8 until the remaining Phase 7 criteria and the roadmap's
numbering/sequence conflict are resolved. Phase 4.6 remains separately open
because its workflow dependencies span task, meeting, team and project modules.
