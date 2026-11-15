import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { logger } from '../../utils/logger';
import {
  connectionParamsSchema,
  githubCallbackQuerySchema,
  linkRepositorySchema,
  projectParamsSchema,
  projectRepoParamsSchema,
  workspaceParamsSchema,
} from './dev-integration.schemas';
import { createDevIntegrationService } from './dev-integration.service';

export interface DevIntegrationRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createDevIntegrationService>;
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in');
  return req.auth.userId;
}

export function createWorkspaceDevIntegrationRouter({
  config,
  service = createDevIntegrationService(config),
}: DevIntegrationRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  // GET /workspaces/:workspaceId/dev-integrations/connections
  router.get(
    '/connections',
    requireAuth,
    requireActive,
    validate({ params: workspaceParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(res, await service.listConnections({ userId: userId(req), workspaceId }));
    },
  );

  // GET /workspaces/:workspaceId/dev-integrations/github/start -> { url }
  router.get(
    '/github/start',
    requireAuth,
    requireActive,
    validate({ params: workspaceParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(res, await service.startGithubConnect({ userId: userId(req), workspaceId }));
    },
  );

  // DELETE /workspaces/:workspaceId/dev-integrations/connections/:connectionId
  router.delete(
    '/connections/:connectionId',
    requireAuth,
    requireActive,
    validate({ params: connectionParamsSchema }),
    async (req, res) => {
      const { workspaceId, connectionId } = req.validated!.params as { workspaceId: string; connectionId: string };
      sendSuccess(res, await service.disconnect({ userId: userId(req), workspaceId, connectionId }));
    },
  );

  // GET /workspaces/:workspaceId/dev-integrations/connections/:connectionId/repos (available repos)
  router.get(
    '/connections/:connectionId/repos',
    requireAuth,
    requireActive,
    validate({ params: connectionParamsSchema }),
    async (req, res) => {
      const { workspaceId, connectionId } = req.validated!.params as { workspaceId: string; connectionId: string };
      sendSuccess(res, await service.listAvailableRepositories({ userId: userId(req), workspaceId, connectionId }));
    },
  );

  return router;
}

export function createProjectRepositoryRouter({
  config,
  service = createDevIntegrationService(config),
}: DevIntegrationRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  // GET /workspaces/:workspaceId/projects/:projectId/repositories
  router.get(
    '/',
    requireAuth,
    requireActive,
    validate({ params: projectParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as { workspaceId: string; projectId: string };
      sendSuccess(res, await service.listProjectRepositories({ userId: userId(req), workspaceId, projectId }));
    },
  );

  // POST /workspaces/:workspaceId/projects/:projectId/repositories (link)
  router.post(
    '/',
    requireAuth,
    requireActive,
    validate({ params: projectParamsSchema, body: linkRepositorySchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as { workspaceId: string; projectId: string };
      const body = req.validated!.body as { connectionId: string; externalRepoId: string; fullName: string; defaultBranch?: string | null };
      sendSuccess(
        res,
        await service.linkRepository({ userId: userId(req), workspaceId, projectId, ...body }),
        201,
      );
    },
  );

  // DELETE /workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId (unlink)
  router.delete(
    '/:repositoryId',
    requireAuth,
    requireActive,
    validate({ params: projectRepoParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, repositoryId } = req.validated!.params as { workspaceId: string; projectId: string; repositoryId: string };
      sendSuccess(res, await service.unlinkRepository({ userId: userId(req), workspaceId, projectId, repositoryId }));
    },
  );

  return router;
}

function resultRedirectUrl(config: AppConfig, status: 'connected' | 'error' | 'denied', provider = 'github'): string {
  const base = config.frontendUrl || config.corsOrigins[0] || 'http://localhost:3000';
  const origin = new URL(base).origin;
  return `${origin}/app/integrations?devIntegration=${provider}&status=${status}`;
}

// Public callback router (mounted in API router; GitHub redirects browser here)
export function createDevIntegrationCallbackRouter({
  config,
  service = createDevIntegrationService(config),
}: DevIntegrationRouterOptions): Router {
  const router = Router();

  router.get('/github/callback', async (req, res) => {
    const parsed = githubCallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.redirect(302, resultRedirectUrl(config, 'error'));
    }
    const q = parsed.data;
    // GitHub may send error/error_description when user cancels
    if ((req.query as any).error) {
      return res.redirect(302, resultRedirectUrl(config, 'denied'));
    }
    if (!q.installation_id && !q.code) {
      // no installation selected
      return res.redirect(302, resultRedirectUrl(config, 'denied'));
    }
    try {
      await service.handleGithubCallback({ query: req.query as Record<string, unknown> });
      return res.redirect(302, resultRedirectUrl(config, 'connected'));
    } catch (error) {
      logger.warn('github_app_callback_failed', { error });
      return res.redirect(302, resultRedirectUrl(config, 'error'));
    }
  });

  return router;
}
