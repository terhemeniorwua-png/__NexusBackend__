# API Contract Status

Audit of routes registered in `src/routes/index.ts` and module route files versus `docs/openapi.yaml`.

- Registered HTTP routes audited: **411**
- Registered routes missing from OpenAPI (path+method): **156**
- OpenAPI entries not registered in current route mounts: **6** (see notes)
- "implemented?" reflects route handler registration in code (yes = mounted/declared). "returns placeholder?" based on handler scan for 501/not-implemented/placeholder responses.

## HTTP routes

| module | route | in OpenAPI? | implemented? | returns placeholder? | has tests? |
|---|---|---:|---:|---:|---:|
| ai | `GET /ai/actions/proposals` | yes | yes | no | yes |
| ai | `POST /ai/actions/proposals` | yes | yes | no | yes |
| ai | `GET /ai/actions/proposals/:proposalId` | yes | yes | no | yes |
| ai | `POST /ai/actions/proposals/:proposalId/approve` | yes | yes | no | yes |
| ai | `POST /ai/actions/proposals/:proposalId/cancel` | yes | yes | no | yes |
| ai | `POST /ai/actions/proposals/:proposalId/execute` | yes | yes | no | yes |
| ai | `POST /ai/actions/proposals/:proposalId/reject` | yes | yes | no | yes |
| ai | `POST /ai/chat` | yes | yes | no | yes |
| ai | `POST /ai/chat/stream` | yes | yes | no | yes |
| ai | `GET /ai/conversations` | yes | yes | no | yes |
| ai | `DELETE /ai/conversations/:conversationId` | yes | yes | no | yes |
| ai | `GET /ai/conversations/:conversationId` | yes | yes | no | yes |
| ai | `GET /ai/health` | yes | yes | no | yes |
| ai | `POST /ai/knowledge/search` | no | yes | no | yes |
| ai | `POST /ai/meetings/:meetingId/summarize` | no | yes | no | yes |
| ai | `POST /ai/personal/daily-plan` | no | yes | no | yes |
| ai | `GET /ai/personal/tasks` | no | yes | no | yes |
| ai | `POST /ai/personal/weekly-report` | no | yes | no | yes |
| ai | `POST /ai/projects/intelligence` | no | yes | no | yes |
| ai | `POST /ai/summarize` | no | yes | no | yes |
| ai | `POST /ai/tasks/generate` | no | yes | no | yes |
| ai | `POST /ai/tasks/generate/confirm` | no | yes | no | yes |
| ai | `GET /ai/usage` | yes | yes | no | yes |
| ai | `POST /ai/writing/analyze` | yes | yes | no | yes |
| ai | `POST /ai/writing/rewrite` | yes | yes | no | yes |
| ai | `POST /ai/writing/sessions/:sessionId/accept` | yes | yes | no | yes |
| ai | `POST /ai/writing/sessions/:sessionId/dismiss` | yes | yes | no | yes |
| ai | `POST /ai/writing/summarize` | yes | yes | no | yes |
| ai | `POST /ai/writing/translate` | yes | yes | no | yes |
| analytics | `GET /analytics` | yes | yes | no | yes |
| auth | `POST /auth/2fa/challenge` | yes | yes | no | yes |
| auth | `POST /auth/2fa/confirm` | yes | yes | no | yes |
| auth | `POST /auth/2fa/disable` | yes | yes | no | yes |
| auth | `POST /auth/2fa/recovery-codes` | yes | yes | no | yes |
| auth | `POST /auth/2fa/setup` | yes | yes | no | yes |
| auth | `POST /auth/deactivate` | yes | yes | no | yes |
| auth | `POST /auth/delete` | yes | yes | no | yes |
| auth | `POST /auth/email/change` | yes | yes | no | yes |
| auth | `POST /auth/email/change/confirm` | yes | yes | no | yes |
| auth | `POST /auth/email/resend` | yes | yes | no | yes |
| auth | `POST /auth/email/verify` | yes | yes | no | yes |
| auth | `GET /auth/google` | yes | yes | no | yes |
| auth | `GET /auth/google/callback` | yes | yes | no | yes |
| auth | `POST /auth/google/exchange` | yes | yes | no | yes |
| auth | `POST /auth/login` | yes | yes | no | yes |
| auth | `POST /auth/logout` | yes | yes | no | yes |
| auth | `POST /auth/logout-all` | yes | yes | no | yes |
| auth | `GET /auth/me` | yes | yes | no | yes |
| auth | `POST /auth/password/change` | yes | yes | no | yes |
| auth | `POST /auth/password/forgot` | yes | yes | no | yes |
| auth | `POST /auth/password/reset` | yes | yes | no | yes |
| auth | `POST /auth/reactivate` | yes | yes | no | yes |
| auth | `POST /auth/refresh` | yes | yes | no | yes |
| auth | `POST /auth/register` | yes | yes | no | yes |
| auth | `POST /auth/resend-verification` | yes | yes | no | yes |
| auth | `GET /auth/sessions` | yes | yes | no | yes |
| auth | `POST /auth/verify-email` | yes | yes | no | yes |
| billing | `GET /billing/plans` | yes | yes | no | yes |
| billing | `GET /billing/workspaces/:workspaceId` | yes | yes | no | yes |
| billing | `POST /billing/workspaces/:workspaceId/cancel` | yes | yes | no | yes |
| billing | `POST /billing/workspaces/:workspaceId/change` | yes | yes | no | yes |
| billing | `POST /billing/workspaces/:workspaceId/checkout` | yes | yes | no | yes |
| billing | `GET /billing/workspaces/:workspaceId/payments` | yes | yes | no | yes |
| billing | `POST /billing/workspaces/:workspaceId/verify` | yes | yes | no | yes |
| dev-integrations | `GET /dev-integrations` | no | yes | no | yes |
| dev-integrations | `POST /dev-integrations` | no | yes | no | yes |
| dev-integrations | `DELETE /dev-integrations/:devLinkId` | no | yes | no | yes |
| dev-integrations | `DELETE /dev-integrations/:repositoryId` | no | yes | no | yes |
| dev-integrations | `GET /dev-integrations/:repositoryId/branches` | no | yes | no | yes |
| dev-integrations | `GET /dev-integrations/:repositoryId/pull-requests` | no | yes | no | yes |
| dev-integrations | `GET /dev-integrations/connections` | no | yes | no | yes |
| dev-integrations | `DELETE /dev-integrations/connections/:connectionId` | no | yes | no | yes |
| dev-integrations | `GET /dev-integrations/connections/:connectionId/repos` | no | yes | no | yes |
| dev-integrations | `GET /dev-integrations/github/callback` | no | yes | no | yes |
| dev-integrations | `GET /dev-integrations/github/start` | no | yes | no | yes |
| dev-integrations | `GET /dev-integrations/gitlab/callback` | no | yes | no | yes |
| dev-integrations | `GET /dev-integrations/gitlab/start` | no | yes | no | yes |
| routes | `GET /health` | yes | yes | no | yes |
| routes | `GET /health/live` | yes | yes | no | yes |
| routes | `GET /health/ready` | yes | yes | no | yes |
| routes | `GET /health/workers` | yes | yes | no | yes |
| integrations | `GET /integrations` | yes | yes | no | yes |
| integrations | `POST /integrations` | yes | yes | no | yes |
| integrations | `GET /integrations/${p.path}/authorize` | no | yes | no | yes |
| integrations | `GET /integrations/${p.path}/callback` | no | yes | no | yes |
| integrations | `DELETE /integrations/:integrationId` | yes | yes | no | yes |
| integrations | `PATCH /integrations/:integrationId` | yes | yes | no | yes |
| integrations | `POST /integrations/:integrationId/refresh` | yes | yes | no | yes |
| integrations | `POST /integrations/:integrationId/sync` | yes | yes | no | yes |
| integrations | `GET /integrations/:integrationId/sync-jobs` | yes | yes | no | yes |
| integrations | `POST /integrations/:integrationId/sync-jobs/:jobId/retry` | yes | yes | no | yes |
| integrations | `GET /integrations/dropbox/authorize` | yes | yes | no | yes |
| integrations | `GET /integrations/dropbox/callback` | yes | yes | no | yes |
| integrations | `GET /integrations/github/authorize` | no | yes | no | yes |
| integrations | `GET /integrations/github/callback` | no | yes | no | yes |
| integrations | `GET /integrations/gmail/authorize` | yes | yes | no | yes |
| integrations | `GET /integrations/gmail/callback` | yes | yes | no | yes |
| integrations | `GET /integrations/google-calendar/authorize` | no | yes | no | yes |
| integrations | `GET /integrations/google-calendar/callback` | no | yes | no | yes |
| integrations | `GET /integrations/google-drive/authorize` | yes | yes | no | yes |
| integrations | `GET /integrations/google-drive/callback` | yes | yes | no | yes |
| integrations | `GET /integrations/outlook-calendar/authorize` | no | yes | no | yes |
| integrations | `GET /integrations/outlook-calendar/callback` | no | yes | no | yes |
| integrations | `GET /integrations/slack/authorize` | yes | yes | no | yes |
| integrations | `GET /integrations/slack/callback` | yes | yes | no | yes |
| integrations | `GET /integrations/slack/default-callback` | yes | yes | no | yes |
| workspaces | `GET /invitations` | yes | yes | no | yes |
| workspaces | `GET /invitations/:token` | yes | yes | no | yes |
| workspaces | `POST /invitations/:token/accept` | yes | yes | no | yes |
| workspaces | `POST /invitations/:token/decline` | yes | yes | no | yes |
| workspaces | `GET /invitations/:token/verify` | yes | yes | no | yes |
| notifications | `GET /notifications` | no | yes | no | yes |
| notifications | `GET /notifications/activity/:workspaceId` | no | yes | no | yes |
| notifications | `GET /notifications/preferences/:workspaceId` | no | yes | no | yes |
| notifications | `PUT /notifications/preferences/:workspaceId` | no | yes | no | yes |
| notifications | `POST /notifications/read` | no | yes | no | yes |
| notifications | `POST /notifications/read-all` | no | yes | no | yes |
| notifications | `GET /notifications/unread-count` | no | yes | no | yes |
| privacy | `POST /privacy-requests` | yes | yes | no | yes |
| privacy | `POST /privacy-requests/:requestId/complete` | yes | yes | no | yes |
| privacy | `POST /privacy-requests/:requestId/decision` | yes | yes | no | yes |
| privacy | `POST /privacy-requests/:requestId/redactions` | yes | yes | no | yes |
| privacy | `POST /privacy-requests/:requestId/review` | yes | yes | no | yes |
| privacy | `GET /privacy-requests/mine` | yes | yes | no | yes |
| privacy | `GET /privacy-requests/mine/:requestId` | yes | yes | no | yes |
| privacy | `GET /privacy-requests/review` | yes | yes | no | yes |
| search | `GET /search` | yes | yes | no | yes |
| search | `DELETE /search/recent` | yes | yes | no | yes |
| search | `GET /search/recent` | yes | yes | no | yes |
| search | `GET /search/suggestions` | yes | yes | no | yes |
| users | `GET /users/me` | yes | yes | no | yes |
| users | `PATCH /users/me` | yes | yes | no | yes |
| users | `DELETE /users/me/avatar` | yes | yes | no | yes |
| users | `GET /users/me/avatar` | yes | yes | no | yes |
| users | `POST /users/me/avatar` | yes | yes | no | yes |
| webhooks | `POST /webhooks/email` | yes | yes | no | yes |
| webhooks | `POST /webhooks/email/:token` | yes | yes | no | yes |
| dev-integrations | `POST /webhooks/github` | no | yes | no | yes |
| dev-integrations | `POST /webhooks/gitlab` | no | yes | no | yes |
| billing | `POST /webhooks/paystack` | yes | yes | no | yes |
| workspaces | `GET /workspaces` | yes | yes | no | yes |
| workspaces | `POST /workspaces` | yes | yes | no | yes |
| workspaces | `DELETE /workspaces/:workspaceId` | yes | yes | no | yes |
| workspaces | `GET /workspaces/:workspaceId` | yes | yes | no | yes |
| workspaces | `PATCH /workspaces/:workspaceId` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/admin-owner/:userId` | no | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/archive` | yes | yes | no | yes |
| audit | `GET /workspaces/:workspaceId/audit` | yes | yes | no | yes |
| automation | `GET /workspaces/:workspaceId/automations` | yes | yes | no | yes |
| automation | `POST /workspaces/:workspaceId/automations` | yes | yes | no | yes |
| automation | `DELETE /workspaces/:workspaceId/automations/:automationId` | yes | yes | no | yes |
| automation | `GET /workspaces/:workspaceId/automations/:automationId` | yes | yes | no | yes |
| automation | `PATCH /workspaces/:workspaceId/automations/:automationId` | yes | yes | no | yes |
| automation | `GET /workspaces/:workspaceId/automations/:automationId/runs` | yes | yes | no | yes |
| automation | `POST /workspaces/:workspaceId/automations/:automationId/runs/:runId/retry` | yes | yes | no | yes |
| channels | `GET /workspaces/:workspaceId/channels` | yes | yes | no | yes |
| channels | `POST /workspaces/:workspaceId/channels` | yes | yes | no | yes |
| channels | `DELETE /workspaces/:workspaceId/channels/:channelId` | yes | yes | no | yes |
| channels | `GET /workspaces/:workspaceId/channels/:channelId` | yes | yes | no | yes |
| channels | `PATCH /workspaces/:workspaceId/channels/:channelId` | yes | yes | no | yes |
| channels | `POST /workspaces/:workspaceId/channels/:channelId/archive` | yes | yes | no | yes |
| channels | `POST /workspaces/:workspaceId/channels/:channelId/members` | yes | yes | no | yes |
| channels | `DELETE /workspaces/:workspaceId/channels/:channelId/members/:userId` | yes | yes | no | yes |
| messaging | `GET /workspaces/:workspaceId/channels/:channelId/messages` | no | yes | no | yes |
| messaging | `POST /workspaces/:workspaceId/channels/:channelId/messages` | no | yes | no | yes |
| messaging | `DELETE /workspaces/:workspaceId/channels/:channelId/messages/:messageId` | no | yes | no | yes |
| messaging | `PATCH /workspaces/:workspaceId/channels/:channelId/messages/:messageId` | no | yes | no | yes |
| messaging | `GET /workspaces/:workspaceId/channels/:channelId/messages/:messageId/audio` | no | yes | no | yes |
| messaging | `POST /workspaces/:workspaceId/channels/:channelId/messages/:messageId/pin` | no | yes | no | yes |
| messaging | `DELETE /workspaces/:workspaceId/channels/:channelId/messages/:messageId/reactions` | no | yes | no | yes |
| messaging | `POST /workspaces/:workspaceId/channels/:channelId/messages/:messageId/reactions` | no | yes | no | yes |
| messaging | `POST /workspaces/:workspaceId/channels/:channelId/messages/:messageId/read` | no | yes | no | yes |
| messaging | `GET /workspaces/:workspaceId/channels/:channelId/messages/:messageId/replies` | no | yes | no | yes |
| messaging | `POST /workspaces/:workspaceId/channels/:channelId/messages/:messageId/unpin` | no | yes | no | yes |
| messaging | `GET /workspaces/:workspaceId/channels/:channelId/unread-count` | no | yes | no | yes |
| messaging | `POST /workspaces/:workspaceId/channels/:channelId/voice` | no | yes | no | yes |
| organizations | `GET /workspaces/:workspaceId/company-profile` | yes | yes | no | yes |
| organizations | `PATCH /workspaces/:workspaceId/company-profile` | yes | yes | no | yes |
| workspaces | `GET /workspaces/:workspaceId/departments` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/departments` | yes | yes | no | yes |
| workspaces | `PATCH /workspaces/:workspaceId/departments/:departmentId` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/departments/:departmentId/members` | yes | yes | no | yes |
| workspaces | `DELETE /workspaces/:workspaceId/departments/:departmentId/members/:targetUserId` | yes | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/dev-integrations` | no | yes | no | yes |
| dev-integrations | `POST /workspaces/:workspaceId/dev-integrations` | no | yes | no | yes |
| dev-integrations | `DELETE /workspaces/:workspaceId/dev-integrations/:devLinkId` | no | yes | no | yes |
| dev-integrations | `DELETE /workspaces/:workspaceId/dev-integrations/:repositoryId` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/dev-integrations/:repositoryId/branches` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/dev-integrations/:repositoryId/pull-requests` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/dev-integrations/connections` | no | yes | no | yes |
| dev-integrations | `DELETE /workspaces/:workspaceId/dev-integrations/connections/:connectionId` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/dev-integrations/connections/:connectionId/repos` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/dev-integrations/github/callback` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/dev-integrations/github/start` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/dev-integrations/gitlab/callback` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/dev-integrations/gitlab/start` | no | yes | no | yes |
| documents | `GET /workspaces/:workspaceId/documents` | no | yes | no | yes |
| documents | `POST /workspaces/:workspaceId/documents` | no | yes | no | yes |
| documents | `DELETE /workspaces/:workspaceId/documents/:documentId` | no | yes | no | yes |
| documents | `GET /workspaces/:workspaceId/documents/:documentId` | no | yes | no | yes |
| documents | `PATCH /workspaces/:workspaceId/documents/:documentId` | no | yes | no | yes |
| documents | `GET /workspaces/:workspaceId/documents/:documentId/comments` | no | yes | no | yes |
| documents | `POST /workspaces/:workspaceId/documents/:documentId/comments` | no | yes | no | yes |
| documents | `DELETE /workspaces/:workspaceId/documents/:documentId/comments/:commentId` | no | yes | no | yes |
| documents | `GET /workspaces/:workspaceId/documents/:documentId/revisions` | no | yes | no | yes |
| calendar | `GET /workspaces/:workspaceId/events` | no | yes | no | yes |
| calendar | `POST /workspaces/:workspaceId/events` | no | yes | no | yes |
| calendar | `DELETE /workspaces/:workspaceId/events/:eventId` | no | yes | no | yes |
| calendar | `GET /workspaces/:workspaceId/events/:eventId` | no | yes | no | yes |
| calendar | `PATCH /workspaces/:workspaceId/events/:eventId` | no | yes | no | yes |
| calendar | `POST /workspaces/:workspaceId/events/:eventId/cancel` | no | yes | no | yes |
| calendar | `GET /workspaces/:workspaceId/events/:eventId/invitations` | no | yes | no | yes |
| calendar | `POST /workspaces/:workspaceId/events/:eventId/invitations` | no | yes | no | yes |
| calendar | `DELETE /workspaces/:workspaceId/events/:eventId/invitations/:userId` | no | yes | no | yes |
| calendar | `POST /workspaces/:workspaceId/events/:eventId/respond` | no | yes | no | yes |
| files | `GET /workspaces/:workspaceId/files` | no | yes | no | yes |
| files | `POST /workspaces/:workspaceId/files` | no | yes | no | yes |
| files | `DELETE /workspaces/:workspaceId/files/:fileId` | no | yes | no | yes |
| files | `GET /workspaces/:workspaceId/files/:fileId` | no | yes | no | yes |
| files | `GET /workspaces/:workspaceId/files/usage` | no | yes | no | yes |
| forms | `GET /workspaces/:workspaceId/forms` | no | yes | no | yes |
| forms | `POST /workspaces/:workspaceId/forms` | no | yes | no | yes |
| forms | `DELETE /workspaces/:workspaceId/forms/:formId` | no | yes | no | yes |
| forms | `GET /workspaces/:workspaceId/forms/:formId` | no | yes | no | yes |
| forms | `PATCH /workspaces/:workspaceId/forms/:formId` | no | yes | no | yes |
| forms | `POST /workspaces/:workspaceId/forms/:formId/fields` | no | yes | no | yes |
| forms | `GET /workspaces/:workspaceId/forms/:formId/responses` | no | yes | no | yes |
| forms | `POST /workspaces/:workspaceId/forms/:formId/responses` | no | yes | no | yes |
| organizations | `GET /workspaces/:workspaceId/institution-groups` | yes | yes | no | yes |
| organizations | `POST /workspaces/:workspaceId/institution-groups` | yes | yes | no | yes |
| organizations | `DELETE /workspaces/:workspaceId/institution-groups/:groupId` | yes | yes | no | yes |
| organizations | `PATCH /workspaces/:workspaceId/institution-groups/:groupId` | yes | yes | no | yes |
| organizations | `GET /workspaces/:workspaceId/institution-groups/:groupId/members` | yes | yes | no | yes |
| organizations | `POST /workspaces/:workspaceId/institution-groups/:groupId/members` | yes | yes | no | yes |
| organizations | `DELETE /workspaces/:workspaceId/institution-groups/:groupId/members/:userId` | yes | yes | no | yes |
| organizations | `PATCH /workspaces/:workspaceId/institution-groups/:groupId/members/:userId` | yes | yes | no | yes |
| organizations | `GET /workspaces/:workspaceId/institution-profile` | yes | yes | no | yes |
| organizations | `PATCH /workspaces/:workspaceId/institution-profile` | yes | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/integrations/dev/github/callback` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/integrations/dev/gitlab/callback` | no | yes | no | yes |
| workspaces | `GET /workspaces/:workspaceId/invitations` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/invitations` | yes | yes | no | yes |
| workspaces | `DELETE /workspaces/:workspaceId/invitations/:invitationId` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/invitations/:invitationId/resend` | yes | yes | no | yes |
| workspaces | `DELETE /workspaces/:workspaceId/join-code` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/join-code` | yes | yes | no | yes |
| workspaces | `GET /workspaces/:workspaceId/join-requests` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/join-requests` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/join-requests/:requestId/approve` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/join-requests/:requestId/reject` | yes | yes | no | yes |
| meetings | `GET /workspaces/:workspaceId/meetings` | no | yes | no | yes |
| meetings | `POST /workspaces/:workspaceId/meetings` | no | yes | no | yes |
| meetings | `DELETE /workspaces/:workspaceId/meetings/:meetingId` | no | yes | no | yes |
| meetings | `GET /workspaces/:workspaceId/meetings/:meetingId` | no | yes | no | yes |
| meetings | `PATCH /workspaces/:workspaceId/meetings/:meetingId` | no | yes | no | yes |
| meetings | `POST /workspaces/:workspaceId/meetings/:meetingId/decline` | no | yes | no | yes |
| meetings | `POST /workspaces/:workspaceId/meetings/:meetingId/host/end` | no | yes | no | yes |
| meetings | `POST /workspaces/:workspaceId/meetings/:meetingId/host/mute-all` | no | yes | no | yes |
| meetings | `POST /workspaces/:workspaceId/meetings/:meetingId/host/remove` | no | yes | no | yes |
| meetings | `POST /workspaces/:workspaceId/meetings/:meetingId/join` | no | yes | no | yes |
| meetings | `POST /workspaces/:workspaceId/meetings/:meetingId/leave` | no | yes | no | yes |
| meetings | `GET /workspaces/:workspaceId/meetings/:meetingId/participants` | no | yes | no | yes |
| meetings | `POST /workspaces/:workspaceId/meetings/:meetingId/participants` | no | yes | no | yes |
| meetings | `DELETE /workspaces/:workspaceId/meetings/:meetingId/participants/:userId` | no | yes | no | yes |
| meetings | `POST /workspaces/:workspaceId/meetings/:meetingId/token` | no | yes | no | yes |
| workspaces | `GET /workspaces/:workspaceId/members` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/members` | yes | yes | no | yes |
| workspaces | `DELETE /workspaces/:workspaceId/members/:userId` | yes | yes | no | yes |
| workspaces | `PATCH /workspaces/:workspaceId/members/:userId` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/members/:userId/restore` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/members/:userId/suspend` | yes | yes | no | yes |
| organizations | `GET /workspaces/:workspaceId/notification-preferences` | yes | yes | no | yes |
| organizations | `PATCH /workspaces/:workspaceId/notification-preferences` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/owner-transfers/:transferId/accept` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/owner-transfers/:transferId/billing-acceptance` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/owner-transfers/:transferId/reject` | yes | yes | no | yes |
| workspaces | `PATCH /workspaces/:workspaceId/owner/:userId` | yes | yes | no | yes |
| projects | `GET /workspaces/:workspaceId/project-roles` | no | yes | no | yes |
| projects | `GET /workspaces/:workspaceId/projects` | yes | yes | no | yes |
| projects | `POST /workspaces/:workspaceId/projects` | yes | yes | no | yes |
| projects | `DELETE /workspaces/:workspaceId/projects/:projectId` | yes | yes | no | yes |
| projects | `GET /workspaces/:workspaceId/projects/:projectId` | yes | yes | no | yes |
| projects | `PATCH /workspaces/:workspaceId/projects/:projectId` | yes | yes | no | yes |
| projects | `GET /workspaces/:workspaceId/projects/:projectId/activity` | yes | yes | no | yes |
| projects | `POST /workspaces/:workspaceId/projects/:projectId/archive` | yes | yes | no | yes |
| projects | `GET /workspaces/:workspaceId/projects/:projectId/members` | yes | yes | no | yes |
| projects | `POST /workspaces/:workspaceId/projects/:projectId/members` | yes | yes | no | yes |
| projects | `DELETE /workspaces/:workspaceId/projects/:projectId/members/:userId` | yes | yes | no | yes |
| projects | `PATCH /workspaces/:workspaceId/projects/:projectId/members/:userId` | yes | yes | no | yes |
| projects | `GET /workspaces/:workspaceId/projects/:projectId/milestones` | yes | yes | no | yes |
| projects | `POST /workspaces/:workspaceId/projects/:projectId/milestones` | yes | yes | no | yes |
| projects | `DELETE /workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId` | yes | yes | no | yes |
| projects | `PATCH /workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId` | yes | yes | no | yes |
| projects | `PATCH /workspaces/:workspaceId/projects/:projectId/organizational-access` | yes | yes | no | yes |
| projects | `GET /workspaces/:workspaceId/projects/:projectId/permissions` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/repositories` | no | yes | no | yes |
| dev-integrations | `POST /workspaces/:workspaceId/projects/:projectId/repositories` | no | yes | no | yes |
| dev-integrations | `DELETE /workspaces/:workspaceId/projects/:projectId/repositories/:devLinkId` | no | yes | no | yes |
| dev-integrations | `DELETE /workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId/branches` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId/pull-requests` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/repositories/connections` | no | yes | no | yes |
| dev-integrations | `DELETE /workspaces/:workspaceId/projects/:projectId/repositories/connections/:connectionId` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/repositories/connections/:connectionId/repos` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/repositories/github/callback` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/repositories/github/start` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/repositories/gitlab/callback` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/repositories/gitlab/start` | no | yes | no | yes |
| projects | `POST /workspaces/:workspaceId/projects/:projectId/restore` | yes | yes | no | yes |
| tasks | `GET /workspaces/:workspaceId/projects/:projectId/custom-fields` | yes | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/custom-fields` | yes | yes | no | yes |
| tasks | `PATCH /workspaces/:workspaceId/projects/:projectId/custom-fields/:fieldId` | yes | yes | no | yes |
| tasks | `DELETE /workspaces/:workspaceId/projects/:projectId/custom-fields/:fieldId` | yes | yes | no | yes |
| tasks | `GET /workspaces/:workspaceId/projects/:projectId/task-views` | yes | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/task-views` | yes | yes | no | yes |
| tasks | `PATCH /workspaces/:workspaceId/projects/:projectId/task-views/:viewId` | yes | yes | no | yes |
| tasks | `DELETE /workspaces/:workspaceId/projects/:projectId/task-views/:viewId` | yes | yes | no | yes |
| tasks | `GET /workspaces/:workspaceId/projects/:projectId/task-templates` | yes | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/task-templates` | yes | yes | no | yes |
| tasks | `PATCH /workspaces/:workspaceId/projects/:projectId/task-templates/:templateId` | yes | yes | no | yes |
| tasks | `DELETE /workspaces/:workspaceId/projects/:projectId/task-templates/:templateId` | yes | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/task-templates/:templateId/create-task` | yes | yes | no | yes |
| projects | `GET /workspaces/:workspaceId/project-templates` | yes | yes | no | yes |
| projects | `POST /workspaces/:workspaceId/project-templates` | yes | yes | no | yes |
| projects | `PATCH /workspaces/:workspaceId/project-templates/:templateId` | yes | yes | no | yes |
| projects | `DELETE /workspaces/:workspaceId/project-templates/:templateId` | yes | yes | no | yes |
| projects | `POST /workspaces/:workspaceId/project-templates/:templateId/create-project` | yes | yes | no | yes |
| tasks | `GET /workspaces/:workspaceId/projects/:projectId/tasks` | no | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/tasks` | no | yes | no | yes |
| tasks | `DELETE /workspaces/:workspaceId/projects/:projectId/tasks/:taskId` | no | yes | no | yes |
| tasks | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId` | no | yes | no | yes |
| tasks | `PATCH /workspaces/:workspaceId/projects/:projectId/tasks/:taskId` | no | yes | no | yes |
| tasks | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/activity` | no | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/archive` | no | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/assignees` | no | yes | no | yes |
| tasks | `DELETE /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/assignees/:userId` | no | yes | no | yes |
| task-blockers | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/blockers` | no | yes | no | yes |
| task-blockers | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/blockers` | no | yes | no | yes |
| task-blockers | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/blockers/:blockerId/resolve` | no | yes | no | yes |
| tasks | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/comments` | no | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/comments` | no | yes | no | yes |
| tasks | `DELETE /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/comments/:commentId` | no | yes | no | yes |
| tasks | `PATCH /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/comments/:commentId` | no | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/complete` | no | yes | no | yes |
| tasks | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/custom-fields` | yes | yes | no | yes |
| tasks | `PUT /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/custom-fields` | yes | yes | no | yes |
| tasks | `DELETE /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/recurrence` | yes | yes | no | yes |
| tasks | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/recurrence` | yes | yes | no | yes |
| tasks | `PUT /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/recurrence` | yes | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/recurrence/generate` | yes | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dependencies` | no | yes | no | yes |
| tasks | `DELETE /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dependencies/:dependsOnTaskId` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links` | no | yes | no | yes |
| dev-integrations | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links` | no | yes | no | yes |
| dev-integrations | `DELETE /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links/:devLinkId` | no | yes | no | yes |
| dev-integrations | `DELETE /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links/:repositoryId` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links/:repositoryId/branches` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links/:repositoryId/pull-requests` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links/connections` | no | yes | no | yes |
| dev-integrations | `DELETE /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links/connections/:connectionId` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links/connections/:connectionId/repos` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links/github/callback` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links/github/start` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links/gitlab/callback` | no | yes | no | yes |
| dev-integrations | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/dev-links/gitlab/start` | no | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/reopen` | no | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/restore` | no | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/review` | no | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/submit` | no | yes | no | yes |
| tasks | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/subtasks/:subtaskId/complete` | no | yes | no | yes |
| task-time-entries | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/time-entries` | no | yes | no | yes |
| task-time-entries | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/time-entries` | no | yes | no | yes |
| task-time-entries | `DELETE /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/time-entries/:entryId` | no | yes | no | yes |
| task-time-entries | `PATCH /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/time-entries/:entryId` | no | yes | no | yes |
| task-work-documents | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/work-documents` | no | yes | no | yes |
| task-work-documents | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/work-documents` | no | yes | no | yes |
| task-work-documents | `DELETE /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/work-documents/:documentId` | no | yes | no | yes |
| task-work-documents | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/work-documents/:documentId` | no | yes | no | yes |
| task-work-documents | `PATCH /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/work-documents/:documentId` | no | yes | no | yes |
| task-work-documents | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/work-documents/:documentId/versions` | no | yes | no | yes |
| task-work-documents | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/work-documents/:documentId/versions/:version` | no | yes | no | yes |
| task-work-documents | `POST /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/work-documents/:documentId/versions/:version/restore` | no | yes | no | yes |
| tasks | `GET /workspaces/:workspaceId/projects/:projectId/tasks/:taskId/workspace` | no | yes | no | yes |
| projects | `POST /workspaces/:workspaceId/projects/:projectId/transfer-ownership` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/restore` | yes | yes | no | yes |
| workspaces | `POST /workspaces/:workspaceId/switch` | yes | yes | no | yes |
| teams | `GET /workspaces/:workspaceId/teams` | yes | yes | no | yes |
| teams | `POST /workspaces/:workspaceId/teams` | yes | yes | no | yes |
| teams | `DELETE /workspaces/:workspaceId/teams/:teamId` | yes | yes | no | yes |
| teams | `GET /workspaces/:workspaceId/teams/:teamId` | yes | yes | no | yes |
| teams | `PATCH /workspaces/:workspaceId/teams/:teamId` | yes | yes | no | yes |
| teams | `POST /workspaces/:workspaceId/teams/:teamId/archive` | yes | yes | no | yes |
| teams | `GET /workspaces/:workspaceId/teams/:teamId/invitations` | yes | yes | no | yes |
| teams | `POST /workspaces/:workspaceId/teams/:teamId/invitations` | yes | yes | no | yes |
| teams | `DELETE /workspaces/:workspaceId/teams/:teamId/invitations/:invitationId` | yes | yes | no | yes |
| teams | `PATCH /workspaces/:workspaceId/teams/:teamId/lead` | yes | yes | no | yes |
| teams | `GET /workspaces/:workspaceId/teams/:teamId/members` | yes | yes | no | yes |
| teams | `POST /workspaces/:workspaceId/teams/:teamId/members` | yes | yes | no | yes |
| teams | `DELETE /workspaces/:workspaceId/teams/:teamId/members/:userId` | yes | yes | no | yes |
| teams | `PATCH /workspaces/:workspaceId/teams/:teamId/members/:userId` | yes | yes | no | yes |
| webhooks | `GET /workspaces/:workspaceId/webhooks` | yes | yes | no | yes |
| webhooks | `POST /workspaces/:workspaceId/webhooks` | yes | yes | no | yes |
| webhooks | `DELETE /workspaces/:workspaceId/webhooks/:webhookId` | yes | yes | no | yes |
| webhooks | `PATCH /workspaces/:workspaceId/webhooks/:webhookId` | yes | yes | no | yes |
| webhooks | `GET /workspaces/:workspaceId/webhooks/:webhookId/deliveries` | yes | yes | no | yes |
| webhooks | `POST /workspaces/:workspaceId/webhooks/:webhookId/deliveries/:deliveryId/retry` | yes | yes | no | yes |
| workspaces | `GET /workspaces/discover` | yes | yes | no | yes |
| workspaces | `POST /workspaces/join` | yes | yes | no | yes |
| workspaces | `DELETE /workspaces/join-requests/:requestId` | yes | yes | no | yes |
| workspaces | `GET /workspaces/join-requests/mine` | yes | yes | no | yes |
| workspaces | `GET /workspaces/owner-transfers/incoming` | yes | yes | no | yes |

## OpenAPI-only (not currently registered)

| method | path | openapi path | note |
|---|---|---|---|
| GET | `/workspaces/:workspaceId/company-profile/logo` | `/workspaces/{workspaceId}/company-profile/logo` | not found in current `src/routes/index.ts`/`src/app.ts` mounted route inventory; removed from OpenAPI to match reality |
| POST | `/workspaces/:workspaceId/company-profile/logo` | `/workspaces/{workspaceId}/company-profile/logo` | not found in current `src/routes/index.ts`/`src/app.ts` mounted route inventory; removed from OpenAPI to match reality |
| DELETE | `/workspaces/:workspaceId/company-profile/logo` | `/workspaces/{workspaceId}/company-profile/logo` | not found in current `src/routes/index.ts`/`src/app.ts` mounted route inventory; removed from OpenAPI to match reality |
| GET | `/workspaces/:workspaceId/institution-profile/logo` | `/workspaces/{workspaceId}/institution-profile/logo` | not found in current `src/routes/index.ts`/`src/app.ts` mounted route inventory; removed from OpenAPI to match reality |
| POST | `/workspaces/:workspaceId/institution-profile/logo` | `/workspaces/{workspaceId}/institution-profile/logo` | not found in current `src/routes/index.ts`/`src/app.ts` mounted route inventory; removed from OpenAPI to match reality |
| DELETE | `/workspaces/:workspaceId/institution-profile/logo` | `/workspaces/{workspaceId}/institution-profile/logo` | not found in current `src/routes/index.ts`/`src/app.ts` mounted route inventory; removed from OpenAPI to match reality |

## Socket.IO (realtime)

Implemented in `src/realtime/socket-server.ts` (server) and `src/modules/messaging/message.service.ts` (`message:new` emit). Documented in `docs/openapi.yaml` under `x-socketio`.

| event | direction | payload shape | notes |
|---|---|---|---|
| `connection` auth | client -> server (handshake) | `auth: { token: string (JWT access), workspaceId?: string }` | required; connection rejected on missing/invalid token |
| `workspace:join` | client -> server | `workspaceId: string` | joins `workspace:{workspaceId}` room, sets socket workspace context |
| `workspace:leave` | client -> server | `workspaceId: string` | leaves `workspace:{workspaceId}` |
| `channel:join` | client -> server | `channelId: string`, optional ack `(result: { ok: boolean }) => void` | membership/capability checked; joins `channel:{channelId}` on success, acks `{ok:true}`/`{ok:false}` |
| `channel:leave` | client -> server | `channelId: string` | leaves `channel:{channelId}` |
| `typing:start` | client -> server | `channelId: string` | server emits to `channel:{channelId}` (excluding sender) |
| `typing:stop` | client -> server | `channelId: string` | server emits to `channel:{channelId}` (excluding sender) |
| `typing:start` | server -> room clients | `{ channelId: string, userId: string }` | broadcast to channel room except sender |
| `typing:stop` | server -> room clients | `{ channelId: string, userId: string }` | broadcast to channel room except sender |
| `presence:online` | client -> server | _(none)_ | if socket has workspace context, emits to `workspace:{workspaceId}` |
| `presence:online` | server -> workspace room | `{ userId: string }` | broadcast to workspace room except sender |
| `presence:offline` | server -> workspace room | `{ userId: string }` | emitted on disconnect when socket had workspace context |
| `message:new` | server -> `channel:{channelId}` | `{ channelId: string, message: { ...MessageSummary, clientTempId?: string } }` | emitted after persisted message send/voice send; top-level sends include optional `clientTempId` when provided |

## Notes

- Some factories are mounted under multiple prefixes (e.g. dev-integration project-repository/task-dev-link/callback routes), so the inventory reflects registered paths; `createDevIntegrationCallbackRouter` handlers also exist as aliased conditional mounts in `app.ts` when callback URLs are configured.
- `POST /webhooks/paystack`, `POST /webhooks/email`, `POST /webhooks/github`, `POST /webhooks/gitlab` are raw webhook mounts in `app.ts` (outside standard API router) in addition to any `/api/v1/webhooks/*` mounts present.
- Test presence is heuristic (module/route keyword match against `tests/**` and `*.vitest.ts`); `unknown` means no obvious matching test file/fragment was detected by scan, not proof of absence.
