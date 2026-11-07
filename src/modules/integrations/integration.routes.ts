import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { connectIntegrationSchema, disconnectParamsSchema, listIntegrationsQuerySchema, type ConnectIntegrationInput, type ListIntegrationsQuery } from './integration.schemas';
import { createIntegrationService } from './integration.service';

export interface IntegrationRouterOptions { config: AppConfig; service?: ReturnType<typeof createIntegrationService> }
function userId(req: Request): string { if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in'); return req.auth.userId; }

export function createIntegrationRouter({ config, service = createIntegrationService() }: IntegrationRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get('/', requireAuth, requireActive, validate({ query: listIntegrationsQuerySchema }), async (req, res) => {
    const q = req.validated!.query as ListIntegrationsQuery;
    sendSuccess(res, await service.list({ userId: userId(req), workspaceId: q.workspaceId }));
  });

  router.post('/', requireAuth, requireActive, validate({ body: connectIntegrationSchema }), async (req, res) => {
    const body = req.validated!.body as ConnectIntegrationInput;
    sendSuccess(res, await service.connect({ userId: userId(req), ...body }), 201);
  });

  router.delete('/:integrationId', requireAuth, requireActive, validate({ params: disconnectParamsSchema }), async (req, res) => {
    const { integrationId } = req.validated!.params as { integrationId: string };
    await service.disconnect({ userId: userId(req), integrationId });
    sendSuccess(res, { ok: true });
  });

  return router;
}
