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
  createDepartmentSchema,
  departmentMemberParamsSchema,
  departmentMemberSchema,
  departmentParamsSchema,
  createWorkspaceSchema,
  invitationParamsSchema,
  incomingOwnershipTransfersQuerySchema,
  listInvitationsQuerySchema,
  memberParamsSchema,
  ownershipTransferParamsSchema,
  adminOwnerAssignmentParamsSchema,
  removeWorkspaceMemberSchema,
  transferOwnershipSchema,
  updateDepartmentSchema,
  updateMemberRoleSchema,
  updateWorkspaceSchema,
  workspaceIdParamsSchema,
  type AddMemberInput,
  type CreateInvitationInput,
  type CreateDepartmentInput,
  type DepartmentMemberInput,
  type CreateWorkspaceInput,
  type ListInvitationsQuery,
  type RemoveWorkspaceMemberInput,
  type TransferOwnershipInput,
  type UpdateDepartmentInput,
  type UpdateMemberRoleInput,
  type UpdateWorkspaceInput,
} from './workspace.schemas';
import { createWorkspaceService, type WorkspaceService } from './workspace.service';
import { userWorkspaceAccessContext } from './authorization';

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

function requireAuthCtx(req: Request) {
  const auth = req.auth;
  if (!auth) {
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  }
  return auth;
}
function requireUser(req: Request): string { return requireAuthCtx(req).userId; }

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

  router.get('/owner-transfers/incoming', requireAuth, requireActiveAccount, validate({ query: incomingOwnershipTransfersQuerySchema }), async (req, res) => {
    const query = req.validated?.query as { limit: number; offset: number };
    sendSuccess(res, await service.listIncomingOwnershipTransfers({ userId: requireUser(req), ...query }));
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
      const workspace = await service.get({ userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId });

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
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, ...input },
        context(req),
      );

      sendSuccess(res, workspace);
    },
  );

  router.post('/:workspaceId/owner-transfers/:transferId/accept', requireAuth, requireActiveAccount, validate({ params: ownershipTransferParamsSchema }), async (req, res) => {
    const { workspaceId, transferId } = req.validated?.params as { workspaceId: string; transferId: string };
    const result = await service.acceptOwnershipTransfer({ userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, transferId }, context(req));
    sendSuccess(res, result);
  });

  router.post('/:workspaceId/owner-transfers/:transferId/reject', requireAuth, requireActiveAccount, validate({ params: ownershipTransferParamsSchema }), async (req, res) => {
    const { workspaceId, transferId } = req.validated?.params as { workspaceId: string; transferId: string };
    const result = await service.rejectOwnershipTransfer({ userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, transferId }, context(req));
    sendSuccess(res, result);
  });

  router.post('/:workspaceId/owner-transfers/:transferId/billing-acceptance', requireAuth, requireActiveAccount, validate({ params: ownershipTransferParamsSchema }), async (req, res) => {
    const { workspaceId, transferId } = req.validated?.params as { workspaceId: string; transferId: string };
    const result = await service.acceptOwnershipBilling({ userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, transferId }, context(req));
    sendSuccess(res, result);
  });

  router.post('/:workspaceId/admin-owner/:userId', requireAuth, requireActiveAccount, validate({ params: adminOwnerAssignmentParamsSchema }), async (req, res) => {
    const { workspaceId, userId: newOwnerId } = req.validated?.params as { workspaceId: string; userId: string };
    const result = await service.resolveDeletedOwner({ actorId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, newOwnerId }, context(req));
    sendSuccess(res, result);
  });

  router.post(
    '/:workspaceId/archive',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const workspace = await service.archive(
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId },
        context(req),
      );

      sendSuccess(res, workspace);
    },
  );

  router.post(
    '/:workspaceId/restore',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const workspace = await service.restore(
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId },
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

      await service.remove({ userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId }, context(req));

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
      const workspace = await service.switchTo({ userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId });

      sendSuccess(res, workspace);
    },
  );

  router.patch(
    '/:workspaceId/owner/:userId',
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
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, newOwnerId, ...input },
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
      const members = await service.listMembers({ userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId });

      sendSuccess(res, members);
    },
  );

  router.get(
    '/:workspaceId/departments',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const departments = await service.listDepartments({ userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId });
      sendSuccess(res, departments);
    },
  );

  router.post(
    '/:workspaceId/departments',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema, body: createDepartmentSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const input = req.validated?.body as CreateDepartmentInput;
      const department = await service.createDepartment(
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, ...input },
        context(req),
      );
      sendSuccess(res, department, 201);
    },
  );

  router.patch(
    '/:workspaceId/departments/:departmentId',
    requireAuth,
    requireActiveAccount,
    validate({ params: departmentParamsSchema, body: updateDepartmentSchema }),
    async (req, res) => {
      const { workspaceId, departmentId } = req.validated?.params as {
        workspaceId: string;
        departmentId: string;
      };
      const input = req.validated?.body as UpdateDepartmentInput;
      const department = await service.updateDepartment(
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, departmentId, ...input },
        context(req),
      );
      sendSuccess(res, department);
    },
  );

  router.post(
    '/:workspaceId/departments/:departmentId/members',
    requireAuth,
    requireActiveAccount,
    validate({ params: departmentParamsSchema, body: departmentMemberSchema }),
    async (req, res) => {
      const { workspaceId, departmentId } = req.validated?.params as {
        workspaceId: string;
        departmentId: string;
      };
      const input = req.validated?.body as DepartmentMemberInput;
      await service.assignDepartmentMember(
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, departmentId, ...input },
        context(req),
      );
      sendSuccess(res, { userId: input.targetUserId, assigned: true });
    },
  );

  router.delete(
    '/:workspaceId/departments/:departmentId/members/:targetUserId',
    requireAuth,
    requireActiveAccount,
    validate({ params: departmentMemberParamsSchema }),
    async (req, res) => {
      const { workspaceId, departmentId, targetUserId } = req.validated?.params as {
        workspaceId: string;
        departmentId: string;
        targetUserId: string;
      };
      await service.removeDepartmentMember(
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, departmentId, targetUserId },
        context(req),
      );
      sendSuccess(res, { userId: targetUserId, removed: true });
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
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, ...input },
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
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, targetUserId, ...input },
        context(req),
      );

      sendSuccess(res, member);
    },
  );

  router.delete(
    '/:workspaceId/members/:userId',
    requireAuth,
    requireActiveAccount,
    validate({ params: memberParamsSchema, body: removeWorkspaceMemberSchema }),
    async (req, res) => {
      const { workspaceId, userId: targetUserId } = req.validated?.params as {
        workspaceId: string;
        userId: string;
      };
      const input = req.validated?.body as RemoveWorkspaceMemberInput;

      await service.removeMember(
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, targetUserId, ...input },
        context(req),
      );

      sendSuccess(res, { userId: targetUserId, removed: true });
    },
  );

  router.post(
    '/:workspaceId/members/:userId/suspend',
    requireAuth,
    requireActiveAccount,
    validate({ params: memberParamsSchema }),
    async (req, res) => {
      const { workspaceId, userId: targetUserId } = req.validated?.params as {
        workspaceId: string;
        userId: string;
      };
      const member = await service.suspendMember(
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, targetUserId },
        context(req),
      );

      sendSuccess(res, member);
    },
  );

  router.post(
    '/:workspaceId/members/:userId/restore',
    requireAuth,
    requireActiveAccount,
    validate({ params: memberParamsSchema }),
    async (req, res) => {
      const { workspaceId, userId: targetUserId } = req.validated?.params as {
        workspaceId: string;
        userId: string;
      };
      const member = await service.restoreMember(
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, targetUserId },
        context(req),
      );

      sendSuccess(res, member);
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
      const auth = requireAuthCtx(req);
      const invitations = await invitationService.list({
        userId: auth.userId,
        context: userWorkspaceAccessContext(auth),
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
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, ...input },
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
        { userId: requireAuthCtx(req).userId, context: userWorkspaceAccessContext(requireAuthCtx(req)), workspaceId, invitationId },
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
      const auth = requireAuthCtx(req);
      const invitation = await invitationService.revoke({
        userId: auth.userId,
        context: userWorkspaceAccessContext(auth),
        workspaceId,
        invitationId,
      });

      sendSuccess(res, invitation);
    },
  );

  return router;
}
