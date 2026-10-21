---
inclusion: always
---

# Nexus Backend — Kiro Steering

## Project Instructions

This is the Nexus backend: a Node.js + Express + TypeScript + PostgreSQL (Prisma) + Redis + Socket.IO platform.

Read `AGENTS.md` at the repository root before every session. It contains the authoritative development rules, technology stack, security requirements, and definition of done.

## Phase Workflow

Before implementing any feature:

1. Open `PHASES.md` and identify the current phase (look for `[/]` or the highest `[x]` phase).
2. Read the phase's objective, deliverables, and verification criteria.
3. Load the relevant skill for the domain being implemented (see **Skills** below).
4. Implement only the requested scope. Do not begin the next phase without explicit instruction.
5. After verifying the work, update `PHASES.md` status and report results.

**Current progress:** Phases 1–5 complete. Phase 6 (Roles and Authorization) is next.

## Skills (load on demand)

| Skill command      | Use when…                                                      |
|--------------------|----------------------------------------------------------------|
| `/nexus-backend`   | General backend features, architecture decisions, any phase    |
| `/nexus-database`  | Prisma schema, migrations, queries, Redis, indexes             |
| `/nexus-emailing`  | Transactional email, templates, outbox, webhook verification   |
| `/nexus-realtime`  | Socket.IO, messaging, presence, real-time events               |
| `/nexus-testing`   | Tests, CI, deployment, quality checks                          |
| `/nexus-meetings`  | AI meetings, calling SDK, transcription                        |

## Repository Safety Rules

- Never overwrite `.env` files or expose secrets.
- Never run destructive database operations without explicit approval.
- Do not implement application features unless explicitly instructed.
- Do not advance the phase number without verified acceptance criteria.
- Keep all backend code in TypeScript. The project uses `src/server.ts` and `src/app.ts`; stale `.js` files in `src/` are superseded.
- The Prisma client lives in `src/db/prisma.ts`. Do not use Sequelize.
