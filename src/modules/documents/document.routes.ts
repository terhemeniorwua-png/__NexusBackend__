import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  createDocumentCommentSchema,
  createDocumentSchema,
  documentCommentParamsSchema,
  documentParamsSchema,
  documentWorkspaceParamsSchema,
  listDocumentsQuerySchema,
  updateDocumentSchema,
  type CreateDocumentInput,
  type ListDocumentsQuery,
  type UpdateDocumentInput,
} from './document.schemas';
import { createDocumentService } from './document.service';

export interface DocumentRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createDocumentService>;
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in');
  return req.auth.userId;
}

export function createDocumentRouter({
  config,
  service = createDocumentService(),
}: DocumentRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();

  router.get('/', requireAuth, requireActiveAccount,
    validate({ params: documentWorkspaceParamsSchema, query: listDocumentsQuerySchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      const query = req.validated!.query as ListDocumentsQuery;
      sendSuccess(res, await service.list({ userId: userId(req), workspaceId, ...query }));
    });

  router.post('/', requireAuth, requireActiveAccount,
    validate({ params: documentWorkspaceParamsSchema, body: createDocumentSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      const body = req.validated!.body as CreateDocumentInput;
      sendSuccess(res, await service.create({ userId: userId(req), workspaceId, ...body }), 201);
    });

  router.get('/:documentId', requireAuth, requireActiveAccount,
    validate({ params: documentParamsSchema }),
    async (req, res) => {
      const { workspaceId, documentId } = req.validated!.params as { workspaceId: string; documentId: string };
      sendSuccess(res, await service.get({ userId: userId(req), workspaceId, documentId }));
    });

  router.patch('/:documentId', requireAuth, requireActiveAccount,
    validate({ params: documentParamsSchema, body: updateDocumentSchema }),
    async (req, res) => {
      const { workspaceId, documentId } = req.validated!.params as { workspaceId: string; documentId: string };
      const body = req.validated!.body as UpdateDocumentInput;
      sendSuccess(res, await service.update({ userId: userId(req), workspaceId, documentId, ...body }));
    });

  router.delete('/:documentId', requireAuth, requireActiveAccount,
    validate({ params: documentParamsSchema }),
    async (req, res) => {
      const { workspaceId, documentId } = req.validated!.params as { workspaceId: string; documentId: string };
      await service.delete({ userId: userId(req), workspaceId, documentId });
      sendSuccess(res, { ok: true });
    });

  router.get('/:documentId/revisions', requireAuth, requireActiveAccount,
    validate({ params: documentParamsSchema }),
    async (req, res) => {
      const { workspaceId, documentId } = req.validated!.params as { workspaceId: string; documentId: string };
      sendSuccess(res, await service.listRevisions({ userId: userId(req), workspaceId, documentId }));
    });

  router.get('/:documentId/comments', requireAuth, requireActiveAccount,
    validate({ params: documentParamsSchema }),
    async (req, res) => {
      const { workspaceId, documentId } = req.validated!.params as { workspaceId: string; documentId: string };
      sendSuccess(res, await service.listComments({ userId: userId(req), workspaceId, documentId }));
    });

  router.post('/:documentId/comments', requireAuth, requireActiveAccount,
    validate({ params: documentParamsSchema, body: createDocumentCommentSchema }),
    async (req, res) => {
      const { workspaceId, documentId } = req.validated!.params as { workspaceId: string; documentId: string };
      const { body } = req.validated!.body as { body: string };
      sendSuccess(res, await service.addComment({ userId: userId(req), workspaceId, documentId, body }), 201);
    });

  router.delete('/:documentId/comments/:commentId', requireAuth, requireActiveAccount,
    validate({ params: documentCommentParamsSchema }),
    async (req, res) => {
      const { workspaceId, documentId, commentId } = req.validated!.params as { workspaceId: string; documentId: string; commentId: string };
      await service.deleteComment({ userId: userId(req), workspaceId, documentId, commentId });
      sendSuccess(res, { ok: true });
    });

  return router;
}
