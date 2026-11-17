import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { userWorkspaceAccessContext } from '../workspaces/authorization';
import { createTaskAdvancedService } from './task-advanced.service';
import {
  createCustomFieldSchema,
  customFieldParamsSchema,
  updateCustomFieldSchema,
  type CreateCustomFieldInput,
  type UpdateCustomFieldInput,
} from './task-advanced.schemas';
import { taskWorkspaceProjectParamsSchema } from './task.schemas';

export interface CustomFieldRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createTaskAdvancedService>;
}

function context(req: Request) { return { ip: req.ip, userAgent: req.header('user-agent') }; }
function authCtx(req: Request) {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  return req.auth;
}

export function createCustomFieldRouter({ config, service = createTaskAdvancedService() }: CustomFieldRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get('/', requireAuth, requireActive, validate({ params: taskWorkspaceProjectParamsSchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as { workspaceId: string; projectId: string };
    sendSuccess(res, await service.listCustomFields({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId }));
  });

  router.post('/', requireAuth, requireActive, validate({ params: taskWorkspaceProjectParamsSchema, body: createCustomFieldSchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as { workspaceId: string; projectId: string };
    const body = req.validated!.body as CreateCustomFieldInput;
    sendSuccess(res, await service.createCustomField({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, ...body }, context(req)), 201);
  });

  router.patch('/:fieldId', requireAuth, requireActive, validate({ params: customFieldParamsSchema, body: updateCustomFieldSchema }), async (req, res) => {
    const { workspaceId, projectId, fieldId } = req.validated!.params as { workspaceId: string; projectId: string; fieldId: string };
    const body = req.validated!.body as UpdateCustomFieldInput;
    sendSuccess(res, await service.updateCustomField({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, fieldId, ...body }, context(req)));
  });

  router.delete('/:fieldId', requireAuth, requireActive, validate({ params: customFieldParamsSchema }), async (req, res) => {
    const { workspaceId, projectId, fieldId } = req.validated!.params as { workspaceId: string; projectId: string; fieldId: string };
    sendSuccess(res, await service.deleteCustomField({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, fieldId }, context(req)));
  });

  return router;
}
