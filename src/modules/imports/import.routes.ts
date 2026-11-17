import { Router, type Request } from 'express';

type AuthenticatedRequest = Request & { user: { id: string } };
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { sendSuccess } from '../../utils/http';
import {
  importConfirmSchema,
  importJobParamsSchema,
  importUploadSchema,
  listImportsQuerySchema,
  type ImportConfirmInput,
  type ImportUploadInput,
} from './import.schemas';
import { createImportService } from './import.service';

export function createImportRouter(config: AppConfig): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();
  const service = createImportService();

  router.post(
    '/dry-run',
    requireAuth,
    requireActive,
    validate({ body: importUploadSchema }),
    async (req, res) => {
      const body = req.validated!.body as ImportUploadInput;
      sendSuccess(res, await service.createPreview({ userId: (req as AuthenticatedRequest).user.id, ...body }));
    },
  );

  router.post(
    '/:importId/confirm',
    requireAuth,
    requireActive,
    validate({ params: importJobParamsSchema, body: importConfirmSchema }),
    async (req, res) => {
      const { importId } = req.validated!.params as { importId: string };
      const body = req.validated!.body as ImportConfirmInput;
      sendSuccess(
        res,
        await service.confirm({ userId: (req as AuthenticatedRequest).user.id, importId, idempotencyKey: body.idempotencyKey }),
        202,
      );
    },
  );

  router.get(
    '/',
    requireAuth,
    requireActive,
    validate({ query: listImportsQuerySchema }),
    async (req, res) => {
      const { workspaceId, limit } = req.validated!.query as { workspaceId: string; limit?: number };
      sendSuccess(res, await service.list({ userId: (req as AuthenticatedRequest).user.id, workspaceId, limit }));
    },
  );

  router.get(
    '/:importId',
    requireAuth,
    requireActive,
    validate({ params: importJobParamsSchema }),
    async (req, res) => {
      const { importId } = req.validated!.params as { importId: string };
      sendSuccess(res, await service.get({ userId: (req as AuthenticatedRequest).user.id, importId }));
    },
  );

  return router;
}
