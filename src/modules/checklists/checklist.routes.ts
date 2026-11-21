import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  checklistFeedbackParamsSchema,
  checklistItemParamsSchema,
  checklistParamsSchema,
  checklistProjectParamsSchema,
  createChecklistSchema,
  createFeedbackSchema,
  createItemSchema,
  listChecklistsQuerySchema,
  listFeedbackQuerySchema,
  reorderItemsSchema,
  updateChecklistSchema,
  updateFeedbackSchema,
  updateItemSchema,
  type CreateChecklistInput,
  type CreateFeedbackInput,
  type CreateItemInput,
  type ListChecklistsQuery,
  type ListFeedbackQuery,
  type ReorderItemsInput,
  type UpdateChecklistInput,
  type UpdateFeedbackInput,
  type UpdateItemInput,
} from './checklist.schemas';
import { createChecklistService } from './checklist.service';

export interface ChecklistRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createChecklistService>;
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in');
  return req.auth.userId;
}

export function createChecklistRouter({
  config,
  service: injectedService,
}: ChecklistRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();
  const service = injectedService ?? createChecklistService();

  // GET /workspaces/:workspaceId/projects/:projectId/checklists
  router.get(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistProjectParamsSchema, query: listChecklistsQuerySchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const query = req.validated!.query as ListChecklistsQuery;
      sendSuccess(
        res,
        await service.list({
          userId: userId(req),
          workspaceId,
          projectId,
          cursor: query.cursor,
          limit: query.limit,
        }),
      );
    },
  );

  // POST /workspaces/:workspaceId/projects/:projectId/checklists
  router.post(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({
      params: checklistProjectParamsSchema,
      body: createChecklistSchema,
    }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const body = req.validated!.body as CreateChecklistInput;
      sendSuccess(
        res,
        await service.create({
          userId: userId(req),
          workspaceId,
          projectId,
          title: body.title,
          description: body.description,
        }),
        201,
      );
    },
  );

  // GET /workspaces/:workspaceId/projects/:projectId/checklists/:checklistId
  router.get(
    '/:checklistId',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
      };
      sendSuccess(
        res,
        await service.get({ userId: userId(req), workspaceId, projectId, checklistId }),
      );
    },
  );

  // PATCH /workspaces/:workspaceId/projects/:projectId/checklists/:checklistId
  router.patch(
    '/:checklistId',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistParamsSchema, body: updateChecklistSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
      };
      const body = req.validated!.body as UpdateChecklistInput;
      sendSuccess(
        res,
        await service.update({
          userId: userId(req),
          workspaceId,
          projectId,
          checklistId,
          title: body.title,
          description: body.description,
        }),
      );
    },
  );

  // DELETE /workspaces/:workspaceId/projects/:projectId/checklists/:checklistId
  router.delete(
    '/:checklistId',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
      };
      sendSuccess(
        res,
        await service.delete({ userId: userId(req), workspaceId, projectId, checklistId }),
      );
    },
  );

  // Items are ordered by position and are not paginated (max 200 live items).
  router.get(
    '/:checklistId/items',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
      };
      sendSuccess(
        res,
        await service.listItems({ userId: userId(req), workspaceId, projectId, checklistId }),
      );
    },
  );

  router.post(
    '/:checklistId/items',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistParamsSchema, body: createItemSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
      };
      const body = req.validated!.body as CreateItemInput;
      sendSuccess(
        res,
        await service.createItem({
          userId: userId(req),
          workspaceId,
          projectId,
          checklistId,
          text: body.text,
        }),
        201,
      );
    },
  );

  router.post(
    '/:checklistId/items/reorder',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistParamsSchema, body: reorderItemsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
      };
      const body = req.validated!.body as ReorderItemsInput;
      sendSuccess(
        res,
        await service.reorderItems({
          userId: userId(req),
          workspaceId,
          projectId,
          checklistId,
          itemIds: body.itemIds,
        }),
      );
    },
  );

  router.patch(
    '/:checklistId/items/:itemId',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistItemParamsSchema, body: updateItemSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId, itemId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
        itemId: string;
      };
      const body = req.validated!.body as UpdateItemInput;
      sendSuccess(
        res,
        await service.updateItem({
          userId: userId(req),
          workspaceId,
          projectId,
          checklistId,
          itemId,
          text: body.text,
        }),
      );
    },
  );

  router.delete(
    '/:checklistId/items/:itemId',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistItemParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId, itemId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
        itemId: string;
      };
      sendSuccess(
        res,
        await service.deleteItem({
          userId: userId(req),
          workspaceId,
          projectId,
          checklistId,
          itemId,
        }),
      );
    },
  );

  router.post(
    '/:checklistId/items/:itemId/complete',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistItemParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId, itemId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
        itemId: string;
      };
      sendSuccess(
        res,
        await service.complete({ userId: userId(req), workspaceId, projectId, checklistId, itemId }),
      );
    },
  );

  router.post(
    '/:checklistId/items/:itemId/uncomplete',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistItemParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId, itemId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
        itemId: string;
      };
      sendSuccess(
        res,
        await service.uncomplete({
          userId: userId(req),
          workspaceId,
          projectId,
          checklistId,
          itemId,
        }),
      );
    },
  );

  router.post(
    '/:checklistId/items/:itemId/sign-off',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistItemParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId, itemId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
        itemId: string;
      };
      sendSuccess(
        res,
        await service.signOff({
          userId: userId(req),
          workspaceId,
          projectId,
          checklistId,
          itemId,
        }),
      );
    },
  );

  router.delete(
    '/:checklistId/items/:itemId/sign-off',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistItemParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId, itemId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
        itemId: string;
      };
      sendSuccess(
        res,
        await service.removeSignOff({
          userId: userId(req),
          workspaceId,
          projectId,
          checklistId,
          itemId,
        }),
      );
    },
  );

  // Feedback on one live checklist item (concrete FK, BE-3 parity).
  router.get(
    '/:checklistId/items/:itemId/feedback',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistItemParamsSchema, query: listFeedbackQuerySchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId, itemId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
        itemId: string;
      };
      const query = req.validated!.query as ListFeedbackQuery;
      sendSuccess(
        res,
        await service.listFeedback({
          userId: userId(req),
          workspaceId,
          projectId,
          checklistId,
          itemId,
          cursor: query.cursor,
          limit: query.limit,
        }),
      );
    },
  );

  router.post(
    '/:checklistId/items/:itemId/feedback',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistItemParamsSchema, body: createFeedbackSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId, itemId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
        itemId: string;
      };
      const body = req.validated!.body as CreateFeedbackInput;
      sendSuccess(
        res,
        await service.createFeedback({
          userId: userId(req),
          workspaceId,
          projectId,
          checklistId,
          itemId,
          body: body.body,
        }),
        201,
      );
    },
  );

  router.patch(
    '/:checklistId/items/:itemId/feedback/:feedbackId',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistFeedbackParamsSchema, body: updateFeedbackSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId, itemId, feedbackId } = req.validated!
        .params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
        itemId: string;
        feedbackId: string;
      };
      const body = req.validated!.body as UpdateFeedbackInput;
      sendSuccess(
        res,
        await service.editFeedback({
          userId: userId(req),
          workspaceId,
          projectId,
          checklistId,
          itemId,
          feedbackId,
          body: body.body,
        }),
      );
    },
  );

  router.delete(
    '/:checklistId/items/:itemId/feedback/:feedbackId',
    requireAuth,
    requireActiveAccount,
    validate({ params: checklistFeedbackParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, checklistId, itemId, feedbackId } = req.validated!
        .params as {
        workspaceId: string;
        projectId: string;
        checklistId: string;
        itemId: string;
        feedbackId: string;
      };
      sendSuccess(
        res,
        await service.deleteFeedback({
          userId: userId(req),
          workspaceId,
          projectId,
          checklistId,
          itemId,
          feedbackId,
        }),
      );
    },
  );

  return router;
}
