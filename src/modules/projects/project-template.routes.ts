import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { userWorkspaceAccessContext } from '../workspaces/authorization';
import { createTaskAdvancedService } from '../tasks/task-advanced.service';
import {
  createProjectFromTemplateSchema,
  createProjectTemplateSchema,
  updateProjectTemplateSchema,
  type CreateProjectTemplateInput,
  type UpdateProjectTemplateInput,
} from '../tasks/task-advanced.schemas';

export interface ProjectTemplateRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createTaskAdvancedService>;
}

function context(req: Request) {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}
function authCtx(req: Request) {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  return req.auth;
}

const paramsSchema = z.object({ workspaceId: z.string().uuid() });
const templateParamsSchema = z.object({ workspaceId: z.string().uuid(), templateId: z.string().uuid() });

export function createProjectTemplateRouter({ config, service = createTaskAdvancedService() }: ProjectTemplateRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get('/', requireAuth, requireActive, validate({ params: paramsSchema }), async (req, res) => {
    const { workspaceId } = req.validated!.params as { workspaceId: string };
    sendSuccess(res, await service.listProjectTemplates({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId }));
  });

  router.post('/', requireAuth, requireActive, validate({ params: paramsSchema, body: createProjectTemplateSchema }), async (req, res) => {
    const { workspaceId } = req.validated!.params as { workspaceId: string };
    const body = req.validated!.body as CreateProjectTemplateInput;
    sendSuccess(res, await service.createProjectTemplate({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, ...body }, context(req)), 201);
  });

  router.patch('/:templateId', requireAuth, requireActive, validate({ params: templateParamsSchema, body: updateProjectTemplateSchema }), async (req, res) => {
    const { workspaceId, templateId } = req.validated!.params as { workspaceId: string; templateId: string };
    const body = req.validated!.body as UpdateProjectTemplateInput;
    sendSuccess(res, await service.updateProjectTemplate({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, templateId, ...body }, context(req)));
  });

  router.delete('/:templateId', requireAuth, requireActive, validate({ params: templateParamsSchema }), async (req, res) => {
    const { workspaceId, templateId } = req.validated!.params as { workspaceId: string; templateId: string };
    sendSuccess(res, await service.deleteProjectTemplate({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, templateId }, context(req)));
  });

  router.post('/:templateId/create-project', requireAuth, requireActive, validate({ params: templateParamsSchema, body: createProjectFromTemplateSchema }), async (req, res) => {
    const { workspaceId, templateId } = req.validated!.params as { workspaceId: string; templateId: string };
    const body = req.validated!.body as { name: string; key: string; description?: string | null };
    sendSuccess(res, await service.createProjectFromTemplate({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, templateId, ...body }, context(req)), 201);
  });

  return router;
}
