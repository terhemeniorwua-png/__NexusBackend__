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
import { createHealthRouter } from './health';
import { createBillingRouter } from '../modules/billing/billing.routes';
import { createBillingService, type BillingService } from '../modules/billing/billing.service';
import { createOrganizationRouter } from '../modules/organizations/organization.routes';
import { createProjectOrganizationRouter } from '../modules/projects/organization-access.routes';
import { createProjectRouter } from '../modules/projects/project.routes';
import { createPrivacyRouter } from '../modules/privacy/privacy.routes';
import { createChannelRouter } from '../modules/channels/channel.routes';
import { createTaskRouter } from '../modules/tasks/task.routes';
import { createMessageRouter } from '../modules/messaging/message.routes';
import { createNotificationRouter } from '../modules/notifications/notification.routes';
import { createFileRouter } from '../modules/files/file.routes';
import { createDocumentRouter } from '../modules/documents/document.routes';

interface ApiRouterOptions {
  config: AppConfig;
  readinessProbe: ReadinessProbe;
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
  authService = createAuthService(config),
  usersService,
  workspaceService = createWorkspaceService(config),
  invitationService = createInvitationService(config),
  joinRequestService = createJoinRequestService(config),
  teamService = createTeamService(),
  billingService = createBillingService(config),
}: ApiRouterOptions): Router {
  const router = Router();

  router.use('/health', createHealthRouter({ config, readinessProbe }));
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
  // Tasks are nested under projects:
  // /workspaces/:workspaceId/projects/:projectId/tasks/…
  // The task router uses mergeParams to access workspaceId and projectId.
  router.use(
    '/workspaces/:workspaceId/projects/:projectId/tasks',
    createTaskRouter({ config }),
  );
  router.use('/workspaces/:workspaceId/channels', createChannelRouter({ config }));
  // Messages are nested under channels:
  // /workspaces/:workspaceId/channels/:channelId/messages/…
  // The message router uses mergeParams to access workspaceId and channelId.
  router.use('/workspaces/:workspaceId/channels', createMessageRouter({ config }));
  // Notifications are user-scoped, not workspace-scoped
  router.use('/notifications', createNotificationRouter({ config }));
  // Files are workspace-scoped
  router.use('/workspaces/:workspaceId/files', createFileRouter({ config }));
  // Documents are workspace-scoped
  router.use('/workspaces/:workspaceId/documents', createDocumentRouter({ config }));
  router.use('/workspaces/:workspaceId', createOrganizationRouter({ config }));
  // Teams are nested under workspaces: /workspaces/:workspaceId/teams/…
  // The team router uses mergeParams to access the workspaceId from the parent.
  router.use('/workspaces/:workspaceId/teams', createTeamRouter({ config, service: teamService }));

  return router;
}
