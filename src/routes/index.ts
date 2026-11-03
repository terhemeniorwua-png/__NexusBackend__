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
import { createUsersService, type UsersService } from '../modules/users/users.service';
import { createWorkspaceRouter } from '../modules/workspaces/workspace.routes';
import {
  createWorkspaceService,
  type WorkspaceService,
} from '../modules/workspaces/workspace.service';
import { createTeamRouter } from '../modules/teams/team.routes';
import { createTeamService, type TeamService } from '../modules/teams/team.service';
import type { ReadinessProbe } from '../services/health';
import { createHealthRouter } from './health';

interface ApiRouterOptions {
  config: AppConfig;
  readinessProbe: ReadinessProbe;
  authService?: AuthService;
  usersService?: UsersService;
  workspaceService?: WorkspaceService;
  invitationService?: InvitationService;
  joinRequestService?: JoinRequestService;
  teamService?: TeamService;
}

export function createApiRouter({
  config,
  readinessProbe,
  authService = createAuthService(config),
  usersService = createUsersService(),
  workspaceService = createWorkspaceService(config),
  invitationService = createInvitationService(config),
  joinRequestService = createJoinRequestService(config),
  teamService = createTeamService(),
}: ApiRouterOptions): Router {
  const router = Router();

  router.use('/health', createHealthRouter({ config, readinessProbe }));
  router.use('/auth', createAuthRouter({ config, service: authService }));
  router.use('/users', createUsersRouter({ config, service: usersService }));
  // Discovery and join routes must be registered before the workspace router
  // so `/workspaces/discover` is not read as a workspace id.
  router.use('/workspaces', createJoinRequestRouter({ config, service: joinRequestService }));
  router.use(
    '/workspaces',
    createWorkspaceRouter({ config, service: workspaceService, invitationService }),
  );
  router.use('/invitations', createInvitationRouter({ config, service: invitationService }));
  // Teams are nested under workspaces: /workspaces/:workspaceId/teams/…
  // The team router uses mergeParams to access the workspaceId from the parent.
  router.use('/workspaces/:workspaceId/teams', createTeamRouter({ config, service: teamService }));

  return router;
}
