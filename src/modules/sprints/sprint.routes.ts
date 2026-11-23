import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  completeSprintSchema,
  createSprintSchema,
  emptySprintBodySchema,
  listSprintsQuerySchema,
  sprintParamsSchema,
  sprintTaskParamsSchema,
  sprintTasksBodySchema,
  sprintWorkspaceProjectParamsSchema,
  updateSprintSchema,
  type CompleteSprintInput,
  type CreateSprintInput,
  type ListSprintsQuery,
  type SprintTasksBodyInput,
  type UpdateSprintInput,
} from './sprint.schemas';
import { SprintService } from './sprint.service';

export interface SprintRouterOptions {
  config: AppConfig;
  service?: SprintService;
}

function context(req: Request) {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}

function userId(req: Request): string {
  if (!req.auth) {
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  }
  return req.auth.userId;
}

export function createSprintRouter({
  config,
  service = new SprintService(getPrismaClient()),
}: SprintRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();

  router.get(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: sprintWorkspaceProjectParamsSchema, query: listSprintsQuerySchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const query = req.validated!.query as ListSprintsQuery;
      sendSuccess(
        res,
        await service.list({ workspaceId, projectId, actorUserId: userId(req), ...query }),
      );
    },
  );

  router.post(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: sprintWorkspaceProjectParamsSchema, body: createSprintSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const body = req.validated!.body as CreateSprintInput;
      sendSuccess(
        res,
        await service.create(
          { workspaceId, projectId, actorUserId: userId(req), ...body },
          context(req),
        ),
        201,
      );
    },
  );

  router.get(
    '/history',
    requireAuth,
    requireActiveAccount,
    validate({ params: sprintWorkspaceProjectParamsSchema, query: listSprintsQuerySchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const query = req.validated!.query as ListSprintsQuery;
      sendSuccess(
        res,
        await service.history({ workspaceId, projectId, actorUserId: userId(req), ...query }),
      );
    },
  );

  router.patch(
    '/:sprintId',
    requireAuth,
    requireActiveAccount,
    validate({ params: sprintParamsSchema, body: updateSprintSchema }),
    async (req, res) => {
      const { workspaceId, projectId, sprintId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        sprintId: string;
      };
      const body = req.validated!.body as UpdateSprintInput;
      sendSuccess(
        res,
        await service.update(
          { workspaceId, projectId, sprintId, actorUserId: userId(req), ...body },
          context(req),
        ),
      );
    },
  );

  router.post(
    '/:sprintId/start',
    requireAuth,
    requireActiveAccount,
    validate({ params: sprintParamsSchema, body: emptySprintBodySchema }),
    async (req, res) => {
      const { workspaceId, projectId, sprintId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        sprintId: string;
      };
      sendSuccess(
        res,
        await service.start(
          { workspaceId, projectId, sprintId, actorUserId: userId(req) },
          context(req),
        ),
      );
    },
  );

  router.post(
    '/:sprintId/complete',
    requireAuth,
    requireActiveAccount,
    validate({ params: sprintParamsSchema, body: completeSprintSchema }),
    async (req, res) => {
      const { workspaceId, projectId, sprintId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        sprintId: string;
      };
      const body = req.validated!.body as CompleteSprintInput;
      sendSuccess(
        res,
        await service.complete(
          { workspaceId, projectId, sprintId, actorUserId: userId(req), ...body },
          context(req),
        ),
      );
    },
  );

  router.post(
    '/:sprintId/restore',
    requireAuth,
    requireActiveAccount,
    validate({ params: sprintParamsSchema, body: emptySprintBodySchema }),
    async (req, res) => {
      const { workspaceId, projectId, sprintId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        sprintId: string;
      };
      sendSuccess(
        res,
        await service.restore(
          { workspaceId, projectId, sprintId, actorUserId: userId(req) },
          context(req),
        ),
      );
    },
  );

  router.post(
    '/:sprintId/tasks',
    requireAuth,
    requireActiveAccount,
    validate({ params: sprintParamsSchema, body: sprintTasksBodySchema }),
    async (req, res) => {
      const { workspaceId, projectId, sprintId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        sprintId: string;
      };
      const body = req.validated!.body as SprintTasksBodyInput;
      sendSuccess(
        res,
        await service.addTasks(
          { workspaceId, projectId, sprintId, actorUserId: userId(req), ...body },
          context(req),
        ),
      );
    },
  );

  router.delete(
    '/:sprintId/tasks/:taskId',
    requireAuth,
    requireActiveAccount,
    validate({ params: sprintTaskParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, sprintId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        sprintId: string;
        taskId: string;
      };
      sendSuccess(
        res,
        await service.removeTask(
          { workspaceId, projectId, sprintId, taskId, actorUserId: userId(req) },
          context(req),
        ),
      );
    },
  );

  return router;
}
