import express, { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { createOrganizationService } from './organization.service';
import { createS3CompatibleObjectStorage } from '../../services/storage/private-object-storage';
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

export function validateOrganizationLogo(
  value: unknown,
  declaredContentType: string | undefined,
): {
  body: Buffer;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp';
  extension: 'png' | 'jpg' | 'webp';
} {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > 2 * 1024 * 1024) {
    throw new AppError(
      400,
      'INVALID_ORGANIZATION_LOGO',
      'Logo must be a non-empty image up to 2 MB',
    );
  }
  const declared = declaredContentType?.split(';')[0]?.trim().toLowerCase();
  const body = value;
  let detected: {
    contentType: 'image/png' | 'image/jpeg' | 'image/webp';
    extension: 'png' | 'jpg' | 'webp';
  } | null = null;
  if (
    body.length >= 8 &&
    body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    detected = { contentType: 'image/png', extension: 'png' };
  } else if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
    detected = { contentType: 'image/jpeg', extension: 'jpg' };
  } else if (
    body.length >= 12 &&
    body.toString('ascii', 0, 4) === 'RIFF' &&
    body.toString('ascii', 8, 12) === 'WEBP'
  ) {
    detected = { contentType: 'image/webp', extension: 'webp' };
  }
  if (!detected || declared !== detected.contentType) {
    throw new AppError(400, 'INVALID_ORGANIZATION_LOGO', 'Upload a valid PNG, JPEG, or WebP image');
  }
  return { body, ...detected };
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
  service = createOrganizationService(
    undefined,
    createS3CompatibleObjectStorage({
      endpoint: config.objectStorageEndpoint,
      bucket: config.objectStorageBucket,
      region: config.objectStorageRegion,
      accessKeyId: config.objectStorageAccessKeyId,
      secretAccessKey: config.objectStorageSecretAccessKey,
      requestTimeoutMs: config.objectStorageRequestTimeoutMs,
    }),
  ),
}: OrganizationRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  for (const kind of ['company', 'institution'] as const) {
    const base = `/${kind}-profile/logo`;
    router.post(
      base,
      requireAuth,
      requireActive,
      express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '2mb' }),
      validate({ params: organizationParamsSchema }),
      async (req, res) => {
        const { workspaceId } = req.validated!.params as { workspaceId: string };
        const image = validateOrganizationLogo(req.body, req.get('content-type'));
        sendSuccess(
          res,
          await service.uploadLogo({
            userId: userId(req),
            workspaceId,
            kind,
            ...image,
            context: context(req),
          }),
        );
      },
    );
    router.get(
      base,
      requireAuth,
      requireActive,
      validate({ params: organizationParamsSchema }),
      async (req, res) => {
        const { workspaceId } = req.validated!.params as { workspaceId: string };
        const image = await service.getLogo({ userId: userId(req), workspaceId, kind });
        res
          .status(200)
          .type(image.contentType)
          .set({
            'Cache-Control': 'private, no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Length': String(image.body.length),
          })
          .send(image.body);
      },
    );
    router.delete(
      base,
      requireAuth,
      requireActive,
      validate({ params: organizationParamsSchema }),
      async (req, res) => {
        const { workspaceId } = req.validated!.params as { workspaceId: string };
        sendSuccess(
          res,
          await service.deleteLogo({
            userId: userId(req),
            workspaceId,
            kind,
            context: context(req),
          }),
        );
      },
    );
  }

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
