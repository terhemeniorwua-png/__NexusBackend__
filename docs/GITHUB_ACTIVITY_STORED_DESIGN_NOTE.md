# Design note: stored GitHub activity (docs only)

**Status:** Design note (no implementation, no schema/migration changes in this document’s scope).  
**Repo base (for reference):** report current `origin/main` SHA at time of writing (e.g. run `git rev-parse --short origin/main`) before publishing this note alongside work.  
**Scope:** Stored GitHub activity/history mirrored from webhooks alongside existing live fetch paths. This is a **design** document only.

---

## Decision (required)

**Keep live fetch AND add stored history from the `push` webhook.** GitHub remains the **source of truth**; **PITERON mirrors** derived/activity records for querying, feeds, and reporting. Live fetch remains the fallback/completeness mechanism where appropriate (e.g. UI that must reflect current GitHub state when no mirror row exists yet), but the product should prefer stored mirrors for timeline/reporting performance and consistency once ingested.

Rationale (summary): webhook-driven storage gives durable, queryable activity (commit history, branch movement context) without depending on ad-hoc API calls; live fetch continues to protect against gaps (missed deliveries, initial state) while GitHub stays authoritative.

---

## 1. Add `push` to `github-webhook.service.ts`

- **Extend event handling** in `src/modules/dev-integrations/github-webhook.service.ts` (and its delivery pipeline) to accept GitHub **`push`** events in addition to existing handled events.
- **Reuse signature verification and idempotency** using the existing **`GitHubWebhookDelivery`** (or equivalent delivery-record) mechanism:
  - Verify HMAC/signature using the same secret path as today.
  - Use the same **delivery id** (`X-GitHub-Delivery`) for **deduplication/idempotency**: if already processed successfully, treat as no-op (or idempotent success) per current policy.
- **Redelivery:** GitHub may redeliver the same delivery id; must be **idempotent** (no duplicate `RepositoryCommit` rows; safe re-application of branch/tip updates where applicable).
- **Force-push:** `before`/`after` SHAs may indicate history rewrite; ingestion must **not** assume linear history. Policy (design): store commits present in the payload that are new/missing by `(repository, sha)`; do **not** delete historical mirror rows solely because a force-push occurred unless an explicit retention/cleanup job is defined later. If `after` is all zeros (branch delete) see below.
- **Branch create/delete:** 
  - **Create:** `created === true` (or `ref` newly created) with valid `after`; upsert branch tracking to point at `after` (and record default/base context only if provided).
  - **Delete:** `deleted === true` or `after` is the zero SHA (`000...0`); mark branch tracking as **deleted/removed** (or clear tip) without deleting already-stored commit rows (they remain historical mirrors).
- **Tag pushes:** If `ref` starts with `refs/tags/`, **do not** treat as branch activity for the branch-tracking model; either **ignore** for branch tip state or store under a separate “ref kind = tag” path (design choice: **ignore branch tracking for tags in v1**, but still consider whether to store tag push metadata later). Recommendation: **skip commit ingestion tied to branch feed for tags in v1** unless product explicitly requires tag history; document as open question if needed.
- **Very large pushes (GitHub caps commits per payload):** GitHub may truncate `commits` (and provide `head_commit` / compare URLs). Design must:
  - Ingest **only what is present** in the payload (bounded work per delivery).
  - Persist a **delivery/push marker** indicating **truncation risk** when signals suggest incomplete commit list (e.g. presence of `forced` with large diff context not enumerable, or documented GitHub behavior: if more than ~20 commits, payload may include limited commits — treat any push where `commits.length === 0` but `after` != zero and `compare` exists as “metadata-only / possibly truncated list”; store push envelope metadata and **do not** invent commits).
  - Never block the webhook handler on external backfill in the request path beyond optional enqueue; **live fetch** can be used later for reconciliation (see §6).

---

## 2. Model (design)

**RepositoryCommit** (mirror of commit facts from push delivery context):
- Identity: **unique (`repository`, `sha`)** (e.g. `repository` = `owner/repo` normalized lowercase per existing conventions).
- Fields (minimum): `repository` (string), `sha` (string, full 40-char hex preferred), `message` (text, **length capped**, see below), `authorName` (string), `authorLogin` (string, nullable if not provided by GitHub payload in that form), `committedAt` (timestamptz), `branch` (string, nullable for non-branch ref cases), `htmlUrl`/`url` (string, nullable), optional **`taskId`** (FK/null, informational link only — §3).
- **Message length caps:** enforce a maximum (e.g. **4096 chars**) on stored `message`; truncate with an explicit marker in stored form or store a separate `messageTruncated` flag. Do not store unbounded payload text.
- **Author emails:** **do not store author emails** from GitHub payloads in PITERON’s mirrored tables for this feature. Store **`authorLogin`** when available; `authorName` may be stored as display-only from payload. Any email present in webhook payloads must be **dropped** at ingestion (privacy §5).
- **Indexes (suggested):** `(`repository`, committedAt DESC)`, `(`repository`, sha) unique`, `(`taskId`)` where not null (sparse index behavior per DB), optional `(`branch`, committedAt DESC)` for feed queries. Exact DDL in implementation/migration review.

**Branch tracking** (design): a small table or denormalized state keyed by (`repository`, `branchName`) storing `tipSha`, `updatedAt`, and status (`active` | `deleted`) to support “latest activity per branch” views without scanning all commits. Must be updated transactionally/consistently with commit upserts where feasible; webhook ordering is not guaranteed globally—use last-write-wins by `updatedAt`/delivery time only as a heuristic and prefer `after` semantics when the event is a clear tip advance for that ref.

**Retention:** define a policy before broad rollout (design options): e.g. retain N days or N commits per repo, or retain indefinitely with size monitoring. Must be documented and enforced by a **scheduled job** (not inside webhook request path). For v1 design, recommend **time-based retention** (e.g. 90–365 days, configurable) plus an index strategy to keep deletes efficient; **open item** to confirm product/legal retention requirements.

---

## 3. Linking commits to tasks (message reference)

- **Reference format (proposed, informational only):** recognize one primary token pattern in commit message (case-insensitive), e.g. **`PIT-<digits>`** or the workspace/project task key format already used in Nexus (confirm canonical form from `Task.key` / existing conventions). Example regex intent: match `\b([A-Z][A-Z0-9]+-\d+)\b` as a candidate key; normalization: uppercase key, trim surrounding punctuation.
- **Multiple references:** if a message contains **multiple distinct** task keys, **link the commit to all matched tasks** that **resolve** to the same repository’s linked project context **only when unambiguous** (see below); otherwise record **no automatic `taskId` links** for ambiguous cases and optionally store raw matched keys in a non-authoritative field for future review (design choice: avoid wrong links).
- **Ambiguity rules (must be explicit):**
  - A key is **linkable** only if it resolves to a **Task** that belongs to a **Project** that has a **Dev link** / integration context consistent with the **repository** in the push (same `owner/repo`, same GitHub connection/workspace rules as existing task dev links).
  - If the same key string could refer to different tasks across workspaces/projects in a way that cannot be resolved from repository context, **do not link** (treat as ambiguous).
  - If multiple different keys appear and **all** resolve unambiguously to tasks in the **same allowed project scope** for that repo, link to **all** (many-to-many via join table or repeated rows pattern — prefer a join `RepositoryCommitTask` for clarity).
  - Linking is **best-effort** at ingest time; manual correction is out of scope for v1 design unless noted.
- **Hard rule:** linking commits to tasks is **informational only** and **must never change task status**, assignments, reviews, submissions, or any workflow state. No audit events that imply workflow transitions from commit linking.

---

## 4. Activity feed route and “developer activity” report

**Activity feed route (stored):**
- New read API (design): e.g. `GET .../github/activity` or nested under project/workspace with filters (`repository`, `branch`, `since`, `until`, `taskId`, pagination). **Authorization:** same workspace/project access rules as existing GitHub/dev-link surfaces; only users who may view the linked project/repository context may read stored commit activity (see §5).
- Response should include mirrored commit fields plus **link metadata** (resolved task keys/ids when present) and **source = `stored`** (or equivalent) for clients.

**“Developer activity” report:** define metric sources explicitly:
- **From stored commits (primary for historical reporting once available):** commit counts per author/login per period, commits per branch/repo, first/last seen in window, commits linked to tasks (counts), optional “lines not available” note (payload does not reliably provide stats in all cases — do not fabricate). Use `RepositoryCommit.committedAt` and stored fields.
- **From live data (GitHub API):** use only for **on-demand verification**, **backfill preview**, or when stored data is missing and user explicitly requests refresh; **do not** make the scheduled/report pipeline depend on live calls as the default source of truth after mirror exists. Live may also supply richer fields (additions/deletions) if fetched separately—treat as **optional enrichment**, not required for v1 stored model.

Reporting must label or internally distinguish **stored mirror coverage** (e.g. “data since webhook enablement / backfill date”) to avoid misleading “all history” claims.

---

## 5. Privacy

- **Who may read commits:** access is **tied to repository/project permissions** already enforced for GitHub integrations and task dev links. In practice:
  - Users with **read access** to the workspace/project (and any role that can view the linked GitHub repo context in the product) may read stored commit mirrors for that scope.
  - **Do not** expose stored commits for repositories not linked/visible in the user’s authorized context. This depends on the existing **repository permissions note** in product/docs: mirror visibility must be **no broader** than the integration/link visibility rules already defined.
- **Author emails:** **never store author emails** in `RepositoryCommit` (or related mirror tables) from webhook payloads. Store **`authorLogin`** when present; store `authorName` as a display string only if useful. Any `author.email`-style fields in GitHub push payloads must be **dropped at ingestion** and must not appear in logs at sensitive detail level. If future compliance requires email handling, that is a **separate decision** (not part of this design).

---

## 6. Backfill

- **Default (recommended):** **no automatic full backfill** from Git history on enablement (avoids heavy API usage, rate limits, and ambiguity). Rely on **live fetch** for historical views when mirrors are absent, and on **push webhooks going forward** to populate stored history.
- **Optional bounded initial sync:** if product requires, allow an **operator/admin-triggered**, **bounded** initial sync from live GitHub API (e.g. last N commits per default branch, capped by repo count and time window), with:
  - explicit feature flag / admin action,
  - rate-limit awareness and idempotent upserts by `(repository, sha)`,
  - clear UI labeling (“partial history synced”).
- This design does **not** mandate backfill; implementation must not start unbounded background backfill from webhooks.

---

## 7. Audit events only; constraints, tests, open questions

- **Audit events only (for this feature surface):** record audit entries for **administrative/configuration** effects if any (e.g. enabling/storing behavior changes) using existing audit patterns, but **do not** create audit spam for every ingested commit. Commit ingestion is a **data mirror** operation, not a user-initiated privileged action requiring per-commit audit rows. Any workflow linkage (§3) must remain **informational only** (no status-change audits).
- **Raw-SQL CHECKs (design intent, no migration in this note):** if modeled in SQL, consider **CHECK** constraints such as non-empty `repository`/`sha` format hints where enforceable, `message` length already enforced in app + optionally DB `char_length(message) <= N`, and enum-like constraints for branch status. Prefer **application validation + Prisma/schema rules** consistent with repo conventions; any raw SQL CHECKs must follow existing migration discipline and be reviewed separately.
- **Tests plan (design):**
  - Unit: signature reuse, delivery idempotency for `push`, parsing of `created`/`deleted`/`forced`, truncation/metadata-only cases, task-key extraction and ambiguity rules (§3), message truncation and email stripping.
  - Integration: webhook handler with mocked Prisma/DB for insert + unique conflict on `(repository, sha)`, branch tracking upsert/delete behavior, authorization on read routes (§5).
  - Negative: oversized/odd payload shapes, unknown refs, tag pushes ignored per policy.
- **Open questions:**
  1. Canonical task key regex and whether to support multiple key formats per workspace.
  2. Exact retention duration and legal hold interaction.
  3. Whether to store tags at all (separate table) in a later phase.
  4. Whether `authorLogin` is always present for all push authors (bot/anonymous cases) and fallback display rules.
  5. Whether “developer activity” report is workspace-scoped, repo-scoped, or both, and required aggregations for MVP.
  6. Operational alerting for high push volume / idempotency table growth.

---

*End of design note.*