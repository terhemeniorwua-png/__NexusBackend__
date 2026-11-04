import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { createOrganizationService } from './organization.service';
import type {
  CreateInstitutionGroupInput,
  UpdateCompanyProfileInput,
  UpdateInstitutionProfileInput,
  UpdateInstitutionGroupInput,
  UpdateNotificationPreferencesInput,
} from './organization.schemas';
import {
  addInstitutionGroupMemberSchema,
  createInstitutionGroupSchema,
  institutionGroupMemberParamsSchema,
  institutionGroupParamsSchema,
  organizationParamsSchema,
  updateCompanyProfileSchema,
  updateInstitutionGroupSchema,
  updateInstitutionGroupMemberSchema,
  updateInstitutionProfileSchema,
  updateNotificationPreferencesSchema,
} from './organization.schemas';

export interface OrganizationRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createOrganizationService>;
}

function userId(req: Request): string {
  if (!req.auth)
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  return req.auth.userId;
}

function context(req: Request) {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}

export function createOrganizationRouter({
  config,
  service = createOrganizationService(),
}: OrganizationRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get(
    '/company-profile',
    requireAuth,
    requireActive,
    validate({ params: organizationParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(res, await service.getCompanyProfile({ userId: userId(req), workspaceId }));
    },
  );
  router.patch(
    '/company-profile',
    requireAuth,
    requireActive,
    validate({ params: organizationParamsSchema, body: updateCompanyProfileSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(
        res,
        await service.updateCompanyProfile(
          {
            userId: userId(req),
            workspaceId,
            ...(req.validated!.body as UpdateCompanyProfileInput),
          },
          context(req),
        ),
      );
    },
  );

  router.get(
    '/institution-profile',
    requireAuth,
    requireActive,
    validate({ params: organizationParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(res, await service.getInstitutionProfile({ userId: userId(req), workspaceId }));
    },
  );
  router.patch(
    '/institution-profile',
    requireAuth,
    requireActive,
    validate({ params: organizationParamsSchema, body: updateInstitutionProfileSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(
        res,
        await service.updateInstitutionProfile(
          {
            userId: userId(req),
            workspaceId,
            ...(req.validated!.body as UpdateInstitutionProfileInput),
          },
          context(req),
        ),
      );
    },
  );

  router.get(
    '/institution-groups',
    requireAuth,
    requireActive,
    validate({ params: organizationParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(res, await service.listInstitutionGroups({ userId: userId(req), workspaceId }));
    },
  );

  router.get(
    '/notification-preferences',
    requireAuth,
    requireActive,
    validate({ params: organizationParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(
        res,
        await service.getNotificationPreferences({ userId: userId(req), workspaceId }),
      );
    },
  );
  router.patch(
    '/notification-preferences',
    requireAuth,
    requireActive,
    validate({ params: organizationParamsSchema, body: updateNotificationPreferencesSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(
        res,
        await service.updateNotificationPreferences(
          {
            userId: userId(req),
            workspaceId,
            ...(req.validated!.body as UpdateNotificationPreferencesInput),
          },
          context(req),
        ),
      );
    },
  );

  router.post(
    '/institution-groups',
    requireAuth,
    requireActive,
    validate({ params: organizationParamsSchema, body: createInstitutionGroupSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(
        res,
        await service.createInstitutionGroup(
          {
            userId: userId(req),
            workspaceId,
            ...(req.validated!.body as CreateInstitutionGroupInput),
          },
          context(req),
        ),
        201,
      );
    },
  );
  router.patch(
    '/institution-groups/:groupId',
    requireAuth,
    requireActive,
    validate({ params: institutionGroupParamsSchema, body: updateInstitutionGroupSchema }),
    async (req, res) => {
      const { workspaceId, groupId } = req.validated!.params as {
        workspaceId: string;
        groupId: string;
      };
      sendSuccess(
        res,
        await service.updateInstitutionGroup(
          {
            userId: userId(req),
            workspaceId,
            groupId,
            ...(req.validated!.body as UpdateInstitutionGroupInput),
          },
          context(req),
        ),
      );
    },
  );
  router.delete(
    '/institution-groups/:groupId',
    requireAuth,
    requireActive,
    validate({ params: institutionGroupParamsSchema }),
    async (req, res) => {
      const { workspaceId, groupId } = req.validated!.params as {
        workspaceId: string;
        groupId: string;
      };
      sendSuccess(
        res,
        await service.deleteInstitutionGroup(
          { userId: userId(req), workspaceId, groupId },
          context(req),
        ),
      );
    },
  );
  router.get(
    '/institution-groups/:groupId/members',
    requireAuth,
    requireActive,
    validate({ params: institutionGroupParamsSchema }),
    async (req, res) => {
      const { workspaceId, groupId } = req.validated!.params as {
        workspaceId: string;
        groupId: string;
      };
      sendSuccess(
        res,
        await service.listInstitutionGroupMembers({ userId: userId(req), workspaceId, groupId }),
      );
    },
  );
  router.post(
    '/institution-groups/:groupId/members',
    requireAuth,
    requireActive,
    validate({ params: institutionGroupParamsSchema, body: addInstitutionGroupMemberSchema }),
    async (req, res) => {
      const { workspaceId, groupId } = req.validated!.params as {
        workspaceId: string;
        groupId: string;
      };
      const body = req.validated!.body as { userId: string; role: 'LEAD' | 'MEMBER' };
      sendSuccess(
        res,
        await service.addInstitutionGroupMember(
          { userId: userId(req), workspaceId, groupId, targetUserId: body.userId, role: body.role },
          context(req),
        ),
        201,
      );
    },
  );
  router.delete(
    '/institution-groups/:groupId/members/:userId',
    requireAuth,
    requireActive,
    validate({ params: institutionGroupMemberParamsSchema }),
    async (req, res) => {
      const {
        workspaceId,
        groupId,
        userId: targetUserId,
      } = req.validated!.params as {
        workspaceId: string;
        groupId: string;
        userId: string;
      };
      sendSuccess(
        res,
        await service.removeInstitutionGroupMember(
          { userId: userId(req), workspaceId, groupId, targetUserId },
          context(req),
        ),
      );
    },
  );
  router.patch(
    '/institution-groups/:groupId/members/:userId',
    requireAuth,
    requireActive,
    validate({
      params: institutionGroupMemberParamsSchema,
      body: updateInstitutionGroupMemberSchema,
    }),
    async (req, res) => {
      const {
        workspaceId,
        groupId,
        userId: targetUserId,
      } = req.validated!.params as {
        workspaceId: string;
        groupId: string;
        userId: string;
      };
      const body = req.validated!.body as { role: 'LEAD' | 'MEMBER' };
      sendSuccess(
        res,
        await service.updateInstitutionGroupMember(
          { userId: userId(req), workspaceId, groupId, targetUserId, role: body.role },
          context(req),
        ),
      );
    },
  );

  return router;
}
