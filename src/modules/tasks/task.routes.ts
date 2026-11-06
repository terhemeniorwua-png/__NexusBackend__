import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  addAssigneeSchema,
  addDependencySchema,
  assigneeParamsSchema,
  commentParamsSchema,
  createCommentSchema,
  createTaskSchema,
  dependencyParamsSchema,
  listCommentsQuerySchema,
  listTasksQuerySchema,
  taskParamsSchema,
  taskWorkspaceProjectParamsSchema,
  updateCommentSchema,
  updateTaskSchema,
  type AddAssigneeInput,
  type AddDependencyInput,
  type CreateCommentInput,
  type CreateTaskInput,
  type ListTasksQuery,
  type UpdateCommentInput,
  type UpdateTaskInput,
} from './task.schemas';
import { createTaskService } from './task.service';

export interface TaskRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createTaskService>;
}

function context(req: Request) {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}

function userId(req: Request): string {
  if (!req.auth)
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  return req.auth.userId;
}

export function createTaskRouter({
  config,
  service = createTaskService(),
}: TaskRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();

  // -------------------------------------------------------------------------
  // Task collection
  // -------------------------------------------------------------------------

  router.get(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({
      params: taskWorkspaceProjectParamsSchema,
      query: listTasksQuerySchema,
    }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const query = req.validated!.query as ListTasksQuery;
      sendSuccess(
        res,
        await service.list({ userId: userId(req), workspaceId, projectId, ...query }),
      );
    },
  );

  router.post(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({
      params: taskWorkspaceProjectParamsSchema,
      body: createTaskSchema,
    }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const body = req.validated!.body as CreateTaskInput;
      sendSuccess(
        res,
        await service.create(
          { userId: userId(req), workspaceId, projectId, ...body },
          context(req),
        ),
        201,
      );
    },
  );

  // -------------------------------------------------------------------------
  // Single task
  // -------------------------------------------------------------------------

  router.get(
    '/:taskId',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      sendSuccess(
        res,
        await service.get({ userId: userId(req), workspaceId, projectId, taskId }),
      );
    },
  );

  router.patch(
    '/:taskId',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema, body: updateTaskSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      const body = req.validated!.body as UpdateTaskInput;
      sendSuccess(
        res,
        await service.update(
          { userId: userId(req), workspaceId, projectId, taskId, ...body },
          context(req),
        ),
      );
    },
  );

  router.delete(
    '/:taskId',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      sendSuccess(
        res,
        await service.remove(
          { userId: userId(req), workspaceId, projectId, taskId },
          context(req),
        ),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Archive / Restore
  // -------------------------------------------------------------------------

  router.post(
    '/:taskId/archive',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      sendSuccess(
        res,
        await service.archive(
          { userId: userId(req), workspaceId, projectId, taskId },
          context(req),
        ),
      );
    },
  );

  router.post(
    '/:taskId/restore',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      sendSuccess(
        res,
        await service.restore(
          { userId: userId(req), workspaceId, projectId, taskId },
          context(req),
        ),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Complete / Reopen
  // -------------------------------------------------------------------------

  router.post(
    '/:taskId/complete',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      sendSuccess(
        res,
        await service.complete(
          { userId: userId(req), workspaceId, projectId, taskId },
          context(req),
        ),
      );
    },
  );

  router.post(
    '/:taskId/reopen',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      sendSuccess(
        res,
        await service.reopen(
          { userId: userId(req), workspaceId, projectId, taskId },
          context(req),
        ),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Assignee management
  // -------------------------------------------------------------------------

  router.post(
    '/:taskId/assignees',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema, body: addAssigneeSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      const body = req.validated!.body as AddAssigneeInput;
      sendSuccess(
        res,
        await service.addAssignee(
          {
            userId: userId(req),
            workspaceId,
            projectId,
            taskId,
            targetUserId: body.targetUserId,
          },
          context(req),
        ),
        201,
      );
    },
  );

  router.delete(
    '/:taskId/assignees/:userId',
    requireAuth,
    requireActiveAccount,
    validate({ params: assigneeParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId, userId: targetUserId } = req.validated!
        .params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
        userId: string;
      };
      sendSuccess(
        res,
        await service.removeAssignee(
          {
            userId: userId(req),
            workspaceId,
            projectId,
            taskId,
            targetUserId,
          },
          context(req),
        ),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Dependency management
  // -------------------------------------------------------------------------

  router.post(
    '/:taskId/dependencies',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema, body: addDependencySchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      const body = req.validated!.body as AddDependencyInput;
      sendSuccess(
        res,
        await service.addDependency(
          {
            userId: userId(req),
            workspaceId,
            projectId,
            taskId,
            dependsOnTaskId: body.dependsOnTaskId,
          },
          context(req),
        ),
        201,
      );
    },
  );

  router.delete(
    '/:taskId/dependencies/:dependsOnTaskId',
    requireAuth,
    requireActiveAccount,
    validate({ params: dependencyParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId, dependsOnTaskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
        dependsOnTaskId: string;
      };
      sendSuccess(
        res,
        await service.removeDependency(
          {
            userId: userId(req),
            workspaceId,
            projectId,
            taskId,
            dependsOnTaskId,
          },
          context(req),
        ),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Comment management
  // -------------------------------------------------------------------------

  router.get(
    '/:taskId/comments',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema, query: listCommentsQuerySchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      const query = req.validated!.query as { limit: number };
      sendSuccess(
        res,
        await service.listComments({
          userId: userId(req),
          workspaceId,
          projectId,
          taskId,
          limit: query.limit,
        }),
      );
    },
  );

  router.post(
    '/:taskId/comments',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema, body: createCommentSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      const body = req.validated!.body as CreateCommentInput;
      sendSuccess(
        res,
        await service.addComment(
          { userId: userId(req), workspaceId, projectId, taskId, ...body },
          context(req),
        ),
        201,
      );
    },
  );

  router.patch(
    '/:taskId/comments/:commentId',
    requireAuth,
    requireActiveAccount,
    validate({ params: commentParamsSchema, body: updateCommentSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId, commentId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
        commentId: string;
      };
      const body = req.validated!.body as UpdateCommentInput;
      sendSuccess(
        res,
        await service.updateComment(
          {
            userId: userId(req),
            workspaceId,
            projectId,
            taskId,
            commentId,
            body: body.body,
          },
          context(req),
        ),
      );
    },
  );

  router.delete(
    '/:taskId/comments/:commentId',
    requireAuth,
    requireActiveAccount,
    validate({ params: commentParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId, commentId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
        commentId: string;
      };
      sendSuccess(
        res,
        await service.deleteComment(
          { userId: userId(req), workspaceId, projectId, taskId, commentId },
          context(req),
        ),
      );
    },
  );

  return router;
}
