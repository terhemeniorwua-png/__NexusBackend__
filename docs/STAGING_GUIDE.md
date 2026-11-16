# Nexus Backend Staging / Deployment Guide

This guide documents staging/production configuration for the Nexus Express backend, including all environment variables read by the code (`src/config/env.ts`), cookie/CORS/CSRF behavior, health checks, migrations, and deployment.

> **Do not commit real secrets.** Use your host's secret manager / dashboard for values marked **Secret**.

## 1. Runtime & process

| Variable | Required | Secret | Default / safe example | Notes |
|---|---:|---:|---|---|
| `NODE_ENV` | Yes | No | `production` | `development` \| `test` \| `production`. Production enables strict boot validation. |
| `PORT` | No | No | `4000` | HTTP port the server binds. |
| `APP_NAME` | No | No | `Nexus` | Service name reported by health endpoints. |
| `APP_VERSION` | No | No | `0.1.0` | Version reported by health endpoints. |
| `LOG_LEVEL` | No | No | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent`. |
| `REQUEST_BODY_LIMIT` | No | No | `1mb` | e.g. `1mb`, `512kb`. |
| `TRUST_PROXY` | No | No | `true` (behind Render/LB) | `true`/`false`. Set `true` when behind a reverse proxy/load balancer. |
| `SHUTDOWN_TIMEOUT_MS` | No | No | `10000` | Graceful shutdown timeout. |
| `DB_HEALTH_TIMEOUT_MS` | No | No | `3000` | Readiness DB probe timeout. |
| `REDIS_HEALTH_TIMEOUT_MS` | No | No | `3000` | Readiness Redis probe timeout. |
| `WORKER_HEALTH_STALE_MS` | No | No | `120000` | Worker health staleness threshold. |

## 2. Core infrastructure (required)

| Variable | Required | Secret | Default / safe example | Notes |
|---|---:|---:|---|---|
| `DATABASE_URL` | **Yes** | **Secret** | `postgresql://user:pass@host:5432/nexus?sslmode=require` | PostgreSQL URL (`postgresql://` or `postgres://`). |
| `REDIS_URL` | **Yes** | **Secret** | `rediss://:pass@host:6379` | Redis URL (`redis://` or `rediss://`). Used for cache/rate limits/coordination; Postgres remains source of truth. |

## 3. Frontend, CORS, cookies, CSRF

| Variable | Required | Secret | Default / safe example | Notes |
|---|---:|---:|---|---|
| `FRONTEND_URL` | **Yes (prod)** | No | `https://app.example.com` | Public frontend base URL (absolute). Used for links/emails and included in CORS origins. Must be `https` in production. |
| `CORS_ORIGINS` | Recommended | No | `https://app.example.com` | Comma/`\|\|`-separated allowed origins. Parsed origins are merged with `FRONTEND_URL`. |
| `CORS_CREDENTIALS` | **Yes (prod, must be `true`)** | No | `true` | Enables credentialed CORS responses. **Production boot refuses if `false`.** |
| `AUTH_COOKIE_SECURE` | **Yes (prod, must be `true`)** | No | `true` | Secure cookies. **Production boot refuses if `false`.** (Runtime also forces secure in prod.) |
| `AUTH_COOKIE_SAME_SITE` | No | No | `none` or `lax` | `lax` \| `strict` \| `none`. `none` requires `AUTH_COOKIE_SECURE=true`. |
| `AUTH_COOKIE_DOMAIN` | Situational | No | `.example.com` (if needed) | Set when cookie must be shared across subdomains; otherwise leave empty. |

### Vercel frontend proxying REST + direct Socket.IO
- **REST (proxied):** Browser calls the Vercel frontend origin; Vercel proxies API requests to the backend. If the browser and API are effectively same-site via the proxy, `SameSite=lax` can work; if cross-site cookie auth is required, use `AUTH_COOKIE_SAME_SITE=none`, `AUTH_COOKIE_SECURE=true`, `CORS_CREDENTIALS=true`, and include the exact frontend origin in `CORS_ORIGINS`/`FRONTEND_URL`.
- **Socket.IO (direct cross-site):** Browsers connect directly to the backend from another site, so session cookies are not relied on for the handshake. The Socket.IO handshake is **token-based**: clients must pass a short-lived access token in `socket.handshake.auth.token` (verified via the existing access-token service). Room joins (`workspace:join`, `channel:join`) are still authorized server-side.
- **CSRF:** Cookie-authenticated state-changing REST requests require a valid CSRF token (double-submit style: `nexus_csrf` cookie + `x-csrf-token` header, validated against the session). CSRF is enforced for cookie-auth flows; token/header-based API auth is not cookie-CSRF-dependent. Ensure the frontend sends the `x-csrf-token` header on protected cookie-authenticated requests and that the proxy forwards cookies/headers correctly.

## 4. Authentication & core secrets

| Variable | Required | Secret | Default / safe example | Notes |
|---|---:|---:|---|---|
| `JWT_ACCESS_SECRET` | **Yes** | **Secret** | (random, >= 32 chars) | HS256 access-token signing secret. **Required; must be non-placeholder in production.** |
| `OTP_HMAC_SECRET` | **Yes (prod)** | **Secret** | (random, >= 32 chars) | OTP HMAC secret. **Must be set (not test default) in production.** |
| `TOTP_ENCRYPTION_KEY` | **Yes (non-test/prod)** | **Secret** | (base64url 32-byte key, 43 chars) | Encrypts TOTP secrets; must be base64url-encoded 32 bytes. **Required in production.** |
| `JWT_ACCESS_TTL_SECONDS` | No | No | `900` | Access token TTL (max 86400). |
| `REFRESH_TOKEN_TTL_SECONDS` | No | No | `2592000` | Refresh token TTL. |
| `BCRYPT_SALT_ROUNDS` | No | No | `12` | Password hashing cost (4–15). |
| `VERIFICATION_TOKEN_TTL_SECONDS` | No | No | `3600` | Email verification token TTL. |
| `PASSWORD_RESET_TOKEN_TTL_SECONDS` | No | No | `1800` | Password reset token TTL. |
| `EMAIL_CHANGE_TOKEN_TTL_SECONDS` | No | No | `3600` | Email change token TTL. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | No | No | `900000` | Auth rate-limit window. |
| `AUTH_LOGIN_RATE_LIMIT_MAX` | No | No | `10` | Max login attempts per window. |
| `AUTH_REGISTER_RATE_LIMIT_MAX` | No | No | `5` | Max registrations per window. |
| `AUTH_PASSWORD_RATE_LIMIT_MAX` | No | No | `5` | Max password actions per window. |
| `AUTH_VERIFICATION_RATE_LIMIT_MAX` | No | No | `5` | Max verification actions per window. |
| `AUTH_VERIFICATION_LINK_PATH` | No | No | `/verify-email` | Frontend path for verification links. |
| `AUTH_PASSWORD_RESET_LINK_PATH` | No | No | `/reset-password` | Frontend path for reset links. |
| `AUTH_EMAIL_CHANGE_LINK_PATH` | No | No | `/settings/email` | Frontend path for email-change links. |
| `AVATAR_MAX_FILE_SIZE_BYTES` | No | No | `5242880` | Max avatar upload size. |
| `AVATAR_MAX_DIMENSION` | No | No | `4096` | Max avatar dimension. |
| `AVATAR_MAX_PIXELS` | No | No | `16000000` | Max avatar pixels. |
| `AVATAR_RATE_LIMIT_MAX` | No | No | `5` | Avatar upload rate limit. |

## 5. Workspace / invitation / notification link paths & TTLs

| Variable | Required | Secret | Default / safe example | Notes |
|---|---:|---:|---|---|
| `WORKSPACE_INVITATION_TTL_SECONDS` | No | No | `172800` (48h) | Invitation expiry. |
| `WORKSPACE_INVITATION_LINK_PATH` | No | No | `/workspaces/invitations/accept` | Frontend path. |
| `WORKSPACE_JOIN_REQUEST_TTL_SECONDS` | No | No | `604800` (7d) | Join request expiry. |
| `WORKSPACE_JOIN_LINK_PATH` | No | No | `/workspaces/join` | Frontend path. |
| `TASK_ASSIGNMENT_LINK_PATH` | No | No | `/projects/:projectId/tasks/:taskId` | Must include `:projectId` and `:taskId`. |
| `COMMENT_MENTION_LINK_PATH` | No | No | `/projects/:projectId/tasks/:taskId#comment-:commentId` | Must include `:projectId`, `:taskId`, `:commentId`. |
| `MEETING_INVITATION_LINK_PATH` | No | No | `/meetings/:meetingId` | Must include `:meetingId`. |
| `TEAM_INVITATION_LINK_PATH` | No | No | `/teams/invitations/accept` | Frontend path. |
| `PROJECT_INVITATION_LINK_PATH` | No | No | `/projects/invitations/accept` | Frontend path. |
| `RATE_LIMIT_NAMESPACE` | No | No | `nexus` | Redis key prefix for rate limits (separate per env sharing Redis). |

## 6. Email / transactional delivery

| Variable | Required | Secret | Default / safe example | Notes |
|---|---:|---:|---|---|
| `EMAIL_PROVIDER` | **Yes (prod)** | No | `smtp` or `brevo-api` | `smtp` \| `brevo-api` \| `console` \| `disabled`. **Production requires `smtp` or `brevo-api`.** |
| `EMAIL_FROM_ADDRESS` | Recommended | No | `no-reply@example.com` | Sender address. |
| `EMAIL_FROM_NAME` | No | No | `Nexus` | Sender name (defaults to `APP_NAME`). |
| `EMAIL_REPLY_TO_ADDRESS` | No | No | `` | Optional reply-to. |
| `EMAIL_SUPPORT_ADDRESS` | No | No | `` | Optional support address. |
| `EMAIL_APP_URL` | No | No | (falls back to `FRONTEND_URL`) | Public base URL for email links. |
| `EMAIL_API_KEY` | If `brevo-api` | **Secret** | `` | **Required when `EMAIL_PROVIDER=brevo-api`.** |
| `EMAIL_API_URL` | No | No | `https://api.brevo.com` | Provider API base URL. |
| `EMAIL_SMTP_HOST` | If `smtp` | No | `smtp.example.com` | **Required when `EMAIL_PROVIDER=smtp`.** |
| `EMAIL_SMTP_PORT` | No | No | `587` | SMTP port. Port 465 implies secure. |
| `EMAIL_SMTP_SECURE` | No | No | `false` (`true` for 465) | TLS mode. |
| `EMAIL_SMTP_USER` | Situational | No | `` | SMTP username. |
| `EMAIL_SMTP_PASSWORD` | Situational | **Secret** | `` | SMTP password. |
| `EMAIL_SMTP_TLS_REJECT_UNAUTHORIZED` | No | No | `true` | TLS cert validation. |
| `EMAIL_WEBHOOK_SECRET` | Situational | **Secret** | `` | HMAC secret for signed webhooks (>= 32 chars if set). |
| `EMAIL_WEBHOOK_TOKEN` | Situational | **Secret** | `` | Shared token auth for unsigned provider webhooks (>= 32 chars if set). |
| `EMAIL_WEBHOOK_SIGNATURE_HEADER` | No | No | `x-nexus-signature` | Signature header name. |
| `EMAIL_WEBHOOK_TOLERANCE_SECONDS` | No | No | `300` | Webhook timestamp tolerance. |
| `EMAIL_MAX_ATTEMPTS` | No | No | `5` | Delivery retry attempts. |
| `EMAIL_RETRY_BASE_DELAY_MS` | No | No | `30000` | Retry backoff base. |
| `EMAIL_RETRY_MAX_DELAY_MS` | No | No | `3600000` | Retry backoff max. |
| `EMAIL_REQUEST_TIMEOUT_MS` | No | No | `15000` | Provider request timeout. |
| `EMAIL_SENDING_STALE_MS` | No | No | `300000` | Stale in-flight recovery window. |
| `EMAIL_WORKER_ENABLED` | No | No | `true` | Enables email worker. |
| `EMAIL_WORKER_POLL_INTERVAL_MS` | No | No | `5000` | Poll interval. |
| `EMAIL_WORKER_BATCH_SIZE` | No | No | `10` | Batch size (1–100). |

## 7. Billing (Paystack)

| Variable | Required | Secret | Default / safe example | Notes |
|---|---:|---:|---|---|
| `PAYSTACK_SECRET_KEY` | If USD billing enabled | **Secret** | `sk_test_...` / `sk_live_...` | Required when `PAYSTACK_USD_ENABLED=true`. |
| `PAYSTACK_WEBHOOK_SECRET` | Recommended | **Secret** | `` | Webhook verification secret (if configured). |
| `PAYSTACK_WEBHOOK_PREVIOUS_SECRET` | No | **Secret** | `` | Previous webhook secret for rotation. |
| `PAYSTACK_ENCRYPTION_KEY` | If USD billing enabled | **Secret** | (base64url 32-byte key) | Required when `PAYSTACK_USD_ENABLED=true`. |
| `PAYSTACK_USD_ENABLED` | No | No | `false` | Enable USD billing. |
| `PAYSTACK_CALLBACK_URL` | If USD billing enabled | No | `https://app.example.com/billing/callback` | Absolute URL; required when USD billing enabled; `https` in prod. |
| `PAYSTACK_API_URL` | No | No | `https://api.paystack.co` | Paystack API base URL. |
| `PAYSTACK_REQUEST_TIMEOUT_MS` | No | No | `15000` | Request timeout. |

## 8. Private object storage (S3-compatible)

Used for private file/object storage (e.g. organization branding/assets). Configure all four core fields together when enabling storage.

| Variable | Required | Secret | Default / safe example | Notes |
|---|---:|---:|---|---|
| `OBJECT_STORAGE_ENDPOINT` | When storage configured | No | `https://<accountid>.r2.cloudflarestorage.com` (R2) or `https://s3.<region>.amazonaws.com` | Absolute endpoint URL (no credentials/query/fragment). Must be `https` outside local dev. |
| `OBJECT_STORAGE_BUCKET` | When storage configured | No | `nexus-private` | Bucket name. |
| `OBJECT_STORAGE_REGION` | No | No | `us-east-1` (AWS) / `auto` (R2) | Region identifier expected by provider/SDK. |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | When storage configured | **Secret** | `` | Access key id. |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | When storage configured | **Secret** | `` | Secret access key. |
| `OBJECT_STORAGE_REQUEST_TIMEOUT_MS` | No | No | `15000` | Storage request timeout. |

**Provider examples:**
- **Cloudflare R2 (S3-compatible):** `OBJECT_STORAGE_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com`, `OBJECT_STORAGE_REGION=auto`, bucket + keys from R2.
- **AWS S3:** `OBJECT_STORAGE_ENDPOINT=https://s3.<region>.amazonaws.com` (or regional endpoint), `OBJECT_STORAGE_REGION=<region>`.
- **MinIO (local/non-prod):** `http://localhost:9000` allowed only in non-production; use `https` in production.

## 9. Dev/source-control integrations

### GitHub App
| Variable | Required | Secret | Default / safe example | Notes |
|---|---:|---:|---|---|
| `GITHUB_APP_ID` | If enabled | No | `` | GitHub App id. |
| `GITHUB_APP_SLUG` | If enabled | No | `` | App slug. |
| `GITHUB_APP_CLIENT_ID` | If enabled | No | `` | OAuth client id. |
| `GITHUB_APP_CLIENT_SECRET` | If enabled | **Secret** | `` | OAuth client secret. |
| `GITHUB_APP_PRIVATE_KEY` | If enabled | **Secret** | `` | App private key (PEM). |
| `GITHUB_APP_WEBHOOK_SECRET` | If enabled | **Secret** | `` | Webhook secret. |
| `GITHUB_APP_CALLBACK_URL` | If enabled | No | `https://api.example.com/api/v1/dev-integrations/github/callback` | Absolute callback URL. |
| `GITHUB_APP_INSTALL_URL` | If enabled | No | `` | Install URL (optional per config). |

### GitLab OAuth
| Variable | Required | Secret | Default / safe example | Notes |
|---|---:|---:|---|---|
| `GITLAB_CLIENT_ID` | If enabled | No | `` | OAuth client id. |
| `GITLAB_CLIENT_SECRET` | If enabled | **Secret** | `` | OAuth client secret. |
| `GITLAB_CALLBACK_URL` | If enabled | No | `https://api.example.com/api/v1/dev-integrations/gitlab/callback` | Absolute callback URL. |
| `GITLAB_BASE_URL` | No | No | `https://gitlab.com` | GitLab base URL. |
| `GITLAB_SCOPES` | No | No | `read_api read_repository` | OAuth scopes. |
| `GITLAB_WEBHOOK_SECRET` | If webhooks used | **Secret** | `` | Webhook secret. |

### Google OAuth / integrations (if configured)
| Variable | Required | Secret | Default / safe example | Notes |
|---|---:|---:|---|---|
| `GOOGLE_CLIENT_ID` | If enabled | No | `` | Google OAuth client id. |
| `GOOGLE_CLIENT_SECRET` | If enabled | **Secret** | `` | Google OAuth client secret. |
| `GOOGLE_CALLBACK_URL` | If enabled | No | `` | Backend callback URL (also accepts legacy `redirect_URL`). |
| `redirect_URL` | Legacy/compat | No | `` | Legacy alias for Google callback URL (takes precedence if set). |

## 10. AI service integration (optional)

| Variable | Required | Secret | Default / safe example | Notes |
|---|---:|---:|---|---|
| `AI_ENABLED` | No | No | `false` | Enables AI features. Core backend works when disabled/unavailable. |
| `AI_PROVIDER` | No | No | `service` | `service` \| `openrouter`. |
| `AI_SERVICE_URL` | If `AI_ENABLED=true` & provider `service` | No | `https://ai.example.com` | Python/FastAPI service URL (no creds/query/fragment; `https` in prod). |
| `AI_SERVICE_TOKEN` | If `AI_ENABLED=true` & provider `service` | **Secret** | (>= 32 chars) | Service-to-service token. |
| `OPENROUTER_API_KEY` | If provider `openrouter` | **Secret** | `` | Required when `AI_ENABLED=true` and `AI_PROVIDER=openrouter`. |
| `AI_MODEL` | If provider `openrouter` | No | `` | Required when `AI_ENABLED=true` and `AI_PROVIDER=openrouter`. |
| `AI_FAST_MODEL` | No | No | `` | Optional fast model. |
| `AI_REQUEST_TIMEOUT_MS` | No | No | `20000` | Request timeout. |
| `AI_STREAM_TIMEOUT_MS` | No | No | `90000` | Stream timeout. |
| `AI_MAX_INPUT_CHARS` | No | No | `50000` | Input size cap. |
| `AI_MAX_CONTEXT_CHARS` | No | No | `12000` | Context size cap. |
| `AI_DAILY_REQUEST_LIMIT` | No | No | `500` | Daily request quota. |
| `AI_MONTHLY_TOKEN_LIMIT` | No | No | `2000000` | Monthly token quota. |
| `AI_CONVERSATION_RETENTION_DAYS` | No | No | `90` | Retention window. |
| `AI_WRITING_RETENTION_MINUTES` | No | No | `60` | Writing retention window. |
| `AI_ACTION_APPROVAL_TTL_SECONDS` | No | No | `900` | Approval TTL. |
| `AI_CIRCUIT_BREAKER_FAILURES` | No | No | `5` | Breaker threshold. |
| `AI_CIRCUIT_BREAKER_RESET_MS` | No | No | `60000` | Breaker reset window. |

## 11. Cache, analytics, audit, workers

| Variable | Required | Secret | Default / safe example | Notes |
|---|---:|---:|---|---|
| `CACHE_NAMESPACE` | No | No | `nexus-cache` | Redis cache key namespace. |
| `ANALYTICS_CACHE_TTL_SECONDS` | No | No | `60` | Analytics cache TTL. |
| `ANALYTICS_MAX_RANGE_DAYS` | No | No | `366` | Max analytics range. |
| `AUDIT_RETENTION_DAYS` | No | No | `365` | Audit log retention. |
| `AUDIT_PRUNE_BATCH_SIZE` | No | No | `1000` | Audit prune batch size. |
| `TASK_DEADLINE_NOTIFICATION_POLL_INTERVAL_MS` | No | No | `300000` | Deadline notification worker poll interval. |
| `TASK_RECURRENCE_WORKER_ENABLED` | No | No | `false` | Enables automatic task recurrence generation worker. |
| `TASK_RECURRENCE_POLL_INTERVAL_MS` | No | No | `60000` | Recurrence worker poll interval. |
| `RATE_LIMIT_WINDOW_MS` | No | No | `60000` | Global API rate-limit window. |
| `RATE_LIMIT_MAX` | No | No | `300` | Global API rate-limit max. |

## 12. Health-check URLs

Base path is the API prefix (`/api/v1`).

| Endpoint | Purpose | Healthy status |
|---|---|---|
| `GET /api/v1/health` | Liveness (basic) | `200` with `{ success: true, data.status: "ok" }` |
| `GET /api/v1/health/live` | Liveness | `200` |
| `GET /api/v1/health/ready` | Readiness (DB + Redis dependencies) | `200` when ready, `503` when not ready |
| `GET /api/v1/health/workers` | Worker liveness + queue depth (no payload/PII) | `200` when workers healthy, `503` otherwise (queue probe failures do not fail the report) |

Use `/api/v1/health/ready` for platform health checks/load balancer readiness (e.g. Render `healthCheckPath`).

## 13. Migration command

Apply database migrations (production/staging, non-interactive):

```bash
npx prisma migrate deploy
```

Equivalent with pnpm in-repo: `pnpm prisma migrate deploy` (if script available) or `npx prisma migrate deploy`. Ensure `DATABASE_URL` points to the target database. The provided Docker image runs `npx prisma migrate deploy && node dist/server.js` on startup.

## 14. Deploy checklist

- [ ] **Secrets set (no placeholders):** `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET`, `TOTP_ENCRYPTION_KEY`, `DATABASE_URL`, `REDIS_URL`, and any enabled integration secrets (email, storage, billing, AI, webhooks).
- [ ] **Production hardening:** `NODE_ENV=production`, `AUTH_COOKIE_SECURE=true`, `CORS_CREDENTIALS=true`, `TRUST_PROXY=true` (behind LB), `FRONTEND_URL` is `https://...`.
- [ ] **CORS/cookies:** `FRONTEND_URL`/`CORS_ORIGINS` include the exact frontend origin(s). `AUTH_COOKIE_SAME_SITE` set appropriately (`none` for cross-site + `Secure`; `lax` if same-site). `AUTH_COOKIE_DOMAIN` set only if needed.
- [ ] **CSRF:** Frontend sends `x-csrf-token` header for cookie-authenticated mutating requests; proxy forwards cookies and CSRF header.
- [ ] **Email:** `EMAIL_PROVIDER` is `smtp` or `brevo-api` in production with required provider credentials/host.
- [ ] **Object storage (if used):** all `OBJECT_STORAGE_*` core vars set (`ENDPOINT`, `BUCKET`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`), endpoint `https` in prod.
- [ ] **Migrations:** `npx prisma migrate deploy` succeeds against target DB (or container startup migration step succeeds).
- [ ] **Health checks:** `/api/v1/health/ready` returns `200` (DB/Redis reachable); `/api/v1/health/live` returns `200`.
- [ ] **Socket.IO:** Clients connect directly to backend with `auth: { token: <accessToken> }` (token-based handshake); CORS allows frontend origin with credentials as configured.
- [ ] **Webhooks/callbacks:** Provider callback/webhook URLs and secrets configured for enabled integrations (email, Paystack, GitHub/GitLab, Google).
- [ ] **Logs/monitoring:** `LOG_LEVEL` appropriate; monitor worker/queue health via `/api/v1/health/workers`.

## 15. Production boot validation (enforced)

The server refuses to boot in production when:
- `AUTH_COOKIE_SECURE` is `false`
- `CORS_CREDENTIALS` is `false`
- Required core secrets are missing/invalid for production (including `JWT_ACCESS_SECRET`, `OTP_HMAC_SECRET` not set to placeholder/missing, `TOTP_ENCRYPTION_KEY` missing)
- Other existing production constraints fail (e.g. `FRONTEND_URL` required/https, `EMAIL_PROVIDER` must be `smtp`/`brevo-api`, conditional integration requirements)

See `src/config/env.ts` (`superRefine`) for the authoritative validation rules.
