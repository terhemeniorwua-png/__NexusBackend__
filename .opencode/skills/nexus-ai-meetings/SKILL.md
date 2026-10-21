---
name: nexus-ai-meetings
description: Specialized instructions for implementing AI-powered meetings in the Nexus backend, including scheduling, participants, meeting integrations, transcription, summaries, action items, task creation, authorization, and meeting-related notifications.
---

# Nexus AI Meetings Skill

## 1. Purpose

This skill defines how AI-powered meeting functionality must be designed, implemented, tested, and maintained in the Nexus backend.

Nexus is a real-time workspace and project management platform combining project management, collaborative documentation, messaging, task management, notifications, meetings, and AI-assisted workflows.

AI Meetings should help teams conduct meetings, preserve decisions, extract actionable work, and connect discussions to the appropriate Nexus projects and tasks.

The implementation must prioritize security, participant privacy, accurate information, data integrity, and a reliable user experience.

Follow this skill whenever implementing or modifying meeting-related or AI-powered meeting functionality.

## 2. Technology Stack

Use the existing project configuration as the source of truth.

- Runtime: Node.js
- Backend: Express.js
- Language: TypeScript
- Database: PostgreSQL
- ORM: Prisma
- Real-time communication: Socket.IO
- Cache and temporary coordination: Redis
- AI provider: Use the provider already configured in the project, if one exists.
- Audio/video: Use an existing or explicitly approved WebRTC-compatible meeting provider or conferencing service.

Do not replace existing technologies or introduce additional providers without a clear technical justification and appropriate approval.

Do not assume that Socket.IO alone provides audio/video conferencing. Socket.IO can coordinate meeting events, while media transport requires an appropriate WebRTC implementation or conferencing provider.

## 3. Inspect Before Implementing

Before changing AI Meetings functionality:

1. Read `agent.md` and `PHASES.md`.
2. Inspect `package.json` and existing dependencies.
3. Review the Prisma schema and existing meeting-related models.
4. Inspect authentication, workspace membership, project permissions, and role enforcement.
5. Check existing notification, email, file-storage, and Socket.IO services.
6. Inspect any existing AI provider integration and environment configuration.
7. Identify the relevant phase and its acceptance criteria.

Reuse existing implementations wherever possible.

Do not create duplicate meeting models, notification services, AI clients, or real-time gateways.

Do not overwrite existing features to make the new implementation easier.

## 4. Core Meeting Features

Design the system to support the meeting capabilities required by the Nexus product.

Potential features include:

- Scheduling meetings.
- Creating instant meetings.
- Editing and cancelling meetings.
- Managing meeting participants and invitations.
- Joining and leaving meetings.
- Tracking participant attendance.
- Linking meetings to workspaces, teams, and projects.
- Meeting descriptions, agendas, and attachments.
- Meeting reminders and notifications.
- Recording references or recordings where supported and authorized.
- Transcription of recorded or live audio where supported.
- AI-generated summaries and decisions.
- Extracted action items.
- Linking action items to Nexus tasks.
- Searching authorized meeting summaries and transcripts.

Implement only the capabilities required by the current phase. Do not claim that audio/video, live transcription, or recording works unless the necessary infrastructure is implemented and tested.

## 5. Meeting Data Model

Use Prisma and PostgreSQL for persistent meeting records.

Inspect existing models before introducing new ones.

Depending on the actual requirements, the domain may include:

- Meeting.
- MeetingParticipant.
- MeetingInvitation.
- MeetingAgendaItem.
- MeetingRecording.
- MeetingTranscript.
- MeetingSummary.
- MeetingActionItem.
- MeetingAIJob.
- Meeting-related notification or audit records.

These are conceptual entities, not a requirement to create every model.

Establish explicit relationships to the relevant users, workspaces, projects, and tasks.

For every model, define:

- Primary keys.
- Required and optional fields.
- Foreign-key relationships.
- Unique constraints.
- Indexes.
- Creation and update timestamps.
- Ownership and authorization rules.
- Retention and deletion behavior.

Use appropriate enums for stable meeting states, such as scheduled, in progress, completed, and cancelled.

Represent meeting start and end times consistently, using appropriate timezone-aware timestamps and preserving the intended scheduling timezone when necessary.

Prevent invalid meeting times and duplicate participant memberships.

Use database transactions for operations involving multiple dependent writes.

Create migrations through the established Prisma workflow. Never reset a shared database or delete migration history to implement meeting functionality.

## 6. Meeting Scheduling and Lifecycle

Implement a clear meeting lifecycle.

A typical lifecycle may include:

1. A meeting is created.
2. Participants are invited.
3. Participants accept, decline, or otherwise respond when supported.
4. The meeting begins.
5. Attendance and participation events are recorded where appropriate.
6. The meeting ends.
7. Transcription or recording processing runs when enabled.
8. AI generates summaries and action items when requested or configured.
9. Results are made available to authorized participants.
10. Related tasks, notifications, and project records are updated where appropriate.

Treat this as a proposed workflow, not a requirement to introduce unnecessary status transitions.

Requirements:

- Validate the meeting creator's permissions.
- Verify that participants are eligible to join.
- Validate meeting times and scheduling constraints.
- Handle cancellations and rescheduling consistently.
- Prevent unauthorized participants from joining private meetings.
- Handle repeated join, leave, and completion events safely.
- Avoid duplicate reminders and processing jobs.
- Make lifecycle transitions explicit and testable.

Do not trust a client-supplied user ID to establish the identity of the meeting participant.

## 7. Real-Time Meeting Integration

Use the existing Socket.IO architecture for real-time signaling and application events where appropriate.

Possible events include:

- Meeting created or updated.
- Participant invited.
- Participant joined or left.
- Meeting started or ended.
- Transcript segment available.
- AI summary processing completed.
- Action items generated.

Requirements:

- Authenticate socket connections.
- Authorize access to each meeting room.
- Validate event payloads.
- Ensure users cannot subscribe to unauthorized meeting rooms.
- Avoid exposing private meeting content through broadcast events.
- Handle reconnects and repeated events safely.
- Persist important events or records when they must survive disconnections.
- Do not treat socket delivery as proof that an event was permanently stored.

Use an appropriate WebRTC implementation or conferencing provider for audio/video.

Never assume that creating a Socket.IO room automatically establishes secure media transport.

Keep media credentials, provider secrets, and privileged meeting tokens on the server.

## 8. Participant Permissions and Meeting Privacy

Meeting access must respect Nexus's multi-workspace authorization model.

Before allowing access to meeting details, transcripts, recordings, or AI outputs, verify:

- The authenticated user.
- The meeting's workspace and ownership.
- The user's relevant workspace or project membership.
- Meeting-specific participation rules.
- The user's role and permissions.
- Any applicable recording or transcript access restrictions.

Do not assume that belonging to a workspace automatically grants access to every private meeting or recording.

Do not rely on frontend checks to protect meeting data.

Enforce authorization in the backend service layer and, where appropriate, in database access patterns.

Ensure that a user from one workspace cannot retrieve another workspace's meetings by changing an ID in an API request.

Apply the same access rules to AI summaries, transcripts, recordings, exports, search results, and generated action items.

## 9. Recording, Transcription, and Consent

Recording and transcription must be explicit, privacy-aware features.

Requirements:

- Follow applicable laws, organizational policies, and provider requirements.
- Clearly communicate when recording or transcription is active.
- Obtain the necessary consent or authorization before recording or transcribing.
- Record consent or recording-state events where required.
- Restrict recording and transcript access to authorized users.
- Use secure storage for recordings and transcript files.
- Avoid exposing permanent public URLs for private recordings.
- Use expiring signed URLs or an equivalent secure access mechanism when supported.
- Define retention and deletion policies.
- Avoid retaining audio longer than necessary.
- Do not silently activate recording or transcription.

Do not claim that consent requirements are satisfied merely because a meeting participant has joined.

If the required consent workflow or recording provider is not yet implemented, report that limitation clearly.

## 10. AI Provider Integration

Use a dedicated AI service rather than embedding provider-specific logic in route handlers.

The AI service should accept only the authorized input required for a particular operation.

Possible operations include:

- Summarizing a transcript.
- Extracting decisions.
- Identifying action items.
- Producing meeting notes.
- Suggesting task titles and descriptions.
- Identifying unresolved questions.
- Generating follow-up suggestions.

Requirements:

- Reuse the existing AI provider configuration when available.
- Keep API keys in environment variables or the approved secret-management system.
- Apply request timeouts and reasonable input limits.
- Handle provider errors, rate limits, and temporary outages.
- Avoid sending unnecessary personal or confidential information.
- Do not expose provider credentials to clients.
- Validate and normalize AI outputs before saving them.
- Track processing status and failures where needed.
- Do not claim that an AI operation succeeded if the provider request failed.

Never hardcode AI API keys or commit secrets to version control.

## 11. AI Summaries and Decisions

Generate summaries from the actual authorized meeting content.

A summary may contain:

- Meeting purpose.
- Main discussion points.
- Important decisions.
- Unresolved questions.
- Risks or blockers.
- Follow-up actions.
- Relevant projects and tasks.

Requirements:

- Do not invent facts, decisions, attendees, or commitments.
- Distinguish explicit decisions from AI-generated suggestions.
- Preserve relevant context when summarizing technical discussions.
- Avoid presenting uncertain conclusions as established facts.
- Support empty, incomplete, or poor-quality transcripts.
- Associate each summary with the correct meeting and source transcript version.
- Track generation status and timestamps.
- Allow authorized users to review and correct generated summaries where required.
- Regenerate summaries when the source changes, without creating uncontrolled duplicates.

AI-generated content is a draft for review, not automatically an authoritative record of what happened.

## 12. Action Item Extraction and Task Creation

AI should identify possible action items from the meeting transcript or summary.

An action item may include:

- Title.
- Description.
- Suggested assignee.
- Due date.
- Related project.
- Priority.
- Supporting transcript excerpt or timestamp, when available.
- Extraction confidence or review status, where useful.

Requirements:

- Distinguish an explicit commitment from a suggestion.
- Do not invent assignees or due dates.
- Verify that proposed assignees are eligible members of the relevant workspace or project.
- Validate project and task relationships.
- Respect the existing Nexus task workflow and task status rules.
- Require appropriate authorization before creating or assigning tasks.
- Provide a review or confirmation step before automatically creating consequential work.
- Prevent duplicate tasks when the same AI job is retried.
- Preserve traceability to the source meeting and action item.

Do not silently create tasks, assign users, or change project permissions solely because the AI suggested doing so.

When an action item becomes a task, persist the relationship between the task and the originating meeting or action item when the data model supports it.

## 13. AI Input and Output Security

Treat transcripts, meeting descriptions, attachments, and AI outputs as potentially untrusted content.

A participant may say or share content designed to manipulate an AI model. Such content must not override system instructions or backend authorization rules.

Requirements:

- Never allow transcript instructions to override server-side security policies.
- Do not let AI decide whether a user is authorized to access a meeting.
- Do not execute arbitrary commands generated by AI.
- Validate structured output against a schema.
- Treat generated IDs, roles, assignments, and permissions as untrusted suggestions.
- Avoid passing unnecessary secrets or credentials to AI providers.
- Prevent private content from being included in another workspace's AI context.
- Sanitize generated content before rendering it in HTML or other executable contexts.

AI output must pass normal business validation before affecting persistent application data.

## 14. Background Processing

Long-running tasks should not unnecessarily block API requests.

Where supported by the existing infrastructure, use background jobs for:

- Transcription processing.
- Summary generation.
- Action item extraction.
- Recording processing.
- Large meeting exports.
- Retrying failed AI requests.

Use the existing queue and worker architecture if available.

Requirements:

- Track pending, processing, completed, and failed states as appropriate.
- Prevent duplicate processing where possible.
- Use bounded retries for transient failures.
- Avoid retrying permanent failures indefinitely.
- Make jobs idempotent.
- Record useful failure information without logging sensitive transcript content unnecessarily.
- Keep the source meeting and processing job associated.
- Ensure workers recheck authorization and data availability where necessary.

For important operations that must not be lost between a database write and job scheduling, consider a transactional outbox or another reliable dispatch pattern.

Do not introduce a queue system without first inspecting the existing infrastructure and current project requirements.

## 15. Meeting Notifications and Emails

Integrate with the existing Nexus notification and emailing services.

Potential notifications include:

- Meeting invitations.
- Meeting reminders.
- Meeting updates and cancellations.
- Participant responses.
- AI summary availability.
- Action items awaiting review.
- Assigned follow-up tasks.

Requirements:

- Respect notification preferences where applicable.
- Verify the intended recipient.
- Avoid sending duplicate notifications.
- Use the existing email templates and notification records.
- Keep real-time notifications separate from durable notification storage.
- Handle email delivery failures without corrupting meeting data.
- Do not send private transcript content in an email unless the feature explicitly requires it and access is appropriately controlled.

Do not build an independent notification system solely for AI Meetings.

## 16. API Design and Validation

Follow the existing Express route, controller, service, validation, and error-handling conventions.

Possible API capabilities include:

- Creating and updating meetings.
- Listing authorized meetings.
- Managing invitations and participants.
- Starting and ending meetings.
- Retrieving meeting summaries.
- Requesting summary generation.
- Reviewing extracted action items.
- Converting approved action items into tasks.
- Retrieving authorized transcript metadata.

These are examples; follow the actual API structure and phase requirements.

Requirements:

- Validate request bodies, query parameters, and identifiers.
- Enforce authentication and authorization on every protected operation.
- Apply pagination and sensible limits.
- Validate meeting lifecycle transitions.
- Return consistent API response formats.
- Handle missing records and invalid states appropriately.
- Do not expose stack traces, secrets, raw provider responses, or internal infrastructure details.
- Do not trust client-provided ownership, workspace IDs, or role assignments.

## 17. Performance and Cost Management

AI processing, recording storage, and transcription can be expensive.

Requirements:

- Set reasonable transcript and input size limits.
- Avoid processing the same transcript repeatedly without a reason.
- Track job status and processing attempts.
- Use appropriate pagination for meeting lists and transcript retrieval.
- Select only the fields required by the operation.
- Avoid N+1 database queries.
- Use indexes for common workspace, participant, meeting status, and scheduling lookups.
- Reuse existing caching infrastructure where justified.
- Consider model choice, token usage, audio duration, and provider pricing.
- Apply appropriate limits to expensive AI operations.
- Avoid keeping entire recordings or transcripts in application memory unnecessarily.

Do not introduce arbitrary quotas that conflict with existing product requirements. Propose limits based on the intended deployment and business model.

## 18. Testing

Use the project's existing test framework.

### Database and service tests

Test:

- Meeting creation and updates.
- Participant and workspace relationships.
- Meeting lifecycle transitions.
- Authorization boundaries.
- Invitation acceptance and cancellation.
- Transaction consistency.
- Duplicate event and job handling.

### Real-time tests

Test:

- Socket authentication.
- Meeting room authorization.
- Join and leave behavior.
- Unauthorized event rejection.
- Reconnection and repeated event handling.

### AI tests

Test:

- Successful summary generation.
- Empty or incomplete transcripts.
- Invalid structured AI output.
- Provider errors and rate limits.
- Duplicate job execution.
- Unsupported or fabricated action item fields.
- Task creation requiring review and authorization.

### Privacy and security tests

Test:

- Cross-workspace access denial.
- Unauthorized transcript and recording access.
- Invalid or expired meeting access credentials.
- Recording consent requirements.
- Unauthorized task assignment.
- Prompt injection attempts within meeting content.

Mock external AI, email, media, and conferencing providers during automated tests where appropriate.

Never run tests that record real participants or send unintended real emails.

## 19. Required Implementation Workflow

For every AI Meetings task:

1. Inspect `agent.md`, `PHASES.md`, and existing implementation.
2. Identify the current phase and its acceptance criteria.
3. Determine the required meeting, participant, and workspace relationships.
4. Define permissions, privacy requirements, and lifecycle transitions.
5. Identify which external providers or services are actually available.
6. Plan schema, migration, API, and real-time changes.
7. Implement the smallest coherent set of changes.
8. Add AI processing, validation, and background jobs only where required.
9. Add notifications using existing services.
10. Write tests for successful, invalid, unauthorized, and failed operations.
11. Run schema validation, relevant tests, and applicable build checks.
12. Document provider configuration, limitations, and deployment requirements.
13. Update `PHASES.md` only when the associated acceptance criteria are genuinely satisfied.

## 20. Definition of Done

An AI Meetings feature is complete when all applicable requirements are satisfied:

- Meeting records and relationships are correct.
- Authentication and authorization are enforced.
- Workspace isolation is verified.
- Meeting lifecycle behavior is consistent.
- AI inputs and outputs are validated.
- Summaries and action items are traceable to their source.
- Task creation respects the existing task workflow.
- Recording and transcription follow the required consent and privacy rules.
- Background jobs handle retries and duplicate execution safely.
- Notifications use existing Nexus services.
- Required migrations are generated and reviewed.
- Relevant tests pass, or remaining failures are clearly documented.
- No credentials or sensitive meeting data are unnecessarily exposed.
- Documentation reflects the implemented behavior and remaining limitations.

## 21. Required Agent Behavior

Always inspect the existing codebase before implementing a meeting or AI feature.

Do not assume that a media provider, AI provider, transcription service, or background queue is configured unless the repository confirms it.

Do not replace existing functionality unnecessarily.

Do not claim that a feature works end to end when only its database schema or API endpoint has been implemented.

Before destructive changes or production recording-related changes, explain the risks and obtain appropriate approval.

After completing a task, report:

- What functionality was implemented.
- Which models, services, routes, and events changed.
- Which external integrations are required.
- Which environment variables must be configured.
- Which tests were run and their results.
- Any incomplete work, privacy concerns, or deployment steps remaining.
