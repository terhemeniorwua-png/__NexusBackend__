# Planned database models

This document records database models that are intentionally **not** part of the
current Prisma schema. It is a design reference, not a migration plan. Exact
fields, relations, constraints and indexes are defined in the phase that
implements each model.

The authoritative implementation status is always `prisma/schema.prisma`,
`PHASES.md`, and the migrations in `prisma/migrations`.

## Current status

The core platform schema is implemented. Models that were previously deferred
have been delivered by their roadmap phases and are listed here only so the
historical mapping is clear; they are **not** planned models any more.

| Roadmap phase | Models | Status |
|---|---|---|
| Phase 10 — Real-time messaging | `Channel`, `ChannelMembership`, `Message`, `MessageReaction`, `MessageReadReceipt` | Implemented |
| Phase 11 — Notifications | `Notification`, `NotificationPreference` | Implemented |
| Phase 12 — Files | `FileAttachment` | Implemented |
| Phase 13 — Documents | `Document`, `DocumentRevision`, `DocumentComment` | Implemented |
| Phase 14 — Calendar | `CalendarEvent`, `EventInvitation` | Implemented |
| Phase 15 — Meetings | `Meeting`, `MeetingParticipant` | Implemented |
| Phase 16 — Forms | `Form`, `FormField`, `FormResponse`, `FormAnswer` | Implemented |
| Phase 17 — Billing | `Subscription`, `PaystackPlan`, `BillingCheckout`, `BillingPayment`, `BillingWebhookEvent`, `BillingSeatSync`, `BillingCancellation` | Implemented |
| Phase 18 — Search | `SearchHistory` | Implemented |
| Phase 19 — Integrations and webhooks | `Integration`, `IntegrationSyncJob`, `WebhookSubscription`, `WebhookDelivery` | Implemented |
| Phase 20 — Automation | `Automation`, `AutomationRun` | Implemented |

## Deferred models

| Roadmap phase | Models | Dependency / reason for deferral |
|---|---|---|
| Phase 21 — Python AI service | `AiConversation`, `AiMessage`, `AiUsageRecord`, `AiArtifact` | Requires the AI service contract, authorization-aware context retrieval, usage accounting, artifact retention, and Express-to-Python persistence boundaries. Python must not write to the main application database by default. |
| Phase 23 — AI action approval and execution | `AiActionProposal`, `AiActionApproval` (names provisional) | Requires the AI action taxonomy, approval expiry, duplicate-execution prevention, and the Express-side revalidation and execution contract. No approval record should exist until the action types are agreed. |

Phase 22 (Nexus Write) is expected to use the Phase 21 AI service contract.
Any persistence it needs will be designed and migrated with that phase rather
than pre-created here.

## Change policy

- Implement a deferred model only when its roadmap phase is authorised.
- Add the corresponding Prisma model, migration, indexes, constraints and tests
  in that phase.
- Do not add placeholder tables merely to make this document appear complete.
- Update this document when a deferred model is implemented or its roadmap
  phase changes.
- `PHASES.md` is the roadmap source of truth; this document does not redefine
  phase numbering.

## Phase 7 notification preferences

`NotificationPreference` stores per-workspace, per-member settings for each
existing `NotificationType`. Preferences control creation of durable in-app
notification records; all types are enabled by default. Email delivery and
message unread state are unaffected.
