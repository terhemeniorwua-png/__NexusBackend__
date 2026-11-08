# Phase 7 team communication access: channel dependency plan

> **Status update — 2026-11-05:** This document records the original dependency
> assessment and is superseded for channel access by the owner-approved Phase 7
> implementation. Channel and ChannelMembership access records, policy, metadata
> routes, audit/notification integration, and lifecycle cleanup are implemented
> and verified. Message persistence and delivery, threads, reactions, and
> attachments remain assigned to the messaging phase.

**Original status (superseded):** Blocked pending the Phase 10 messaging/channel domain contract. At the time, no channel subsystem was present in `src/modules`, Prisma schema, or registered routes. Phase 7 explicitly required team association with channels where permitted and team-level communication access; the approved access-only channel integration now satisfies that dependency. Message functionality remains assigned to the messaging phase.

## Existing boundaries

- Phase 7 owns team membership and organizational authorization.
- Phase 10 owns real-time messaging and conversations, including the channel resource.
- Current Phase 7 project access checks team/department membership dynamically. That policy does not define channel visibility, message access, or channel membership.
- A channel model or route added independently here would establish a second, speculative messaging contract.

## Required inputs before implementation

1. Phase 10's authoritative channel entity, lifecycle, channel types and visibility rules.
2. Whether channels belong directly to a workspace, a team, a project, or support more than one parent.
3. Whether team membership grants channel access automatically, only for team-bound channels, or through explicit channel membership.
4. How private channels, guests, organization administrators, removed team members and archived teams affect existing channel access.
5. Whether channel membership is a separate persisted relation and which actions create its audit/activity records.

## Implementation sequence once the contract exists

1. Add the Phase 10 channel schema and migrations, with workspace and optional team/project foreign keys and constraints defined by the approved contract.
2. Add channel lifecycle and membership services/routes in the messaging module, enforcing workspace isolation and private-channel rules.
3. Reuse Phase 7 team membership in a channel authorization policy; make removal revoke inherited access dynamically or transactionally synchronize explicit channel memberships according to the approved decision.
4. Apply channel authorization to message listing, sending, attachments, events, unread counts and search, not only channel metadata routes.
5. Add PostgreSQL tests for team-bound access, non-member denial, membership removal, private channels, guests, cross-workspace references, project visibility, and transaction/concurrency behavior.
6. Update `docs/API.md`, `docs/openapi.yaml`, and Phase 7/10 progress only after the integrated paths are implemented and verified.

This was the original implementation boundary before channel access was approved as Phase 7 work. The current Phase 7 completion record supersedes this final status; do not interpret it as a blocker to channel metadata access or as authorization to build messaging functionality outside its own phase.
