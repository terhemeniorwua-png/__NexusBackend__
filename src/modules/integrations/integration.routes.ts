import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { connectIntegrationSchema, disconnectParamsSchema, listIntegrationsQuerySchema, type ConnectIntegrationInput, type ListIntegrationsQuery } from './integration.schemas';
import { createIntegrationService } from './integration.service';
import { getPrismaClient } from '../../db/prisma';
import { logger } from '../../utils/logger';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import { buildSlackAuthorizeUrl, exchangeSlackCode, slackAuthorizeQuerySchema, slackCallbackQuerySchema, slackResultUrl, verifySlackState } from './slack.oauth';

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
    // Slack tokens may only arrive through the OAuth callback, never from a client-supplied body.
    if (body.provider === 'SLACK') {
      throw new AppError(400, 'USE_SLACK_OAUTH', 'Connect Slack through the Slack authorization flow');
    }
    sendSuccess(res, await service.connect({ userId: userId(req), ...body }), 201);
  });

  router.delete('/:integrationId', requireAuth, requireActive, validate({ params: disconnectParamsSchema }), async (req, res) => {
    const { integrationId } = req.validated!.params as { integrationId: string };
    await service.disconnect({ userId: userId(req), integrationId });
    sendSuccess(res, { ok: true });
  });

  // Slack step 1 (authenticated): the frontend asks for the Slack consent URL.
  router.get('/slack/authorize', requireAuth, requireActive, validate({ query: slackAuthorizeQuerySchema }), async (req, res) => {
    const { workspaceId } = req.validated!.query as { workspaceId: string };
    await requireWorkspaceAccess(getPrismaClient(), { userId: userId(req), workspaceId, capability: WorkspaceCapability.ViewWorkspace });
    sendSuccess(res, { url: buildSlackAuthorizeUrl({ userId: userId(req), workspaceId }) });
  });

  // Slack step 2 (public): Slack redirects the browser here. Identity comes from the signed state.
  router.get('/slack/callback', async (req, res) => {
    const done = (status: 'connected' | 'denied' | 'error') => res.redirect(302, slackResultUrl(status));
    const parsed = slackCallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) return done('error');
    const { code, state, error } = parsed.data;
    if (error) return done('denied');
    if (!code) return done('error');
    try {
      const claims = verifySlackState(state);
      const token = await exchangeSlackCode(code);
      await service.connect({ userId: claims.userId, provider: 'SLACK', workspaceId: claims.workspaceId, ...token });
      return done('connected');
    } catch (err) {
      logger.warn('slack_oauth_failed', { error: err });
      return done('error');
    }
  });

  return router;
}
