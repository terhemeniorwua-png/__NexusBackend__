import { Router, type Request } from 'express';
import { AppError } from '../../utils/errors';
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

function authUserId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in');
  return req.auth.userId;
}

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
      sendSuccess(res, await service.createPreview({ userId: authUserId(req), ...body }));
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
        await service.confirm({ userId: authUserId(req), importId, idempotencyKey: body.idempotencyKey }),
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
      sendSuccess(res, await service.list({ userId: authUserId(req), workspaceId, limit }));
    },
  );

  router.get(
    '/:importId',
    requireAuth,
    requireActive,
    validate({ params: importJobParamsSchema }),
    async (req, res) => {
      const { importId } = req.validated!.params as { importId: string };
      sendSuccess(res, await service.get({ userId: authUserId(req), importId }));
    },
  );

  return router;
}