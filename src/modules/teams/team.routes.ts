import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { createRateLimiter } from '../../middleware/rate-limit';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  addTeamMemberSchema,
  bulkAddTeamMembersSchema,
  changeTeamLeadSchema,
  createTeamInvitationSchema,
  createTeamSchema,
  listTeamInvitationsQuerySchema,
  listTeamsQuerySchema,
  teamActivityQuerySchema,
  teamInvitationParamsSchema,
  teamMemberParamsSchema,
  teamParamsSchema,
  updateTeamMemberRoleSchema,
  updateTeamSchema,
  workspaceIdParamsSchema,
  type AddTeamMemberInput,
  type BulkAddTeamMembersInput,
  type ChangeTeamLeadInput,
  type CreateTeamInput,
  type ListTeamsQuery,
  type TeamActivityQuery,
  type UpdateTeamInput,
  type UpdateTeamMemberRoleInput,
} from './team.schemas';
import { createTeamService, type TeamService } from './team.service';
import { createInvitationService, type InvitationService } from '../workspaces/invitation.service';
import type { TeamRole } from '@prisma/client';

/**
 * Team routes.
 *
 * The routes translate HTTP into service calls. Every route requires a session
 * and an activated account; the service decides what the caller may do with
 * each team.
 *
 * Route layout
 * ------------
 *   GET    /workspaces/:workspaceId/teams                           list
 *   POST   /workspaces/:workspaceId/teams                           create
 *   GET    /workspaces/:workspaceId/teams/:teamId                   get
 *   GET    /workspaces/:workspaceId/teams/:teamId/overview          overview
 *   GET    /workspaces/:workspaceId/teams/:teamId/activity          activity feed
 *   GET    /workspaces/:workspaceId/teams/:teamId/projects          projects
 *   PATCH  /workspaces/:workspaceId/teams/:teamId                   update
 *   POST   /workspaces/:workspaceId/teams/:teamId/archive           archive
 *   DELETE /workspaces/:workspaceId/teams/:teamId                   delete
 *   GET    /workspaces/:workspaceId/teams/:teamId/members           list members
 *   POST   /workspaces/:workspaceId/teams/:teamId/members           add member
 *   POST   /workspaces/:workspaceId/teams/:teamId/members/bulk      add members (bulk)
 *   PATCH  /workspaces/:workspaceId/teams/:teamId/members/:userId   update member role
 *   DELETE /workspaces/:workspaceId/teams/:teamId/members/:userId   remove member
 *   PATCH  /workspaces/:workspaceId/teams/:teamId/lead              change lead
 */

export interface TeamRouterOptions {
  config: AppConfig;
  service?: TeamService;
  invitationService?: InvitationService;
}

function context(req: Request) {
  return {
    ip: req.ip,
    userAgent: req.header('user-agent'),
  };
}

function requireUser(req: Request): string {
  const auth = req.auth;

  if (!auth) {
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  }

  return auth.userId;
}

export function createTeamRouter({
  config,
  service = createTeamService(),
  invitationService = createInvitationService(config),
}: TeamRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();
  const invitationLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:teams:invitations`,
    windowMs: config.authRateLimitWindowMs,
    limit: 30,
    code: 'RATE_LIMITED',
    message: 'Too many invitations. Please try again later.',
  });

  // -------------------------------------------------------------------------
  // Team CRUD
  // -------------------------------------------------------------------------

  router.get(
    '/:teamId/invitations',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamParamsSchema, query: listTeamInvitationsQuerySchema }),
    async (req, res) => {
      const { workspaceId, teamId } = req.validated?.params as { workspaceId: string; teamId: string };
      const { status } = req.validated?.query as { status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED' | 'EXPIRED' | 'ALL' };
      sendSuccess(res, await invitationService.listTeam({ userId: requireUser(req), workspaceId, teamId, status }));
    },
  );

  router.post(
    '/:teamId/invitations',
    requireAuth,
    requireActiveAccount,
    invitationLimit,
    validate({ params: teamParamsSchema, body: createTeamInvitationSchema }),
    async (req, res) => {
      const { workspaceId, teamId } = req.validated?.params as { workspaceId: string; teamId: string };
      const { targetUserId } = req.validated?.body as { targetUserId: string };
      const result = await invitationService.createTeam(
        { userId: requireUser(req), workspaceId, teamId, targetUserId },
        context(req),
      );
      sendSuccess(res, result, 201);
    },
  );

  router.delete(
    '/:teamId/invitations/:invitationId',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamInvitationParamsSchema }),
    async (req, res) => {
      const { workspaceId, teamId, invitationId } = req.validated?.params as {
        workspaceId: string;
        teamId: string;
        invitationId: string;
      };
      const invitation = await invitationService.revokeTeam({
        userId: requireUser(req),
        workspaceId,
        teamId,
        invitationId,
      });
      sendSuccess(res, invitation);
    },
  );

  router.get(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema, query: listTeamsQuerySchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const { includeArchived } = req.validated?.query as ListTeamsQuery;
      const teams = await service.list({ userId: requireUser(req), workspaceId, includeArchived });

      sendSuccess(res, teams);
    },
  );

  router.post(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema, body: createTeamSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const input = req.validated?.body as CreateTeamInput;
      const team = await service.create(
        { userId: requireUser(req), workspaceId, ...input },
        context(req),
      );

      sendSuccess(res, team, 201);
    },
  );

  router.get(
    '/:teamId/overview',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamParamsSchema }),
    async (req, res) => {
      const { workspaceId, teamId } = req.validated?.params as {
        workspaceId: string;
        teamId: string;
      };
      sendSuccess(
        res,
        await service.overview({ userId: requireUser(req), workspaceId, teamId }),
      );
    },
  );

  router.get(
    '/:teamId/activity',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamParamsSchema, query: teamActivityQuerySchema }),
    async (req, res) => {
      const { workspaceId, teamId } = req.validated?.params as {
        workspaceId: string;
        teamId: string;
      };
      const query = req.validated?.query as TeamActivityQuery;
      sendSuccess(
        res,
        await service.activity({
          userId: requireUser(req),
          workspaceId,
          teamId,
          ...query,
        }),
      );
    },
  );

  router.get(
    '/:teamId/projects',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamParamsSchema }),
    async (req, res) => {
      const { workspaceId, teamId } = req.validated?.params as {
        workspaceId: string;
        teamId: string;
      };
      sendSuccess(
        res,
        await service.listProjects({ userId: requireUser(req), workspaceId, teamId }),
      );
    },
  );

  router.get(
    '/:teamId',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamParamsSchema }),
    async (req, res) => {
      const { workspaceId, teamId } = req.validated?.params as {
        workspaceId: string;
        teamId: string;
      };
      const team = await service.get({ userId: requireUser(req), workspaceId, teamId });

      sendSuccess(res, team);
    },
  );

  router.patch(
    '/:teamId',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamParamsSchema, body: updateTeamSchema }),
    async (req, res) => {
      const { workspaceId, teamId } = req.validated?.params as {
        workspaceId: string;
        teamId: string;
      };
      const input = req.validated?.body as UpdateTeamInput;
      const team = await service.update(
        { userId: requireUser(req), workspaceId, teamId, ...input },
        context(req),
      );

      sendSuccess(res, team);
    },
  );

  router.post(
    '/:teamId/archive',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamParamsSchema }),
    async (req, res) => {
      const { workspaceId, teamId } = req.validated?.params as {
        workspaceId: string;
        teamId: string;
      };
      const team = await service.archive(
        { userId: requireUser(req), workspaceId, teamId },
        context(req),
      );

      sendSuccess(res, team);
    },
  );

  router.delete(
    '/:teamId',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamParamsSchema }),
    async (req, res) => {
      const { workspaceId, teamId } = req.validated?.params as {
        workspaceId: string;
        teamId: string;
      };

      await service.remove({ userId: requireUser(req), workspaceId, teamId }, context(req));

      sendSuccess(res, { id: teamId, deleted: true });
    },
  );

  // -------------------------------------------------------------------------
  // Team members
  // -------------------------------------------------------------------------

  router.get(
    '/:teamId/members',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamParamsSchema }),
    async (req, res) => {
      const { workspaceId, teamId } = req.validated?.params as {
        workspaceId: string;
        teamId: string;
      };
      const members = await service.listMembers({ userId: requireUser(req), workspaceId, teamId });

      sendSuccess(res, members);
    },
  );

  router.post(
    '/:teamId/members',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamParamsSchema, body: addTeamMemberSchema }),
    async (req, res) => {
      const { workspaceId, teamId } = req.validated?.params as {
        workspaceId: string;
        teamId: string;
      };
      const input = req.validated?.body as AddTeamMemberInput;
      const member = await service.addMember(
        {
          userId: requireUser(req),
          workspaceId,
          teamId,
          targetUserId: input.userId,
          role: input.role as TeamRole,
        },
        context(req),
      );

      sendSuccess(res, member, 201);
    },
  );

  router.post(
    '/:teamId/members/bulk',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamParamsSchema, body: bulkAddTeamMembersSchema }),
    async (req, res) => {
      const { workspaceId, teamId } = req.validated?.params as {
        workspaceId: string;
        teamId: string;
      };
      const input = req.validated?.body as BulkAddTeamMembersInput;
      const result = await service.bulkAddMembers(
        { userId: requireUser(req), workspaceId, teamId, ...input },
        context(req),
      );

      sendSuccess(res, result, 201);
    },
  );

  router.patch(
    '/:teamId/members/:userId',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamMemberParamsSchema, body: updateTeamMemberRoleSchema }),
    async (req, res) => {
      const {
        workspaceId,
        teamId,
        userId: targetUserId,
      } = req.validated?.params as {
        workspaceId: string;
        teamId: string;
        userId: string;
      };
      const input = req.validated?.body as UpdateTeamMemberRoleInput;
      const member = await service.updateMemberRole(
        { userId: requireUser(req), workspaceId, teamId, targetUserId, ...input },
        context(req),
      );

      sendSuccess(res, member);
    },
  );

  router.delete(
    '/:teamId/members/:userId',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamMemberParamsSchema }),
    async (req, res) => {
      const {
        workspaceId,
        teamId,
        userId: targetUserId,
      } = req.validated?.params as {
        workspaceId: string;
        teamId: string;
        userId: string;
      };

      await service.removeMember(
        { userId: requireUser(req), workspaceId, teamId, targetUserId },
        context(req),
      );

      sendSuccess(res, { userId: targetUserId, removed: true });
    },
  );

  // -------------------------------------------------------------------------
  // Team lead
  // -------------------------------------------------------------------------

  router.patch(
    '/:teamId/lead',
    requireAuth,
    requireActiveAccount,
    validate({ params: teamParamsSchema, body: changeTeamLeadSchema }),
    async (req, res) => {
      const { workspaceId, teamId } = req.validated?.params as {
        workspaceId: string;
        teamId: string;
      };
      const input = req.validated?.body as ChangeTeamLeadInput;
      const team = await service.changeLead(
        { userId: requireUser(req), workspaceId, teamId, ...input },
        context(req),
      );

      sendSuccess(res, team);
    },
  );

  return router;
}
