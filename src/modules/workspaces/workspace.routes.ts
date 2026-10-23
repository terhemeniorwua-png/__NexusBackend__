import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { createRateLimiter } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validation';
import type { RequestContext } from '../auth/auth.types';
import { ipKeyGenerator } from 'express-rate-limit';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { createInvitationService, type InvitationService } from './invitation.service';
import {
  addMemberSchema,
  createInvitationSchema,
  createWorkspaceSchema,
  invitationParamsSchema,
  listInvitationsQuerySchema,
  memberParamsSchema,
  transferOwnershipSchema,
  updateMemberRoleSchema,
  updateWorkspaceSchema,
  workspaceIdParamsSchema,
  type AddMemberInput,
  type CreateInvitationInput,
  type CreateWorkspaceInput,
  type ListInvitationsQuery,
  type TransferOwnershipInput,
  type UpdateMemberRoleInput,
  type UpdateWorkspaceInput,
} from './workspace.schemas';
import { createWorkspaceService, type WorkspaceService } from './workspace.service';

/**
 * Workspace routes.
 *
 * The routes translate HTTP into service calls. Every route needs a session
 * and an activated account, and the service decides what the caller may do
 * with the workspace.
 */

export interface WorkspaceRouterOptions {
  config: AppConfig;
  service?: WorkspaceService;
  invitationService?: InvitationService;
}

function context(req: Request): RequestContext {
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

export function createWorkspaceRouter({
  config,
  service = createWorkspaceService(config),
  invitationService = createInvitationService(config),
}: WorkspaceRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  // A workspace is only useful to an account that can be reached by mail.
  const requireActiveAccount = createRequireActiveAccount();

  // Sending an invitation costs a mail and must not be turned into a way to
  // flood an inbox.
  const invitationLimit = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:workspaces:invitations`,
    windowMs: config.authRateLimitWindowMs,
    limit: 30,
    code: 'RATE_LIMITED',
    message: 'Too many invitations. Please try again later.',
    keyGenerator: (req) => req.auth?.userId ?? `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`,
  });

  router.post(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ body: createWorkspaceSchema }),
    async (req, res) => {
      const input = req.validated?.body as CreateWorkspaceInput;
      const workspace = await service.create({ userId: requireUser(req), ...input }, context(req));

      sendSuccess(res, workspace, 201);
    },
  );

  router.get('/', requireAuth, requireActiveAccount, async (req, res) => {
    const workspaces = await service.list(requireUser(req));

    sendSuccess(res, workspaces);
  });

  router.get(
    '/:workspaceId',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const workspace = await service.get({ userId: requireUser(req), workspaceId });

      sendSuccess(res, workspace);
    },
  );

  router.patch(
    '/:workspaceId',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema, body: updateWorkspaceSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const input = req.validated?.body as UpdateWorkspaceInput;
      const workspace = await service.update(
        { userId: requireUser(req), workspaceId, ...input },
        context(req),
      );

      sendSuccess(res, workspace);
    },
  );

  router.post(
    '/:workspaceId/archive',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const workspace = await service.archive(
        { userId: requireUser(req), workspaceId },
        context(req),
      );

      sendSuccess(res, workspace);
    },
  );

  router.delete(
    '/:workspaceId',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };

      await service.remove({ userId: requireUser(req), workspaceId }, context(req));

      sendSuccess(res, { id: workspaceId, deleted: true });
    },
  );

  router.post(
    '/:workspaceId/switch',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const workspace = await service.switchTo({ userId: requireUser(req), workspaceId });

      sendSuccess(res, workspace);
    },
  );

  router.patch(
    '/:workspaceId/owner',
    requireAuth,
    requireActiveAccount,
    validate({ params: memberParamsSchema, body: transferOwnershipSchema }),
    async (req, res) => {
      const { workspaceId, userId: newOwnerId } = req.validated?.params as {
        workspaceId: string;
        userId: string;
      };
      const input = req.validated?.body as TransferOwnershipInput;
      const workspace = await service.transferOwnership(
        { userId: requireUser(req), workspaceId, newOwnerId, ...input },
        context(req),
      );

      sendSuccess(res, workspace);
    },
  );

  router.get(
    '/:workspaceId/members',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const members = await service.listMembers({ userId: requireUser(req), workspaceId });

      sendSuccess(res, members);
    },
  );

  router.post(
    '/:workspaceId/members',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema, body: addMemberSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const input = req.validated?.body as AddMemberInput;
      const member = await service.addMember(
        { userId: requireUser(req), workspaceId, ...input },
        context(req),
      );

      sendSuccess(res, member, 201);
    },
  );

  router.patch(
    '/:workspaceId/members/:userId',
    requireAuth,
    requireActiveAccount,
    validate({ params: memberParamsSchema, body: updateMemberRoleSchema }),
    async (req, res) => {
      const { workspaceId, userId: targetUserId } = req.validated?.params as {
        workspaceId: string;
        userId: string;
      };
      const input = req.validated?.body as UpdateMemberRoleInput;
      const member = await service.updateMemberRole(
        { userId: requireUser(req), workspaceId, targetUserId, ...input },
        context(req),
      );

      sendSuccess(res, member);
    },
  );

  router.delete(
    '/:workspaceId/members/:userId',
    requireAuth,
    requireActiveAccount,
    validate({ params: memberParamsSchema }),
    async (req, res) => {
      const { workspaceId, userId: targetUserId } = req.validated?.params as {
        workspaceId: string;
        userId: string;
      };

      await service.removeMember(
        { userId: requireUser(req), workspaceId, targetUserId },
        context(req),
      );

      sendSuccess(res, { userId: targetUserId, removed: true });
    },
  );

  router.get(
    '/:workspaceId/invitations',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema, query: listInvitationsQuerySchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const { status } = req.validated?.query as ListInvitationsQuery;
      const invitations = await invitationService.list({
        userId: requireUser(req),
        workspaceId,
        status,
      });

      sendSuccess(res, invitations);
    },
  );

  router.post(
    '/:workspaceId/invitations',
    requireAuth,
    requireActiveAccount,
    invitationLimit,
    validate({ params: workspaceIdParamsSchema, body: createInvitationSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const input = req.validated?.body as CreateInvitationInput;
      const result = await invitationService.create(
        { userId: requireUser(req), workspaceId, ...input },
        context(req),
      );

      sendSuccess(res, result, 201);
    },
  );

  router.post(
    '/:workspaceId/invitations/:invitationId/resend',
    requireAuth,
    requireActiveAccount,
    invitationLimit,
    validate({ params: invitationParamsSchema }),
    async (req, res) => {
      const { workspaceId, invitationId } = req.validated?.params as {
        workspaceId: string;
        invitationId: string;
      };
      const result = await invitationService.resend(
        { userId: requireUser(req), workspaceId, invitationId },
        context(req),
      );

      sendSuccess(res, result);
    },
  );

  router.delete(
    '/:workspaceId/invitations/:invitationId',
    requireAuth,
    requireActiveAccount,
    validate({ params: invitationParamsSchema }),
    async (req, res) => {
      const { workspaceId, invitationId } = req.validated?.params as {
        workspaceId: string;
        invitationId: string;
      };
      const invitation = await invitationService.revoke({
        userId: requireUser(req),
        workspaceId,
        invitationId,
      });

      sendSuccess(res, invitation);
    },
  );

  return router;
}
