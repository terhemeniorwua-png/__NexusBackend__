import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { userWorkspaceAccessContext } from '../workspaces/authorization';
import { sendSuccess } from '../../utils/http';
import {
  addAssigneeSchema,
  addDependencySchema,
  assigneeParamsSchema,
  commentParamsSchema,
  completeSubtaskSchema,
  createCommentSchema,
  createTaskSchema,
  dependencyParamsSchema,
  listCommentsQuerySchema,
  listTasksQuerySchema,
  reviewTaskSchema,
  subtaskParamsSchema,
  submitTaskSchema,
  taskActivityQuerySchema,
  taskParamsSchema,
  taskWorkspaceProjectParamsSchema,
  updateCommentSchema,
  updateTaskSchema,
  type AddAssigneeInput,
  type AddDependencyInput,
  type CompleteSubtaskInput,
  type CreateCommentInput,
  type CreateTaskInput,
  type ListTaskActivityQuery,
  type ListTasksQuery,
  type ReviewTaskInput,
  type SubmitTaskInput,
  type UpdateCommentInput,
  type UpdateTaskInput,
} from './task.schemas';
import { createTaskAssignmentNotifier } from '../../services/task-assignment-notifier';
import { createMentionEmailNotifier } from '../../services/mention-email-notifier';
import { createTaskService } from './task.service';
import { createTaskAdvancedService } from './task-advanced.service';
import {
  recurrenceParamsSchema,
  setTaskCustomFieldValuesSchema,
  upsertRecurrenceSchema,
  type SetTaskCustomFieldValuesInput,
  type UpsertRecurrenceInput,
} from './task-advanced.schemas';

export interface TaskRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createTaskService>;
  advancedService?: ReturnType<typeof createTaskAdvancedService>;
}

function requestContext(req: Request) {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}

function authCtx(req: Request) {
  if (!req.auth)
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  return req.auth;
}

export function createTaskRouter({
  config,
  service = createTaskService(undefined, {
    assignmentNotifier: createTaskAssignmentNotifier(config),
    mentionNotifier: createMentionEmailNotifier(config),
  }),
  advancedService = createTaskAdvancedService(),
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
        await service.list({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, ...query }),
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
          { userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, ...body },
          requestContext(req),
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
        await service.get({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId }),
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
          { userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId, ...body },
          requestContext(req),
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
          { userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId },
          requestContext(req),
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
          { userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId },
          requestContext(req),
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
          { userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId },
          requestContext(req),
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
          { userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId },
          requestContext(req),
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
          { userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId },
          requestContext(req),
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
            userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)),
            workspaceId,
            projectId,
            taskId,
            targetUserId: body.targetUserId,
          },
          requestContext(req),
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
            userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)),
            workspaceId,
            projectId,
            taskId,
            targetUserId,
          },
          requestContext(req),
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
            userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)),
            workspaceId,
            projectId,
            taskId,
            dependsOnTaskId: body.dependsOnTaskId,
          },
          requestContext(req),
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
            userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)),
            workspaceId,
            projectId,
            taskId,
            dependsOnTaskId,
          },
          requestContext(req),
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
          userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)),
          workspaceId,
          projectId,
          taskId,
          limit: query.limit,
        }),
      );
    },
  );

  router.get(
    '/:taskId/workspace',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      sendSuccess(res, await service.getWorkspace({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId }));
    },
  );

  router.get(
    '/:taskId/activity',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema, query: taskActivityQuerySchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      const query = req.validated!.query as ListTaskActivityQuery;
      sendSuccess(
        res,
        await service.listActivity({
          userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)),
          workspaceId,
          projectId,
          taskId,
          cursor: query.cursor,
          limit: query.limit,
        }),
      );
    },
  );

  router.post(
    '/:taskId/submit',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema, body: submitTaskSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      const body = req.validated!.body as SubmitTaskInput;
      sendSuccess(
        res,
        await service.submit(
          { userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId, ...body },
          requestContext(req),
        ),
      );
    },
  );

  router.post(
    '/:taskId/review',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema, body: reviewTaskSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      const body = req.validated!.body as ReviewTaskInput;
      sendSuccess(
        res,
        await service.review(
          { userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId, ...body },
          requestContext(req),
        ),
      );
    },
  );

  router.post(
    '/:taskId/subtasks/:subtaskId/complete',
    requireAuth,
    requireActiveAccount,
    validate({ params: subtaskParamsSchema, body: completeSubtaskSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId, subtaskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
        subtaskId: string;
      };
      const body = req.validated!.body as CompleteSubtaskInput;
      sendSuccess(
        res,
        await service.completeSubtask(
          { userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId, subtaskId, ...body },
          requestContext(req),
        ),
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
          { userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId, ...body },
          requestContext(req),
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
            userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)),
            workspaceId,
            projectId,
            taskId,
            commentId,
            body: body.body,
          },
          requestContext(req),
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
          { userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId, commentId },
          requestContext(req),
        ),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Task custom field values
  // -------------------------------------------------------------------------

  router.get(
    '/:taskId/custom-fields',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as { workspaceId: string; projectId: string; taskId: string };
      sendSuccess(res, await advancedService.getTaskCustomFieldValues({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId }));
    },
  );

  router.put(
    '/:taskId/custom-fields',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema, body: setTaskCustomFieldValuesSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as { workspaceId: string; projectId: string; taskId: string };
      const body = req.validated!.body as SetTaskCustomFieldValuesInput;
      sendSuccess(res, await advancedService.setTaskCustomFieldValues({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId, values: body.values }, requestContext(req)));
    },
  );

  // -------------------------------------------------------------------------
  // Recurrence
  // -------------------------------------------------------------------------

  router.get(
    '/:taskId/recurrence',
    requireAuth,
    requireActiveAccount,
    validate({ params: recurrenceParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as { workspaceId: string; projectId: string; taskId: string };
      sendSuccess(res, await advancedService.getRecurrence({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId }));
    },
  );

  router.put(
    '/:taskId/recurrence',
    requireAuth,
    requireActiveAccount,
    validate({ params: recurrenceParamsSchema, body: upsertRecurrenceSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as { workspaceId: string; projectId: string; taskId: string };
      const body = req.validated!.body as UpsertRecurrenceInput;
      sendSuccess(res, await advancedService.upsertRecurrence({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId, ...body }, requestContext(req)));
    },
  );

  router.delete(
    '/:taskId/recurrence',
    requireAuth,
    requireActiveAccount,
    validate({ params: recurrenceParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as { workspaceId: string; projectId: string; taskId: string };
      sendSuccess(res, await advancedService.deleteRecurrence({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId }, requestContext(req)));
    },
  );

  router.post(
    '/:taskId/recurrence/generate',
    requireAuth,
    requireActiveAccount,
    validate({ params: recurrenceParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as { workspaceId: string; projectId: string; taskId: string };
      sendSuccess(res, await advancedService.generateNextRecurrence({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, projectId, taskId }, requestContext(req)), 201);
    },
  );

  return router;
}