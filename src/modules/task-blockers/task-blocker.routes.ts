import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  createTaskBlockerSchema,
  resolveTaskBlockerSchema,
  taskBlockerParamsSchema,
  taskBlockerTaskParamsSchema,
  type CreateTaskBlockerInput,
} from './task-blocker.schemas';
import { createTaskBlockerService } from './task-blocker.service';

function context(req: Request) {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  return req.auth.userId;
}

type TaskParams = { workspaceId: string; projectId: string; taskId: string };
type BlockerParams = TaskParams & { blockerId: string };

export function createTaskBlockerRouter(options: {
  config: AppConfig;
  service?: ReturnType<typeof createTaskBlockerService>;
}): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(options.config);
  const requireActiveAccount = createRequireActiveAccount();
  const service = options.service ?? createTaskBlockerService();

  router.get(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskBlockerTaskParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as TaskParams;
      sendSuccess(res, await service.list({ userId: userId(req), workspaceId, projectId, taskId }));
    },
  );

  router.post(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskBlockerTaskParamsSchema, body: createTaskBlockerSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as TaskParams;
      const body = req.validated!.body as CreateTaskBlockerInput;
      sendSuccess(
        res,
        await service.report(
          { userId: userId(req), workspaceId, projectId, taskId, description: body.description, notifyUserId: body.notifyUserId },
          context(req),
        ),
        201,
      );
    },
  );

  router.post(
    '/:blockerId/resolve',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskBlockerParamsSchema, body: resolveTaskBlockerSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId, blockerId } = req.validated!.params as BlockerParams;
      sendSuccess(
        res,
        await service.resolve({ userId: userId(req), workspaceId, projectId, taskId, blockerId }, context(req)),
      );
    },
  );

  return router;
}
