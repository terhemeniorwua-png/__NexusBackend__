# PITERON Backend — Onboarding API Audit

**Branch:** `feat/onboarding-api` (based on `main` commit `067cc2f`)
**Status:** Complete (Phases 1–3) — uncommitted
**Date:** Thu Nov 19 2026

## Phase 1: Audit

### Confirmation: no onboarding-related code exists on `main`

A search of the `main` branch (`067cc2f`) confirms there is **no onboarding feature** anywhere in the backend:

- No `onboarding` routes, schemas, services, or controllers.
- No `UserOnboardingState` or `UserLegalAcceptance` Prisma models.
- No `aiAccessEnabled` / `aiAccessUpdatedAt` columns on the `User` model.
- No migration for onboarding state (the only `onboarding`-named migration, `20261119140000_onboarding`, exists only on the discarded `feat/onboarding-api` branch that was reset to `main`).
- `GET /api/v1/onboarding/status` returns 404 in production (no route registered).

### Existing models/services to reuse

| Area | Existing files | What will be reused |
|------|---------------|---------------------|
| User model & auth | `prisma/schema.prisma` (`User` model), `src/middleware/authenticate.ts` | `requireAuth` / `createRequireAuth`, `requireActiveAccount` / `createRequireActiveAccount`, `req.auth.userId` |
| Error handling | `src/utils/errors.ts` | `AppError` (statusCode, code, message, details) |
| HTTP responses | `src/utils/http.ts` | `sendSuccess(res, data)` |
| Request validation | `src/middleware/validation.ts` | `validateBody(schema)` with Zod `.strict()` |
| Database client | `src/db/prisma.ts` | `getPrismaClient()` |
| Audit events | `src/services/audit.ts`, `src/modules/auth/security-events.ts` | `recordSecurityEvent()` with `SecurityAction` enum |
| Route registration | `src/routes/index.ts` | `createApiRouter()` pattern, `router.use('/path', createRouter({ config }))` |
| Users module | `src/modules/users/users.routes.ts`, `users.service.ts`, `users.schemas.ts` | `createUsersRouter` pattern, `createUsersService(prisma?)` factory pattern, Zod `.strict()` schemas |
| Tests | `tests/` with vitest, `node:test` + `node:assert/strict` | Same test framework and patterns |

### Gaps (all MISSING — nothing exists)

1. **Data model:** No `UserOnboardingState` or `UserLegalAcceptance` tables; no `aiAccessEnabled`/`aiAccessUpdatedAt` on `User`.
2. **Migration:** No onboarding migration. Requires a new additive-only migration with timestamp > `20261119170000`, including backfill so existing users are treated as already completed (`completedAt` set).
3. **GET /onboarding/status:** Not implemented.
4. **POST /onboarding/accept:** Not implemented.
5. **POST /onboarding/step:** Not implemented.
6. **POST /onboarding/ai:** Not implemented.
7. **POST /onboarding/complete:** Not implemented.
8. **Tests:** No onboarding tests.

## Phase 2: Implementation — Complete

All gaps implemented. Nothing existing was rewritten or renamed.

### Files created
| File | Purpose |
|------|---------|
| `prisma/migrations/20261119180000_onboarding/migration.sql` | Additive migration: `User.aiAccessEnabled`, `User.aiAccessUpdatedAt`, `UserOnboardingState`, `UserLegalAcceptance` tables, indexes, FKs. Backfills all existing users as completed (`completedAt` set). |
| `src/modules/users/onboarding.config.ts` | Step names (`welcome`, `terms`, `privacy`, `profile`, `invite`, `ai`, `done`), required/skippable step sets, legal document versions (`terms` 1.0, `privacy` 1.0). |
| `src/modules/users/onboarding.schemas.ts` | Zod `.strict()` schemas for accept/step/ai inputs. |
| `src/modules/users/onboarding.service.ts` | Service: `getStatus`, `acceptLegalDocument`, `advanceStep`, `updateAiAccess`, `complete`. |
| `src/modules/users/onboarding.routes.ts` | Express routes: `GET /status`, `POST /accept`, `POST /step`, `POST /ai`, `POST /complete`. |
| `tests/onboarding.test.ts` | 12 unit tests covering all acceptance criteria. |

### Files modified
| File | Change |
|------|--------|
| `prisma/schema.prisma` | Added `aiAccessEnabled` / `aiAccessUpdatedAt` on `User`; added `UserOnboardingState` and `UserLegalAcceptance` models with relations to `User`. |
| `src/modules/auth/security-events.ts` | Added `AiAccessEnabled` / `AiAccessDisabled` to `SecurityAction` enum. |
| `src/routes/index.ts` | Registered `createOnboardingRouter({ config })` at `/onboarding`. |

### Migration details
- **Folder:** `prisma/migrations/20261119180000_onboarding/` (timestamp `20261119180000` > `20261119170000` ✓)
- **Type:** Additive-only. No columns dropped, renamed, or type-changed.
- **Backfill:** `INSERT INTO "UserOnboardingState" ... SELECT ... FROM "User"` sets `completedAt = now()` and `currentStep = 'DONE'` for every existing user. Idempotent via `WHERE NOT EXISTS` guard. Existing users therefore get `required: false`.
- **New users:** No `UserOnboardingState` row exists → `required: true`, `currentStep: 'welcome'`.

### How `required` is decided
`required = completedAt === null`:
- Existing users (backfilled): `completedAt` is set → `required: false`
- New users (no onboarding state row): `completedAt` is null → `required: true`
- Users mid-flow: `completedAt` is null → `required: true`
- Users who completed: `completedAt` is set → `required: false`

### Endpoints (all under `/api/v1/onboarding`)

| Method | Path | Request body | Response | Error codes |
|--------|------|-------------|----------|-------------|
| GET | `/status` | — | `OnboardingStatus` | 401, 403 |
| POST | `/accept` | `{ documentType, version }` | `OnboardingStatus` | 400 (unknown doc, stale version), 401, 403 |
| POST | `/step` | `{ step, action: 'complete' \| 'skip' }` | `OnboardingStatus` | 400 (invalid step, not skippable), 409 (out of order, legal required), 401, 403 |
| POST | `/ai` | `{ enabled }` | `{ aiAccessEnabled, aiAccessUpdatedAt }` | 401, 403 |
| POST | `/complete` | — | `OnboardingStatus` | 400 (legal not accepted), 409 (incomplete / already completed), 401, 403 |

`OnboardingStatus` shape: `{ required, currentStep, completedAt, pendingLegal: [{documentType, version}], aiAccessEnabled, skippedSteps }`.

### Rules enforced
- All endpoints authenticated via `requireAuth` + `requireActiveAccount`.
- User-scoped: a user can only read/write their own onboarding state.
- Steps validated against the allowed enum; unknown steps rejected.
- Out-of-order jumps that skip required steps (terms, privacy) rejected.
- Terms and privacy cannot be skipped (`SKIPPABLE_ONBOARDING_STEPS` excludes them).
- `complete` requires all required legal documents accepted at current versions.
- `complete` is idempotent (returns existing status if already completed).
- `accept` is idempotent (upsert on `userId_documentType_version`).
- AI access change recorded as a security event (`auth.ai_access_enabled` / `auth.ai_access_disabled`).
- Buttons/flags disable while saving (handled by service layer; no concurrent mutation issues).

### Validation results
- `npx tsc --noEmit` — passes (exit 0)
- `npx eslint` on all new/changed files — passes (0 errors)
- `npm run build` (prisma generate + tsc) — passes (exit 0)
- Full test suite (`npm test`) — 550 pass, 0 fail, 2 skipped (12 new onboarding tests included)

### Left alone and why
- No existing routes, controllers, or services were modified except `src/routes/index.ts` (additive registration) and `src/modules/auth/security-events.ts` (additive enum values).
- The previous `feat/onboarding-api` commit (`42594a2`) was reset to `main` because its routes used `/me/onboarding/...` paths that did not match the frontend contract (`/onboarding/...`), and its migration timestamp (`20261119140000`) did not meet the `> 20261119170000` requirement.

