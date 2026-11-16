# Staging Verification (Phase 32)

**Date:** 2026-11-16  
**Scope:** Backend `__NexusBackend__` and frontend `__NextFrontend__` per `__NextFrontend__/docs/PHASE_32_DEPLOYMENT_GUIDE.md`  
**Branches inspected:** backend `feat/realtime-notifications` @ `762b88b` (base for this doc), frontend `feature/frontend-work-navigation` (dirty working tree)  
**Deployment target:** Not provided in workspace (no staging URLs, hosting credentials, or platform-specific deploy config found)

## Summary

- **Deployment executed:** **BLOCKED / NOT PERFORMED.** The deployment guide (`__NextFrontend__/docs/PHASE_32_DEPLOYMENT_GUIDE.md`) was reviewed, but no staging infrastructure, environment secrets, deploy credentials, or target endpoints (API/frontend/socket origins) are available in this environment. CI (`.github/workflows/ci.yml`) covers test/build on PR/push to `main`, not staging deployment. No Docker/Render/Vercel/Fly/Railway/nginx deploy manifests were found in backend (only `.env.example`/`.env` present).
- **Configuration problems fixed in-repo:** **None.** No safe, staging-specific repository configuration fix could be applied without known staging origins/URLs/secrets. CORS, CSRF, cookie, proxy, socket, and health implementations were reviewed and appear structurally aligned with the guide (see checklist notes); staging correctness depends on environment configuration.
- **Real defects / issues:** Listed below (must be addressed outside this doc/task scope as appropriate).

## Checklist

| Area | Status | Evidence / Notes |
|---|---|---|
| **Cookies and CSRF across domains** | **BLOCKED** (config-dependent) | Backend implements refresh token in `httpOnly` cookie (`nexus_rt`), separate non-httpOnly CSRF cookie (`nexus_csrf`, derived from session), and requires `x-csrf-token` header for cookie-authenticated refresh/logout flows (`src/modules/auth/csrf.ts`, `src/modules/auth/auth.controller.ts`). CORS allows `X-CSRF-Token` (`src/middleware/cors.ts`). Cross-domain staging requires env: `CORS_CREDENTIALS=true`, `CORS_ORIGINS` including exact frontend origin(s), `AUTH_COOKIE_SECURE=true`, `AUTH_COOKIE_SAME_SITE=none` (if cross-site), correct `AUTH_COOKIE_DOMAIN` (or unset), and `TRUST_PROXY=true` behind TLS-terminating proxy. Cannot verify on staging without deployment. |
| **CORS** | **BLOCKED** (config-dependent) | Origin-validated CORS with explicit allowlist from `CORS_ORIGINS`/`FRONTEND_URL`, credentials gated by `CORS_CREDENTIALS`, methods/headers restricted, `Vary: Origin` behavior present (`src/middleware/cors.ts`, `src/config/env.ts`). Allowed headers include `Authorization, Content-Type, X-Request-Id, X-CSRF-Token`. Cannot verify preflight/credentialed requests against staging domains without deployment. |
| **OAuth redirect** | **BLOCKED** | Guide: Google sign-in/calendar start at `${NEXT_PUBLIC_BACKEND_ORIGIN}/api/v1/auth/google`, frontend callback `/auth/google/callback`, state cookie must be set/validated on backend host receiving Google callback. Backend mounts Google OAuth routes and supports configured callback URL path (`src/app.ts`, auth/google-oauth modules); frontend proxy validates Google initiation redirect and maps failures to callback errors (`__NextFrontend__/app/api/backend/[...path]/route.ts`, `lib/google-oauth.ts` uses `NEXT_PUBLIC_BACKEND_ORIGIN`). Requires staging `NEXT_PUBLIC_BACKEND_ORIGIN`, backend Google client/callback env, and Google Console authorized redirect URIs matching deployed backend callback; not verifiable without staging. |
| **Socket connection through the proxy** | **BLOCKED** (guide: direct connect) | Guide states WebSocket upgrades connect **directly** to `NEXT_PUBLIC_SOCKET_URL` (not through serverless proxy). Frontend socket client connects to `NEXT_PUBLIC_SOCKET_URL` with path `/socket.io` and auth via access token/refresh (`__NextFrontend__/lib/socket.ts`). Backend Socket.IO server at `/socket.io` with JWT auth, CORS from `corsOrigins`, optional Redis adapter (`src/realtime/socket-server.ts`). "Through the proxy" path not applicable per current architecture; direct WSS connectivity to staging backend origin must be verified post-deploy. Not verifiable without staging. |
| **Health endpoints** | **PASS (local/code)** / **BLOCKED (staging)** | Backend exposes `GET {apiPrefix}/health`, `/health/live`, `/health/ready`, `/health/workers` with dependency/worker/queue status reporting (`src/routes/health.ts`, mounted via API router). Frontend guide notes frontend has no dedicated health endpoint (platform check against `/` acceptable). Staging reachability/ready status not verifiable without deployment. |
| **File transfer** | **BLOCKED** | Backend uses private S3-compatible object storage and authenticated file APIs (env: `OBJECT_STORAGE_*`; file routes/modules present). Frontend proxy allowlist currently includes only `auth, users, workspaces, invitations, billing, notifications, integrations, search, ai, privacy-requests` and does **not** include file/task/project/messaging/media prefixes (`__NextFrontend__/app/api/backend/[...path]/route.ts`), so browser-mediated file upload/download through `/api/backend/*` may be impacted depending on frontend usage. Actual staging upload/download/authz behavior not verifiable without deployment and storage credentials. |

## Local verification performed (non-staging)

- Reviewed deployment guide, backend/frontend env examples, CORS/CSRF/auth cookie/socket/health/proxy implementations.
- Backend `npx tsc --noEmit`: **passed** (on `feat/realtime-notifications`).
- Backend `npx vitest run`: **2 files, 43 tests passed** (vitest suites present in repo; full `npm test` node:test DB suites not executed in this pass).
- No staging build/deploy commands executed against external environments (no targets/credentials).

## Real defects / issues (not fixed here)

1. **Missing staging deployment artifacts/targets (process/env):** `docs/PHASE_32_DEPLOYMENT_GUIDE.md` not present in backend repo (found in frontend repo); no staging URLs, hosting platform configuration, secrets management, or deploy automation for staging provided. Cannot complete "Deploy backend and frontend to staging" without infrastructure access.
2. **Frontend proxy allowlist may not cover required API modules for staging flows:** `__NextFrontend__/app/api/backend/[...path]/route.ts` `ALLOWED_API_PREFIXES` omits modules such as files/projects/tasks/channels/meetings/calendar/forms/teams/automations/analytics/dev-integrations (present in backend). Risk: REST calls routed through same-origin proxy for these areas (including file transfer) could be rejected (404). *Not modified:* frontend working tree is dirty with unrelated/pre-existing changes; requires coordinated, tested frontend fix.
3. **Cross-domain cookie/CSRF configuration must be set explicitly for staging:** default/example values are dev-oriented (`CORS_CREDENTIALS=false`, `AUTH_COOKIE_SECURE=false`, `SameSite=lax`). Staging across domains needs `Secure` + `SameSite=None` + `credentials` + exact origin allowlist + proxy trust; misconfiguration will break auth/session/CSRF/OAuth flows.
4. **Socket "through the proxy" vs direct connect ambiguity:** guide and implementation use direct `NEXT_PUBLIC_SOCKET_URL` (`/socket.io`) rather than proxy transport; if staging expects proxy-mediated sockets, reverse-proxy/WSS upgrade configuration is required (separate infra concern).
5. **File transfer end-to-end not validated:** depends on object storage config/permissions, signed URL/access paths, and frontend proxy/API usage; blocked pending staging deployment.

## Configuration problems fixed

- **None applied.** Only configuration problems with known-correct staging values could be safely fixed; none identified/available. No application code changes made for this verification.

## Recommended staging env checks (from guide/code)

- **Backend:** `FRONTEND_URL`, `CORS_ORIGINS` (exact staging frontend origin), `CORS_CREDENTIALS=true`, `TRUST_PROXY=true` (if behind LB/proxy), `AUTH_COOKIE_SECURE=true`, `AUTH_COOKIE_SAME_SITE=none` (cross-site), `AUTH_COOKIE_DOMAIN` as required, `redirect_URL`/Google callback URL matching deployed backend, `NEXUS`/`OBJECT_STORAGE_*`, Redis/Postgres reachable, `NEXUS_API_URL` equivalent base correct.
- **Frontend:** `NEXUS_API_URL=https://<staging-api>/api/v1`, `NEXT_PUBLIC_SOCKET_URL=https://<staging-api>` (no trailing slash), `NEXT_PUBLIC_BACKEND_ORIGIN=https://<staging-api>`, OAuth backend return target allowed, platform `/` health check.
- **Verify post-deploy:** sign-in/refresh/logout/session expiry, CSRF on cookie-auth requests, CORS preflight+credentials, Google OAuth start/callback + state cookie on backend host, Socket.IO connect/join workspace/reconnect over WSS, authorized file upload/download, `GET /api/v1/health`, `/health/live`, `/health/ready`.


