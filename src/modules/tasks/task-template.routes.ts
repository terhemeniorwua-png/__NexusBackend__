import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { userWorkspaceAccessContext } from '../workspaces/authorization';
import { createTaskAdvancedService } from './task-advanced.service';
import {
  createTaskFromTemplateSchema,
  createTaskTemplateSchema,
  taskTemplateParamsSchema,
  updateTaskTemplateSchema,
  type CreateTaskTemplateInput,
  type UpdateTaskTemplateInput,
} from './task-advanced.schemas';
import { taskWorkspaceProjectParamsSchema } from './task.schemas';

export interface TaskTemplateRouterOptions { config: AppConfig; service?: ReturnType<typeof createTaskAdvancedService>; }
function context(req: Request) { return { ip: req.ip, userAgent: req.header('user-agent') }; }
function authCtx(req: Request) {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  return req.auth;
}

export function createTaskTemplateRouter({ config, service = createTaskAdvancedService() }: TaskTemplateRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get('/', requireAuth, requireActive, validate({ params: taskWorkspaceProjectParamsSchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as { workspaceId: string; projectId: string };
    sendSuccess(res, await service.listTaskTemplates({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId }));
  });
  router.post('/', requireAuth, requireActive, validate({ params: taskWorkspaceProjectParamsSchema, body: createTaskTemplateSchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as { workspaceId: string; projectId: string };
    const body = req.validated!.body as CreateTaskTemplateInput;
    sendSuccess(res, await service.createTaskTemplate({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, ...body }, context(req)), 201);
  });
  router.patch('/:templateId', requireAuth, requireActive, validate({ params: taskTemplateParamsSchema, body: updateTaskTemplateSchema }), async (req, res) => {
    const { workspaceId, projectId, templateId } = req.validated!.params as { workspaceId: string; projectId: string; templateId: string };
    const body = req.validated!.body as UpdateTaskTemplateInput;
    sendSuccess(res, await service.updateTaskTemplate({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, templateId, ...body }, context(req)));
  });
  router.delete('/:templateId', requireAuth, requireActive, validate({ params: taskTemplateParamsSchema }), async (req, res) => {
    const { workspaceId, projectId, templateId } = req.validated!.params as { workspaceId: string; projectId: string; templateId: string };
    sendSuccess(res, await service.deleteTaskTemplate({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, templateId }, context(req)));
  });
  router.post('/:templateId/create-task', requireAuth, requireActive, validate({ params: taskTemplateParamsSchema, body: createTaskFromTemplateSchema }), async (req, res) => {
    const { workspaceId, projectId, templateId } = req.validated!.params as { workspaceId: string; projectId: string; templateId: string };
    const body = req.validated!.body as { title?: string; assigneeIds?: string[]; startDate?: string | null; dueDate?: string | null };
    sendSuccess(res, await service.createTaskFromTemplate({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, templateId, ...body }, context(req)), 201);
  });
  return router;
}
