import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { createTaskAdvancedService } from './task-advanced.service';
import {
  createSavedViewSchema,
  savedViewParamsSchema,
  updateSavedViewSchema,
  type CreateSavedViewInput,
  type UpdateSavedViewInput,
} from './task-advanced.schemas';
import { taskWorkspaceProjectParamsSchema } from './task.schemas';

export interface SavedViewRouterOptions { config: AppConfig; service?: ReturnType<typeof createTaskAdvancedService>; }
function context(req: Request) { return { ip: req.ip, userAgent: req.header('user-agent') }; }
function userId(req: Request): string { if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue'); return req.auth.userId; }

export function createSavedViewRouter({ config, service = createTaskAdvancedService() }: SavedViewRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get('/', requireAuth, requireActive, validate({ params: taskWorkspaceProjectParamsSchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as { workspaceId: string; projectId: string };
    sendSuccess(res, await service.listSavedViews({ userId: userId(req), workspaceId, projectId }));
  });
  router.post('/', requireAuth, requireActive, validate({ params: taskWorkspaceProjectParamsSchema, body: createSavedViewSchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as { workspaceId: string; projectId: string };
    const body = req.validated!.body as CreateSavedViewInput;
    sendSuccess(res, await service.createSavedView({ userId: userId(req), workspaceId, projectId, ...body }, context(req)), 201);
  });
  router.patch('/:viewId', requireAuth, requireActive, validate({ params: savedViewParamsSchema, body: updateSavedViewSchema }), async (req, res) => {
    const { workspaceId, projectId, viewId } = req.validated!.params as { workspaceId: string; projectId: string; viewId: string };
    const body = req.validated!.body as UpdateSavedViewInput;
    sendSuccess(res, await service.updateSavedView({ userId: userId(req), workspaceId, projectId, viewId, ...body }, context(req)));
  });
  router.delete('/:viewId', requireAuth, requireActive, validate({ params: savedViewParamsSchema }), async (req, res) => {
    const { workspaceId, projectId, viewId } = req.validated!.params as { workspaceId: string; projectId: string; viewId: string };
    sendSuccess(res, await service.deleteSavedView({ userId: userId(req), workspaceId, projectId, viewId }, context(req)));
  });
  return router;
}
