# Planned database models (Phase 2 placeholder)

Phase 2 focuses on the core models required to establish workspaces, teams, projects, tasks, comments, invitations, notifications, files, and audit logs. The following models are intentionally not implemented yet and will be designed in later phases as specified by the roadmap.

## Phase 12/13 — Real-time and messaging
- `Conversation`
- `ConversationMembership`
- `Message`
- `MessageReaction`
- `MessageAttachment`
- `MessageReadReceipt`
- `PresenceRecord`

## Phase 14 — Notifications (extensions)
- `NotificationPreference`

## Phase 16 — Calendar and scheduling
- `CalendarEvent`
- `Reminder`
- `RecurrenceRule`

## Phase 17 — Meetings
- `Meeting`
- `MeetingParticipant`
- `MeetingInvitation`
- `CallRecord`

## Phase 18 — AI
- `AiConversation`
- `AiMessage`
- `AiUsageRecord`
- `AiArtifact`

## Phase 19 — Automation and background jobs
- `AutomationRule`
- `BackgroundJob`
- `JobRun`

## Phase 20 — Integrations
- `Integration`
- `IntegrationCredential`
- `WebhookSubscription`
- `WebhookDelivery`

Notes:
- Exact fields, relations, constraints, and indexes will be defined in their respective phases.
- These remain out of scope for Phase 2; schema includes only forward-looking documentation to avoid premature migration churn.
