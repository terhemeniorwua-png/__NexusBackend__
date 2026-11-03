import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  addTeamMemberSchema,
  changeTeamLeadSchema,
  createTeamSchema,
  listTeamsQuerySchema,
  teamMemberParamsSchema,
  teamParamsSchema,
  updateTeamMemberRoleSchema,
  updateTeamSchema,
  workspaceIdParamsSchema,
  type AddTeamMemberInput,
  type ChangeTeamLeadInput,
  type CreateTeamInput,
  type ListTeamsQuery,
  type UpdateTeamInput,
  type UpdateTeamMemberRoleInput,
} from './team.schemas';
import { createTeamService, type TeamService } from './team.service';
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
 *   GET    /workspaces/:workspaceId/teams                        list
 *   POST   /workspaces/:workspaceId/teams                        create
 *   GET    /workspaces/:workspaceId/teams/:teamId                get
 *   PATCH  /workspaces/:workspaceId/teams/:teamId                update
 *   POST   /workspaces/:workspaceId/teams/:teamId/archive        archive
 *   DELETE /workspaces/:workspaceId/teams/:teamId                delete
 *   GET    /workspaces/:workspaceId/teams/:teamId/members        list members
 *   POST   /workspaces/:workspaceId/teams/:teamId/members        add member
 *   PATCH  /workspaces/:workspaceId/teams/:teamId/members/:userId update member role
 *   DELETE /workspaces/:workspaceId/teams/:teamId/members/:userId remove member
 *   PATCH  /workspaces/:workspaceId/teams/:teamId/lead           change lead
 */

export interface TeamRouterOptions {
  config: AppConfig;
  service?: TeamService;
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
}: TeamRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();

  // -------------------------------------------------------------------------
  // Team CRUD
  // -------------------------------------------------------------------------

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
