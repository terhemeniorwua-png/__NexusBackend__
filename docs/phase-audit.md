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

Phases 1–6 are the only phases whose work is present on this branch or on
`origin/main`. Phases 7 and 8 exist only on unmerged branches and were not
pulled into this audit.

| Phase | Documented status | Verified status | Evidence / action |
| --- | --- | --- | --- |
| 1 — Foundation | Complete | VERIFIED COMPLETE | Health routes, config validation, error contract, request logging, tests pass |
| 2 — Database and Redis | Complete | VERIFIED COMPLETE | Prisma schema and migration history present; Redis client with graceful failure; DB tests gated |
| 3 — Authentication and accounts | Complete | VERIFIED COMPLETE | Registration, verification, sessions, rotation, password reset, email change, reactivation; unit + integration tests |
| 4 — Transactional email | Complete | VERIFIED COMPLETE | Bounded retries, recipient/token redaction, notifiers for task/mention/meeting/team events, signed webhook |
| 5 — Workspaces, membership and invitations | Complete (old tracker) | PARTIALLY COMPLETE | Workspaces, membership and invitations exist and are enforced server-side. Missing full product scope: join requests, public discovery, join links/codes, membership suspension, task reassignment. Safe defects fixed in this task (below). |
| 6 — Roles and permissions | Complete | PARTIALLY COMPLETE | Centralized policy module and ownership transfer exist. The documented Company/Institution role taxonomy (Owner, Admin, Team Lead, Member, Guest; Institution equivalents) does not match the Prisma `WorkspaceRole` enum (OWNER, PROJECT_MANAGER, MEMBER, COLLABORATOR, VIEWER). Needs a product decision before any schema rename. |
| 7 — Teams and departments | Complete on `feature/phase-7-teams` only | NOT AUDITED ON THIS BRANCH | Branch unmerged; out of scope until the active phase is agreed |
| 8 — Projects and visibility | In progress on `feature/phase-8-projects` only | NOT AUDITED ON THIS BRANCH | Branch unmerged; `ProjectVisibility` currently has only PRIVATE/WORKSPACE, while docs require three levels |
| 9–32 | Not started | NOT STARTED | No implementation on this branch |

### Cross-cutting findings (not fixed here)

1. **Role taxonomy mismatch.** `README.md` defines Company roles
   Owner/Admin/Team Lead/Member/Guest, while the database and API use
   OWNER/PROJECT_MANAGER/MEMBER/COLLABORATOR/VIEWER. Renaming roles is a
   breaking product and data decision and was not done unilaterally.
2. **Workspace type missing.** `README.md` describes Individual, Company and
   Institution workspaces, but `Workspace` has no type field. Adding it and its
   behaviour requires an approved schema migration.
3. **Project visibility levels.** The schema has `PRIVATE` and `WORKSPACE`; the
   documentation requires organisation-wide, department/team-only and
   private/invitation-only. Deferred to the projects phase.
4. **Unimplemented Phase 5 scope.** Join requests, public workspace discovery,
   join links/codes, membership suspension and task reassignment have no
   routes, services or models. These are feature-sized gaps, not incidental
   fixes.

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

---

## 4. Verification performed

| Check | Command | Result |
| --- | --- | --- |
| Type check | `npm run typecheck` | Pass |
| Lint | `npm run lint` | Pass |
| Unit/integration tests | `npm test` | 112 pass, 1 skipped, 0 fail |
| Build | `npm run build` | Pass |
| OpenAPI parse | `python3 -c "import yaml; yaml.safe_load(...)"` | Pass |
| DB integration suite | `RUN_PHASE5_DB_TESTS=true` | Blocked: no test database configured in this environment |

The skipped test is the database-gated suite. It is not reported as passing.

---

## 5. Remaining work

- Decide the role taxonomy and migrate `WorkspaceRole` (or document PROJECT_MANAGER
  as the canonical Team Lead equivalent).
- Add a workspace type model and enforcement.
- Implement the missing Phase 5 membership lifecycle features.
- Audit unmerged Phase 7 and Phase 8 branches before they are relied upon.
- Remove unused Sequelize dependencies and legacy `.js` dead code after approval.
