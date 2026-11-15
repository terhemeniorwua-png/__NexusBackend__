import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  createTaskTimeEntrySchema,
  taskTimeEntryParamsSchema,
  taskTimeEntryTaskParamsSchema,
  updateTaskTimeEntrySchema,
  type CreateTaskTimeEntryInput,
  type UpdateTaskTimeEntryInput,
} from './task-time-entry.schemas';
import { createTaskTimeEntryService } from './task-time-entry.service';

type TaskParams = { workspaceId: string; projectId: string; taskId: string };
type EntryParams = TaskParams & { entryId: string };

function context(req: Request) {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  return req.auth.userId;
}

export function createTaskTimeEntryRouter(options: {
  config: AppConfig;
  service?: ReturnType<typeof createTaskTimeEntryService>;
}): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(options.config);
  const requireActiveAccount = createRequireActiveAccount();
  const service = options.service ?? createTaskTimeEntryService();

  router.get(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskTimeEntryTaskParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as TaskParams;
      sendSuccess(res, await service.list({ userId: userId(req), workspaceId, projectId, taskId }));
    },
  );

  router.post(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskTimeEntryTaskParamsSchema, body: createTaskTimeEntrySchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as TaskParams;
      const body = req.validated!.body as CreateTaskTimeEntryInput;
      sendSuccess(
        res,
        await service.log(
          { userId: userId(req), workspaceId, projectId, taskId, ...body },
          context(req),
        ),
        201,
      );
    },
  );

  router.patch(
    '/:entryId',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskTimeEntryParamsSchema, body: updateTaskTimeEntrySchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId, entryId } = req.validated!.params as EntryParams;
      const body = req.validated!.body as UpdateTaskTimeEntryInput;
      sendSuccess(
        res,
        await service.update(
          { userId: userId(req), workspaceId, projectId, taskId, entryId, ...body },
          context(req),
        ),
      );
    },
  );

  router.delete(
    '/:entryId',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskTimeEntryParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId, entryId } = req.validated!.params as EntryParams;
      sendSuccess(
        res,
        await service.remove({ userId: userId(req), workspaceId, projectId, taskId, entryId }, context(req)),
      );
    },
  );

  return router;
}
