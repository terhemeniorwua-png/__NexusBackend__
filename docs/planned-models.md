# Planned database models (Phase 2.1 audit)

This document records the database models that Phase 2 intentionally deferred. It is a design reference, not a migration plan. Exact fields, relations, constraints and indexes will be defined in the phase that implements each model.

## Audit result

Phase 2.1 audited the Prisma schema against this list on 2026-11-01. The deferred models are **not a Phase 2 defect**:

- No implemented module, route, service or test in Phases 1–6 requires the deferred models.
- The models belong to later roadmap phases and depend on business rules that do not exist yet.
- Creating unused tables now would commit the schema to fields, relations and lifecycle rules before those phases are designed.
- `prisma/schema.prisma` already states that planned models are intentionally absent, and Phase 2 was documented as implementing only the core relational foundation.
- The Phase 4 email webhook needs are covered by the provider-specific `EmailWebhookEvent` model. Generic `WebhookSubscription` and `WebhookDelivery` remain Phase 20 work.
- Meeting-related `NotificationType` values are forward-looking enum documentation. They do not indicate that meeting tables should exist yet.

No Prisma schema or migration change was made by this audit.

## Implemented core models

The current schema contains the following models:

- Identity: `User`, `UserProfile`, `Session`, `AuthToken`
- Workspaces: `Workspace`, `WorkspaceMembership`, `Invitation`
- Teams: `Team`, `TeamMembership`
- Projects: `Project`, `ProjectMembership`
- Tasks and collaboration: `Task`, `TaskAssignee`, `TaskDependency`, `Comment`, `FileAttachment`
- Notifications and audit: `Notification`, `AuditLog`
- Email delivery: `EmailDelivery`, `EmailSuppression`, `EmailWebhookEvent`

## Deferred models

| Roadmap phase | Models | Dependency / reason for deferral |
|---|---|---|
| Phase 12/13 — Real-time and messaging | `Conversation`, `ConversationMembership`, `Message`, `MessageReaction`, `MessageAttachment`, `MessageReadReceipt`, `PresenceRecord` | Requires conversation membership rules, message permissions, attachment storage and real-time delivery contracts. |
| Phase 14 — Notifications (extensions) | `NotificationPreference` | Requires user-facing notification preference rules. |
| Phase 16 — Calendar and scheduling | `CalendarEvent`, `Reminder`, `RecurrenceRule` | Requires scheduling, reminder delivery and recurrence semantics. |
| Phase 17 — Meetings | `Meeting`, `MeetingParticipant`, `MeetingInvitation`, `CallRecord` | Requires the calling provider, participant authorization, meeting lifecycle and call-history rules. |
| Phase 18 — AI | `AiConversation`, `AiMessage`, `AiUsageRecord`, `AiArtifact` | Requires the AI service layer, authorization-aware context retrieval, usage tracking and artifact retention rules. |
| Phase 19 — Automation and background jobs | `AutomationRule`, `BackgroundJob`, `JobRun` | Requires queue infrastructure, retry/idempotency rules and durable job-status requirements. |
| Phase 20 — Integrations | `Integration`, `IntegrationCredential`, `WebhookSubscription`, `WebhookDelivery` | Requires the integration provider model, credential storage rules and outbound webhook delivery semantics. |

## Change policy

- Implement a deferred model only when its roadmap phase and required business rules are explicitly authorized.
- Add the corresponding Prisma migration, indexes, constraints and tests in that phase.
- Do not add placeholder tables merely to make this document appear complete.
- Update this document when a deferred model is implemented or its roadmap phase changes.
