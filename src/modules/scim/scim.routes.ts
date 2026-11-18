import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../../config/env';
import { createScimAuth, type ScimRequestContext } from './scim.auth';
import { createScimService, type ScimService } from './scim.service';
import {
  provisionScimUserSchema,
  patchScimUserSchema,
  provisionScimGroupSchema,
  patchScimGroupSchema,
  scimListQuerySchema,
  type ProvisionScimUserInput,
  type PatchScimUserInput,
  type ProvisionScimGroupInput,
  type PatchScimGroupInput,
  type ScimListQuery,
} from './scim.schemas';
import { createRateLimiter } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';

/**
 * SCIM 2.0 provisioning routes.
 *
 * Mounted at `/scim/v2`. All endpoints are authenticated with a per-workspace
 * bearer token (see `scim.auth.ts`) and are implicitly scoped to that
 * workspace. Tokens are rate limited per token.
 *
 * Responses follow the SCIM 2.0 protocol format; errors use the SCIM error
 * schema so SCIM clients can consume them directly.
 */

const SCIM_BASE_PATH = '/scim/v2';

const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCHEMA_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCHEMA_SERVICE_PROVIDER_CONFIG =
  'urn:ietf:params:scim:api:messages:2.0:ServiceProviderConfig';
const SCHEMA_RESOURCE_TYPES =
  'urn:ietf:params:scim:api:messages:2.0:ResourceTypes';
const SCHEMA_SCHEMAS = 'urn:ietf:params:scim:api:messages:2.0:Schemas';

export interface ScimRouterOptions {
  config: AppConfig;
  service?: ScimService;
}

interface ScimAuthenticatedRequest extends Request {
  scim?: ScimRequestContext;
}

function scimContext(req: ScimAuthenticatedRequest): ScimRequestContext {
  if (!req.scim) {
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'A SCIM bearer token is required');
  }
  return req.scim;
}

function sendScimJson(res: Response, status: number, body: unknown): Response {
  return res.status(status).set('Content-Type', 'application/scim+json; charset=utf-8').json(body);
}

function sendScimError(
  res: Response,
  status: number,
  scimType: string,
  detail: string,
): Response {
  return sendScimJson(res, status, {
    schemas: [SCHEMA_ERROR],
    status,
    scimType,
    detail,
  });
}

function toScimUserResource(user: {
  id: string;
  externalId: string | null;
  userName: string;
  displayName: string | null;
  name: { givenName: string | null; familyName: string | null; formatted: string | null } | null;
  emails: Array<{ value: string; type: string | null; primary: boolean }>;
  active: boolean;
  groups: Array<{ value: string; display: string | null }>;
  meta?: {
    resourceType: string;
    created: string;
    lastModified: string;
    location: string;
    version: string;
  };
}): unknown {
  return {
    schemas: [SCHEMA_USER],
    id: user.id,
    externalId: user.externalId,
    userName: user.userName,
    displayName: user.displayName,
    name: user.name,
    emails: user.emails,
    active: user.active,
    groups: user.groups,
    meta: user.meta ?? {
      resourceType: 'User',
      created: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      location: `${SCIM_BASE_PATH}/Users/${user.id}`,
      version: '1',
    },
  };
}

function toScimGroupResource(group: {
  id: string;
  externalId: string | null;
  displayName: string;
  members: Array<{ value: string; display: string | null }>;
  meta?: {
    resourceType: string;
    created: string;
    lastModified: string;
    location: string;
    version: string;
  };
}): unknown {
  return {
    schemas: [SCHEMA_GROUP],
    id: group.id,
    externalId: group.externalId,
    displayName: group.displayName,
    members: group.members,
    meta: group.meta ?? {
      resourceType: 'Group',
      created: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      location: `${SCIM_BASE_PATH}/Groups/${group.id}`,
      version: '1',
    },
  };
}

export function createScimRouter({
  config,
  service: injectedService,
}: ScimRouterOptions): Router {
  const router = Router();
  const requireScimAuth = createScimAuth();

  // Per-token rate limiting. `req.scim` is populated by `requireScimAuth`
  // which runs before this limiter, so `req.scim.tokenId` is available.
  const scimRateLimiter = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:scim`,
    windowMs: (config as unknown as { scimRateLimitWindowMs?: number }).scimRateLimitWindowMs ?? config.rateLimitWindowMs,
    limit: (config as unknown as { scimRateLimitMax?: number }).scimRateLimitMax ?? config.rateLimitMax,
    keyGenerator: (req) => {
      const ctx = (req as ScimAuthenticatedRequest).scim;
      return ctx ? `token:${ctx.tokenId}` : `ip:${req.ip ?? 'unknown'}`;
    },
    code: 'SCIM_RATE_LIMITED',
    message: 'Too many SCIM requests. Please try again later.',
  });

  const service = injectedService ?? createScimService();

  // ------------------------------------------------------------------
  // SCIM metadata endpoints (no service data)
  // ------------------------------------------------------------------

  router.get(
    '/ServiceProviderConfig',
    requireScimAuth,
    scimRateLimiter,
    (_req: Request, res: Response) => {
      sendScimJson(res, 200, {
        schemas: [SCHEMA_SERVICE_PROVIDER_CONFIG],
        id: 'nexus',
        displayName: 'Nexus SCIM Service Provider',
        version: '2.0',
        documentationUrl: 'https://docs.nexus.local/scim',
        patch: { supported: true },
        put: { supported: false },
        post: { supported: true },
        delete: { supported: true },
        filter: { supported: false, maxResults: 0 },
        authentication: { supported: true },
        changePassword: { supported: false },
        bulk: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        xmlDataType: { supported: false },
      });
    },
  );

  router.get('/ResourceTypes', requireScimAuth, scimRateLimiter, (_req, res) => {
    sendScimJson(res, 200, {
      schemas: [SCHEMA_RESOURCE_TYPES],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 2,
      Resources: [
        {
          schemas: [SCHEMA_RESOURCE_TYPES],
          id: 'User',
          name: 'User',
          endpoint: `${SCIM_BASE_PATH}/Users`,
          description: 'User Account',
          schema: SCHEMA_USER,
          schemaExtensions: [],
        },
        {
          schemas: [SCHEMA_RESOURCE_TYPES],
          id: 'Group',
          name: 'Group',
          endpoint: `${SCIM_BASE_PATH}/Groups`,
          description: 'Group',
          schema: SCHEMA_GROUP,
          schemaExtensions: [],
        },
      ],
    });
  });

  router.get('/Schemas', requireScimAuth, scimRateLimiter, (_req, res) => {
    sendScimJson(res, 200, {
      schemas: [SCHEMA_SCHEMAS],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 2,
      Resources: [
        {
          schemas: [SCHEMA_SCHEMAS],
          id: SCHEMA_USER,
          name: 'User',
          description: 'User Account',
        },
        {
          schemas: [SCHEMA_SCHEMAS],
          id: SCHEMA_GROUP,
          name: 'Group',
          description: 'Group',
        },
      ],
    });
  });

  // ------------------------------------------------------------------
  // Users
  // ------------------------------------------------------------------

  router.get(
    '/Users',
    requireScimAuth,
    scimRateLimiter,
    validate({ query: scimListQuerySchema }),
    async (req: ScimAuthenticatedRequest, res: Response) => {
      const ctx = scimContext(req);
      const q = req.validated!.query as ScimListQuery;
      const result = await service.listUsers({
        actorId: ctx.userId,
        workspaceId: ctx.workspaceId,
        startIndex: q.startIndex,
        count: q.count,
        filter: q.filter ?? null,
      });
      sendScimJson(res, 200, {
        schemas: [SCHEMA_LIST],
        totalResults: result.totalResults,
        startIndex: result.startIndex,
        itemsPerPage: result.itemsPerPage,
        Resources: result.Resources.map(toScimUserResource),
      });
    },
  );

  router.post(
    '/Users',
    requireScimAuth,
    scimRateLimiter,
    validate({ body: provisionScimUserSchema }),
    async (req: ScimAuthenticatedRequest, res: Response) => {
      const ctx = scimContext(req);
      const body = req.validated!.body as ProvisionScimUserInput;
      const created = await service.createUser({
        actorId: ctx.userId,
        workspaceId: ctx.workspaceId,
        ...body,
      });
      sendScimJson(res, 201, toScimUserResource({ ...created, meta: undefined }));
    },
  );

  router.get(
    '/Users/:scimUserId',
    requireScimAuth,
    scimRateLimiter,
    async (req: ScimAuthenticatedRequest, res: Response) => {
      const ctx = scimContext(req);
      const user = await service.getUser({
        actorId: ctx.userId,
        workspaceId: ctx.workspaceId,
        scimUserId: req.params.scimUserId as string,
      });
      sendScimJson(res, 200, toScimUserResource({ ...user, meta: undefined }));
    },
  );

  router.patch(
    '/Users/:scimUserId',
    requireScimAuth,
    scimRateLimiter,
    validate({ body: patchScimUserSchema }),
    async (req: ScimAuthenticatedRequest, res: Response) => {
      const ctx = scimContext(req);
      const body = req.validated!.body as PatchScimUserInput;
      const updated = await service.updateUser({
        actorId: ctx.userId,
        workspaceId: ctx.workspaceId,
        scimUserId: req.params.scimUserId as string,
        patch: body,
      });
      sendScimJson(res, 200, toScimUserResource({ ...updated, meta: undefined }));
    },
  );

  router.delete(
    '/Users/:scimUserId',
    requireScimAuth,
    scimRateLimiter,
    async (req: ScimAuthenticatedRequest, res: Response) => {
      const ctx = scimContext(req);
      const hardDelete = req.query.hardDelete === 'true';
      await service.deactivateUser({
        actorId: ctx.userId,
        workspaceId: ctx.workspaceId,
        scimUserId: req.params.scimUserId as string,
        hardDelete,
      });
      sendScimJson(res, 200, { schemas: [SCHEMA_USER], id: req.params.scimUserId as string });
    },
  );

  // ------------------------------------------------------------------
  // Groups
  // ------------------------------------------------------------------

  router.get(
    '/Groups',
    requireScimAuth,
    scimRateLimiter,
    validate({ query: scimListQuerySchema }),
    async (req: ScimAuthenticatedRequest, res: Response) => {
      const ctx = scimContext(req);
      const q = req.validated!.query as ScimListQuery;
      const result = await service.listGroups({
        actorId: ctx.userId,
        workspaceId: ctx.workspaceId,
        startIndex: q.startIndex,
        count: q.count,
      });
      sendScimJson(res, 200, {
        schemas: [SCHEMA_LIST],
        totalResults: result.totalResults,
        startIndex: result.startIndex,
        itemsPerPage: result.itemsPerPage,
        Resources: result.Resources.map(toScimGroupResource),
      });
    },
  );

  router.post(
    '/Groups',
    requireScimAuth,
    scimRateLimiter,
    validate({ body: provisionScimGroupSchema }),
    async (req: ScimAuthenticatedRequest, res: Response) => {
      const ctx = scimContext(req);
      const body = req.validated!.body as ProvisionScimGroupInput;
      const created = await service.createGroup({
        actorId: ctx.userId,
        workspaceId: ctx.workspaceId,
        ...body,
      });
      sendScimJson(res, 201, toScimGroupResource({ ...created, meta: undefined }));
    },
  );

  router.get(
    '/Groups/:scimGroupId',
    requireScimAuth,
    scimRateLimiter,
    async (req: ScimAuthenticatedRequest, res: Response) => {
      const ctx = scimContext(req);
      const group = await service.getGroup({
        actorId: ctx.userId,
        workspaceId: ctx.workspaceId,
        scimGroupId: req.params.scimGroupId as string,
      });
      sendScimJson(res, 200, toScimGroupResource({ ...group, meta: undefined }));
    },
  );

  router.patch(
    '/Groups/:scimGroupId',
    requireScimAuth,
    scimRateLimiter,
    validate({ body: patchScimGroupSchema }),
    async (req: ScimAuthenticatedRequest, res: Response) => {
      const ctx = scimContext(req);
      const body = req.validated!.body as PatchScimGroupInput;
      const updated = await service.updateGroup({
        actorId: ctx.userId,
        workspaceId: ctx.workspaceId,
        scimGroupId: req.params.scimGroupId as string,
        patch: body,
      });
      sendScimJson(res, 200, toScimGroupResource({ ...updated, meta: undefined }));
    },
  );

  router.delete(
    '/Groups/:scimGroupId',
    requireScimAuth,
    scimRateLimiter,
    async (req: ScimAuthenticatedRequest, res: Response) => {
      const ctx = scimContext(req);
      await service.deleteGroup({
        actorId: ctx.userId,
        workspaceId: ctx.workspaceId,
        scimGroupId: req.params.scimGroupId as string,
      });
      sendScimJson(res, 200, {
        schemas: [SCHEMA_GROUP],
        id: req.params.scimGroupId as string,
        deleted: true,
      });
    },
  );

  // ------------------------------------------------------------------
  // Error handling for SCIM endpoints: convert AppErrors to SCIM format.
  // ------------------------------------------------------------------

  router.use((err: unknown, _req: Request, res: Response, next: (err?: unknown) => void) => {
    if (isAppError(err)) {
      let scimType = 'invalidSyntax';
      switch (err.code) {
        case 'AUTHENTICATION_REQUIRED':
        case 'SCIM_TOKEN_INVALID':
        case 'SCIM_TOKEN_REVOKED':
        case 'SCIM_TOKEN_EXPIRED':
        case 'SESSION_REVOKED':
          scimType = 'invalidCredentials';
          break;
        case 'INSUFFICIENT_ROLE':
        case 'WORKSPACE_ACCESS_DENIED':
          scimType = 'noTarget';
          break;
        case 'SCIM_USER_NOT_FOUND':
        case 'SCIM_GROUP_NOT_FOUND':
        case 'SCIM_TOKEN_NOT_FOUND':
        case 'TEAM_NOT_FOUND':
        case 'WORKSPACE_MEMBER_NOT_FOUND':
          scimType = 'noTarget';
          break;
        case 'EMAIL_IN_USE':
        case 'SCIM_GROUP_EXISTS':
        case 'USER_DEACTIVATED':
          scimType = 'uniqueness';
          break;
        case 'VALIDATION_ERROR':
          scimType = 'invalidSyntax';
          break;
        default:
          scimType = 'invalidSyntax';
      }
      return sendScimError(res, err.statusCode, scimType, err.message);
    }
    next(err);
  });

  return router;
}

function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
