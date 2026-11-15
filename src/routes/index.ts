import { Router } from 'express';
import type { AppConfig } from '../config/env';
import { createAuthRouter } from '../modules/auth/auth.routes';
import { createAuthService, type AuthService } from '../modules/auth/auth.service';
import { createInvitationRouter } from '../modules/workspaces/invitation.routes';
import {
  createInvitationService,
  type InvitationService,
} from '../modules/workspaces/invitation.service';
import { createJoinRequestRouter } from '../modules/workspaces/join-request.routes';
import {
  createJoinRequestService,
  type JoinRequestService,
} from '../modules/workspaces/join-request.service';
import { createUsersRouter } from '../modules/users/users.routes';
import type { UsersService } from '../modules/users/users.service';
import { createWorkspaceRouter } from '../modules/workspaces/workspace.routes';
import {
  createWorkspaceService,
  type WorkspaceService,
} from '../modules/workspaces/workspace.service';
import { createTeamRouter } from '../modules/teams/team.routes';
import { createTeamService, type TeamService } from '../modules/teams/team.service';
import type { ReadinessProbe } from '../services/health';
import type { QueueStatusProbe } from '../services/workers/queue-status';
import type { WorkerHealthRegistry } from '../services/workers/worker-health';
import { createHealthRouter } from './health';
import { createBillingRouter } from '../modules/billing/billing.routes';
import { createBillingService, type BillingService } from '../modules/billing/billing.service';
import { createOrganizationRouter } from '../modules/organizations/organization.routes';
import { createProjectOrganizationRouter } from '../modules/projects/organization-access.routes';
import { createProjectRouter } from '../modules/projects/project.routes';
import { createProjectRolesRouter } from '../modules/projects/project-roles.routes';
import { createPrivacyRouter } from '../modules/privacy/privacy.routes';
import { createChannelRouter } from '../modules/channels/channel.routes';
import { createTaskRouter } from '../modules/tasks/task.routes';
import { createTaskWorkDocumentRouter } from '../modules/task-work-documents/task-work-document.routes';
import { createMessageRouter } from '../modules/messaging/message.routes';
import { createNotificationRouter } from '../modules/notifications/notification.routes';
import { createFileRouter } from '../modules/files/file.routes';
import { createDocumentRouter } from '../modules/documents/document.routes';
import { createCalendarRouter } from '../modules/calendar/calendar.routes';
import { createMeetingRouter } from '../modules/meetings/meeting.routes';
import { createFormRouter } from '../modules/forms/form.routes';
import { createSearchRouter } from '../modules/search/search.routes';
import { createIntegrationRouter } from '../modules/integrations/integration.routes';
import { createAutomationRouter } from '../modules/automation/automation.routes';
import { createWebhookRouter } from '../modules/webhooks/webhook.routes';
import { createAiRouter } from '../modules/ai/ai.routes';
import { createAuditRouter } from '../modules/audit/audit.routes';
import { createAnalyticsRouter } from '../modules/analytics/analytics.routes';

interface ApiRouterOptions {
  config: AppConfig;
  readinessProbe: ReadinessProbe;
  workerHealth?: WorkerHealthRegistry;
  queueStatusProbe?: QueueStatusProbe;
  authService?: AuthService;
  usersService?: UsersService;
  workspaceService?: WorkspaceService;
  invitationService?: InvitationService;
  joinRequestService?: JoinRequestService;
  teamService?: TeamService;
  billingService?: BillingService;
}

export function createApiRouter({
  config,
  readinessProbe,
  workerHealth,
  queueStatusProbe,
  authService = createAuthService(config),
  usersService,
  workspaceService = createWorkspaceService(config),
  invitationService = createInvitationService(config),
  joinRequestService = createJoinRequestService(config),
  teamService = createTeamService(),
  billingService = createBillingService(config),
}: ApiRouterOptions): Router {
  const router = Router();

  router.use(
    '/health',
    createHealthRouter({ config, readinessProbe, workerHealth, queueStatusProbe }),
  );
  router.use('/billing', createBillingRouter({ config, service: billingService }));
  router.use('/privacy-requests', createPrivacyRouter({ config }));
  router.use('/auth', createAuthRouter({ config, service: authService }));
  router.use(
    '/users',
    createUsersRouter({ config, ...(usersService ? { service: usersService } : {}) }),
  );
  // Discovery and join routes must be registered before the workspace router
  // so `/workspaces/discover` is not read as a workspace id.
  router.use('/workspaces', createJoinRequestRouter({ config, service: joinRequestService }));
  router.use(
    '/workspaces',
    createWorkspaceRouter({ config, service: workspaceService, invitationService }),
  );
  router.use('/invitations', createInvitationRouter({ config, service: invitationService }));
  router.use('/workspaces/:workspaceId/projects', createProjectOrganizationRouter({ config }));
  router.use('/workspaces/:workspaceId/projects', createProjectRouter({ config }));
  router.use('/workspaces/:workspaceId/project-roles', createProjectRolesRouter({ config }));
  // Tasks are nested under projects:
  // /workspaces/:workspaceId/projects/:projectId/tasks/…
  // The task router uses mergeParams to access workspaceId and projectId.
  router.use('/workspaces/:workspaceId/projects/:projectId/tasks', createTaskRouter({ config }));
  router.use(
    '/workspaces/:workspaceId/projects/:projectId/tasks/:taskId/work-documents',
    createTaskWorkDocumentRouter({ config }),
  );
  router.use('/workspaces/:workspaceId/channels', createChannelRouter({ config }));
  // Messages are nested under channels:
  // /workspaces/:workspaceId/channels/:channelId/messages/…
  // The message router uses mergeParams to access workspaceId and channelId.
  router.use('/workspaces/:workspaceId/channels', createMessageRouter({ config }));
  // Notifications are user-scoped, not workspace-scoped
  router.use('/notifications', createNotificationRouter({ config }));
  // Search is user-scoped
  router.use('/search', createSearchRouter({ config }));
  // Integrations are user-scoped (optionally workspace-scoped via query)
  router.use('/integrations', createIntegrationRouter({ config }));
  // Automations are workspace-scoped
  router.use('/workspaces/:workspaceId/automations', createAutomationRouter({ config }));
  // Outbound webhook subscriptions are workspace-scoped
  router.use('/workspaces/:workspaceId/webhooks', createWebhookRouter({ config }));
  // AI service proxy (Phases 21-23)
  router.use('/ai', createAiRouter({ config }));
  // Workspace audit log API (Phase 26)
  router.use('/workspaces/:workspaceId/audit', createAuditRouter({ config }));
  // Files are workspace-scoped
  router.use('/workspaces/:workspaceId/files', createFileRouter({ config }));
  // Documents are workspace-scoped
  router.use('/workspaces/:workspaceId/documents', createDocumentRouter({ config }));
  // Calendar events are workspace-scoped
  router.use('/workspaces/:workspaceId/events', createCalendarRouter({ config }));
  // Meetings are workspace-scoped
  router.use('/workspaces/:workspaceId/meetings', createMeetingRouter({ config }));
  // Forms are workspace-scoped
  router.use('/workspaces/:workspaceId/forms', createFormRouter({ config }));
  router.use('/workspaces/:workspaceId', createOrganizationRouter({ config }));
  // Teams are nested under workspaces: /workspaces/:workspaceId/teams/…
  // The team router uses mergeParams to access the workspaceId from the parent.
  router.use(
    '/workspaces/:workspaceId/teams',
    createTeamRouter({ config, service: teamService, invitationService }),
  );

  // Analytics are user-scoped and permission-filtered by workspace access.
  router.use('/analytics', createAnalyticsRouter({ config }));

  return router;
}
