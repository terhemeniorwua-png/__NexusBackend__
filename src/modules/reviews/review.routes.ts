import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  approveReviewSchema,
  assignReviewSchema,
  createReviewSchema,
  listReviewsQuerySchema,
  rejectReviewSchema,
  requestChangesReviewSchema,
  resubmitReviewSchema,
  reviewParamsSchema,
  reviewProjectParamsSchema,
  type ApproveReviewInput,
  type AssignReviewInput,
  type CreateReviewInput,
  type ListReviewsQuery,
  type RejectReviewInput,
  type RequestChangesReviewInput,
  type ResubmitReviewInput,
} from './review.schemas';
import { createReviewService } from './review.service';

export interface ReviewRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createReviewService>;
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  return req.auth.userId;
}

export function createReviewRouter({ config, service: injectedService }: ReviewRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();
  const service = injectedService ?? createReviewService();

  // GET /workspaces/:workspaceId/projects/:projectId/reviews
  router.get(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: reviewProjectParamsSchema, query: listReviewsQuerySchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const query = req.validated!.query as ListReviewsQuery;
      sendSuccess(
        res,
        await service.list({
          userId: userId(req),
          workspaceId,
          projectId,
          targetKind: query.targetKind,
          targetId: query.targetId,
          status: query.status,
          assigneeId: query.assigneeId,
          cursor: query.cursor,
          limit: query.limit,
        }),
      );
    },
  );

  // POST /workspaces/:workspaceId/projects/:projectId/reviews
  router.post(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: reviewProjectParamsSchema, body: createReviewSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const body = req.validated!.body as CreateReviewInput;
      sendSuccess(
        res,
        await service.create({
          userId: userId(req),
          workspaceId,
          projectId,
          attachmentVersionId: body.attachmentVersionId,
          checklistId: body.checklistId,
          assigneeId: body.assigneeId,
        }),
        201,
      );
    },
  );

  // POST /workspaces/:workspaceId/projects/:projectId/reviews/:reviewId/assign
  router.post(
    '/:reviewId/assign',
    requireAuth,
    requireActiveAccount,
    validate({ params: reviewParamsSchema, body: assignReviewSchema }),
    async (req, res) => {
      const { workspaceId, projectId, reviewId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        reviewId: string;
      };
      const body = req.validated!.body as AssignReviewInput;
      sendSuccess(
        res,
        await service.assign({
          userId: userId(req),
          workspaceId,
          projectId,
          reviewId,
          assigneeId: body.assigneeId,
        }),
      );
    },
  );

  // POST /workspaces/:workspaceId/projects/:projectId/reviews/:reviewId/start
  router.post(
    '/:reviewId/start',
    requireAuth,
    requireActiveAccount,
    validate({ params: reviewParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, reviewId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        reviewId: string;
      };
      sendSuccess(
        res,
        await service.start({ userId: userId(req), workspaceId, projectId, reviewId }),
      );
    },
  );

  // POST /workspaces/:workspaceId/projects/:projectId/reviews/:reviewId/resubmit
  router.post(
    '/:reviewId/resubmit',
    requireAuth,
    requireActiveAccount,
    validate({ params: reviewParamsSchema, body: resubmitReviewSchema }),
    async (req, res) => {
      const { workspaceId, projectId, reviewId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        reviewId: string;
      };
      const body = req.validated!.body as ResubmitReviewInput;
      sendSuccess(
        res,
        await service.resubmit({
          userId: userId(req),
          workspaceId,
          projectId,
          reviewId,
          round: body.round,
        }),
      );
    },
  );

  // POST /workspaces/:workspaceId/projects/:projectId/reviews/:reviewId/approve
  router.post(
    '/:reviewId/approve',
    requireAuth,
    requireActiveAccount,
    validate({ params: reviewParamsSchema, body: approveReviewSchema }),
    async (req, res) => {
      const { workspaceId, projectId, reviewId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        reviewId: string;
      };
      const body = req.validated!.body as ApproveReviewInput;
      sendSuccess(
        res,
        await service.approve({
          userId: userId(req),
          workspaceId,
          projectId,
          reviewId,
          round: body.round,
          note: body.note,
        }),
      );
    },
  );

  // POST /workspaces/:workspaceId/projects/:projectId/reviews/:reviewId/reject
  router.post(
    '/:reviewId/reject',
    requireAuth,
    requireActiveAccount,
    validate({ params: reviewParamsSchema, body: rejectReviewSchema }),
    async (req, res) => {
      const { workspaceId, projectId, reviewId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        reviewId: string;
      };
      const body = req.validated!.body as RejectReviewInput;
      sendSuccess(
        res,
        await service.reject({
          userId: userId(req),
          workspaceId,
          projectId,
          reviewId,
          round: body.round,
          note: body.note,
        }),
      );
    },
  );

  // POST /workspaces/:workspaceId/projects/:projectId/reviews/:reviewId/request-changes
  router.post(
    '/:reviewId/request-changes',
    requireAuth,
    requireActiveAccount,
    validate({ params: reviewParamsSchema, body: requestChangesReviewSchema }),
    async (req, res) => {
      const { workspaceId, projectId, reviewId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        reviewId: string;
      };
      const body = req.validated!.body as RequestChangesReviewInput;
      sendSuccess(
        res,
        await service.requestChanges({
          userId: userId(req),
          workspaceId,
          projectId,
          reviewId,
          round: body.round,
          note: body.note,
        }),
      );
    },
  );

  // GET /workspaces/:workspaceId/projects/:projectId/reviews/:reviewId
  router.get(
    '/:reviewId',
    requireAuth,
    requireActiveAccount,
    validate({ params: reviewParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, reviewId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        reviewId: string;
      };
      sendSuccess(
        res,
        await service.get({ userId: userId(req), workspaceId, projectId, reviewId }),
      );
    },
  );

  return router;
}
