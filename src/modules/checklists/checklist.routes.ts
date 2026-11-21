import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  checklistParamsSchema,
  checklistProjectParamsSchema,
  createChecklistSchema,
  listChecklistsQuerySchema,
  updateChecklistSchema,
  type CreateChecklistInput,
  type ListChecklistsQuery,
  type UpdateChecklistInput,
} from './checklist.schemas';
import { createChecklistService } from './checklist.service';

export interface ChecklistRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createChecklistService>;
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in');
  return req.auth.userId;
}

export function createChecklistRouter({
  config,
  service: injectedService,
}: ChecklistRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();
  const service = injectedService ?? createChecklistService();

  // GET /workspaces/:workspaceId/projects/:projectId/checklists
  router.get(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistProjectParamsSchema, query: listChecklistsQuerySchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const query = req.validated!.query as ListChecklistsQuery;
      sendSuccess(
        res,
        await service.list({
          userId: userId(req),
          workspaceId,
          projectId,
          cursor: query.cursor,
          limit: query.limit,
        }),
      );
    },
  );

  // POST /workspaces/:workspaceId/projects/:projectId/checklists
  router.post(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({
      params: checklistProjectParamsSchema,
      body: createChecklistSchema,
    }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const body = req.validated!.body as CreateChecklistInput;
      sendSuccess(
        res,
        await service.create({
          userId: userId(req),
          workspaceId,
          projectId,
          title: body.title,
          description: body.description,
        }),
        201,
      );
    },
  );

  // GET /workspaces/:workspaceId/projects/:projectId/checklists/:checklistId
  router.get(
    '/:checklistId',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
      };
      sendSuccess(
        res,
        await service.get({ userId: userId(req), workspaceId, projectId, checklistId }),
      );
    },
  );

  // PATCH /workspaces/:workspaceId/projects/:projectId/checklists/:checklistId
  router.patch(
    '/:checklistId',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistParamsSchema, body: updateChecklistSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
      };
      const body = req.validated!.body as UpdateChecklistInput;
      sendSuccess(
        res,
        await service.update({
          userId: userId(req),
          workspaceId,
          projectId,
          checklistId,
          title: body.title,
          description: body.description,
        }),
      );
    },
  );

  // DELETE /workspaces/:workspaceId/projects/:projectId/checklists/:checklistId
  router.delete(
    '/:checklistId',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
      };
      sendSuccess(
        res,
        await service.delete({ userId: userId(req), workspaceId, projectId, checklistId }),
      );
    },
  );

  return router;
}
