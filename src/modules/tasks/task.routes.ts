import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  acceptTaskSchema,
  addAssigneeSchema,
  addDependencySchema,
  assigneeParamsSchema,
  commentParamsSchema,
  completeSubtaskSchema,
  createCommentSchema,
  createTaskSchema,
  declineTaskSchema,
  dependencyParamsSchema,
  listCommentsQuerySchema,
  listTasksQuerySchema,
  reviewTaskSchema,
  startTaskSchema,
  subtaskParamsSchema,
  submitTaskSchema,
  taskActivityQuerySchema,
  taskParamsSchema,
  taskWorkspaceProjectParamsSchema,
  updateCommentSchema,
  updateTaskSchema,
  type AcceptTaskInput,
  type AddAssigneeInput,
  type AddDependencyInput,
  type CompleteSubtaskInput,
  type CreateCommentInput,
  type CreateTaskInput,
  type DeclineTaskInput,
  type ListTaskActivityQuery,
  type ListTasksQuery,
  type ReviewTaskInput,
  type StartTaskInput,
  type SubmitTaskInput,
  type UpdateCommentInput,
  type UpdateTaskInput,
} from './task.schemas';
import { createTaskAssignmentNotifier } from '../../services/task-assignment-notifier';
import { createMentionEmailNotifier } from '../../services/mention-email-notifier';
import { createSlackEventNotifier } from '../integrations/slack.events';
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
  service = createTaskService(undefined, {
    config,
    assignmentNotifier: createTaskAssignmentNotifier(config),
    mentionNotifier: createMentionEmailNotifier(config),
    slackNotifier: createSlackEventNotifier(),
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
      sendSuccess(res, await service.getWorkspace({ userId: userId(req), workspaceId, projectId, taskId }));
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
          userId: userId(req),
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
          { userId: userId(req), workspaceId, projectId, taskId, ...body },
          context(req),
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
          { userId: userId(req), workspaceId, projectId, taskId, ...body },
          context(req),
        ),
      );
    },
  );

  router.post(
    '/:taskId/accept',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema, body: acceptTaskSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      void (req.validated!.body as AcceptTaskInput);
      sendSuccess(
        res,
        await service.acceptTask(
          { userId: userId(req), workspaceId, projectId, taskId },
          context(req),
        ),
      );
    },
  );

  router.post(
    '/:taskId/decline',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema, body: declineTaskSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      const body = req.validated!.body as DeclineTaskInput;
      sendSuccess(
        res,
        await service.declineTask(
          { userId: userId(req), workspaceId, projectId, taskId, reason: body.reason },
          context(req),
        ),
      );
    },
  );

  router.post(
    '/:taskId/start',
    requireAuth,
    requireActiveAccount,
    validate({ params: taskParamsSchema, body: startTaskSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        taskId: string;
      };
      void (req.validated!.body as StartTaskInput);
      sendSuccess(
        res,
        await service.startTask(
          { userId: userId(req), workspaceId, projectId, taskId },
          context(req),
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
          { userId: userId(req), workspaceId, projectId, taskId, subtaskId, ...body },
          context(req),
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
      sendSuccess(res, await advancedService.getTaskCustomFieldValues({ userId: userId(req), workspaceId, projectId, taskId }));
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
      sendSuccess(res, await advancedService.setTaskCustomFieldValues({ userId: userId(req), workspaceId, projectId, taskId, values: body.values }, context(req)));
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
      sendSuccess(res, await advancedService.getRecurrence({ userId: userId(req), workspaceId, projectId, taskId }));
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
      sendSuccess(res, await advancedService.upsertRecurrence({ userId: userId(req), workspaceId, projectId, taskId, ...body }, context(req)));
    },
  );

  router.delete(
    '/:taskId/recurrence',
    requireAuth,
    requireActiveAccount,
    validate({ params: recurrenceParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as { workspaceId: string; projectId: string; taskId: string };
      sendSuccess(res, await advancedService.deleteRecurrence({ userId: userId(req), workspaceId, projectId, taskId }, context(req)));
    },
  );

  router.post(
    '/:taskId/recurrence/generate',
    requireAuth,
    requireActiveAccount,
    validate({ params: recurrenceParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as { workspaceId: string; projectId: string; taskId: string };
      sendSuccess(res, await advancedService.generateNextRecurrence({ userId: userId(req), workspaceId, projectId, taskId }, context(req)), 201);
    },
  );

  return router;
}
export function createMyTasksRouter({ config }: { config: AppConfig }): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();
  const service = createTaskService();

  router.get(
    '/mine',
    requireAuth,
    requireActiveAccount,
    validate({
      params: z.object({ workspaceId: z.string().uuid() }),
      query: listTasksQuerySchema,
    }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      const query = req.validated!.query as ListTasksQuery;
      sendSuccess(res, await service.listMine({ userId: userId(req), workspaceId, ...query }));
    },
  );

  return router;
}
