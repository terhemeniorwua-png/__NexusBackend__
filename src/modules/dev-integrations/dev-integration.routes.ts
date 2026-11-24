import { z } from 'zod';
/* eslint-disable @typescript-eslint/no-explicit-any */ // TODO(types): replace any with real types
import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { logger } from '../../utils/logger';
import {
  connectionParamsSchema,
  devActivityCommitsQuerySchema,
  devActivityDevelopersQuerySchema,
  githubCallbackQuerySchema,
  linkRepositorySchema,
  listDevResourceQuerySchema,
  projectParamsSchema,
  projectRepoMemberParamsSchema,
  projectRepoParamsSchema,
  projectRepoResourceParamsSchema,
  setRepositoryMemberOverrideSchema,
  taskDevLinkParamsSchema,
  taskParamsSchema,
  workspaceParamsSchema,
  linkTaskDevLinkSchema,
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

  // GET /workspaces/:workspaceId/dev-integrations/gitlab/start -> { url }
  router.get(
    '/gitlab/start',
    requireAuth,
    requireActive,
    validate({ params: workspaceParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(res, await service.startGitlabConnect({ userId: userId(req), workspaceId }));
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

  // GET /workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId/members
  router.get(
    '/:repositoryId/members',
    requireAuth,
    requireActive,
    validate({ params: projectRepoParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, repositoryId } = req.validated!.params as { workspaceId: string; projectId: string; repositoryId: string };
      sendSuccess(res, await service.listRepositoryMembers({ userId: userId(req), workspaceId, projectId, repositoryId }));
    },
  );

  // PUT /workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId/members/:userId
  router.put(
    '/:repositoryId/members/:userId',
    requireAuth,
    requireActive,
    validate({ params: projectRepoMemberParamsSchema, body: setRepositoryMemberOverrideSchema }),
    async (req, res) => {
      const { workspaceId, projectId, repositoryId, userId: targetUserId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        repositoryId: string;
        userId: string;
      };
      const { level } = req.validated!.body as { level: 'NONE' | 'METADATA' | 'READ' | 'LINK' };
      sendSuccess(
        res,
        await service.setRepositoryMemberOverride({
          userId: userId(req),
          workspaceId,
          projectId,
          repositoryId,
          targetUserId,
          level,
        }),
      );
    },
  );

  // DELETE /workspaces/:workspaceId/projects/:projectId/repositories/:repositoryId/members/:userId
  router.delete(
    '/:repositoryId/members/:userId',
    requireAuth,
    requireActive,
    validate({ params: projectRepoMemberParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, repositoryId, userId: targetUserId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        repositoryId: string;
        userId: string;
      };
      sendSuccess(
        res,
        await service.removeRepositoryMemberOverride({
          userId: userId(req),
          workspaceId,
          projectId,
          repositoryId,
          targetUserId,
        }),
      );
    },
  );

  // GET /.../repositories/:repositoryId/branches
  router.get(
    '/:repositoryId/branches',
    requireAuth,
    requireActive,
    validate({ params: projectRepoResourceParamsSchema, query: listDevResourceQuerySchema }),
    async (req, res) => {
      const { workspaceId, projectId, repositoryId } = req.validated!.params as { workspaceId: string; projectId: string; repositoryId: string };
      const query = (req.validated!.query ?? {}) as { search?: string; page?: number; perPage?: number };
      const items = await service.listRepositoryBranches({ userId: userId(req), workspaceId, projectId, repositoryId, ...query });
      sendSuccess(res, { items });
    },
  );

  // GET /.../repositories/:repositoryId/pull-requests
  router.get(
    '/:repositoryId/pull-requests',
    requireAuth,
    requireActive,
    validate({ params: projectRepoResourceParamsSchema, query: listDevResourceQuerySchema }),
    async (req, res) => {
      const { workspaceId, projectId, repositoryId } = req.validated!.params as { workspaceId: string; projectId: string; repositoryId: string };
      const query = (req.validated!.query ?? {}) as { search?: string; page?: number; perPage?: number; state?: 'open' | 'closed' | 'all' };
      const items = await service.listRepositoryPullRequests({ userId: userId(req), workspaceId, projectId, repositoryId, ...query });
      sendSuccess(res, { items });
    },
  );

  const prParamsSchema = projectRepoResourceParamsSchema.extend({ number: z.coerce.number().int().min(1) });
  const commitsQuerySchema = z.object({
    branch: z.string().trim().min(1).max(250).optional(),
    page: z.coerce.number().int().min(1).max(10).optional(),
    perPage: z.coerce.number().int().min(1).max(100).optional(),
  });
  type PrParams = { workspaceId: string; projectId: string; repositoryId: string; number: number };

  router.get(
    '/:repositoryId/pull-requests/:number',
    requireAuth, requireActive,
    validate({ params: prParamsSchema }),
    async (req, res) => {
      const p = req.validated!.params as PrParams;
      sendSuccess(res, await service.getRepositoryPullRequest({ userId: userId(req), ...p }));
    },
  );

  router.get(
    '/:repositoryId/pull-requests/:number/files',
    requireAuth, requireActive,
    validate({ params: prParamsSchema, query: commitsQuerySchema }),
    async (req, res) => {
      const p = req.validated!.params as PrParams;
      const q = (req.validated!.query ?? {}) as { page?: number; perPage?: number };
      sendSuccess(res, { items: await service.listRepositoryPullRequestFiles({ userId: userId(req), ...p, ...q }) });
    },
  );

  router.get(
    '/:repositoryId/pull-requests/:number/commits',
    requireAuth, requireActive,
    validate({ params: prParamsSchema, query: commitsQuerySchema }),
    async (req, res) => {
      const p = req.validated!.params as PrParams;
      const q = (req.validated!.query ?? {}) as { page?: number; perPage?: number };
      sendSuccess(res, { items: await service.listRepositoryPullRequestCommits({ userId: userId(req), ...p, ...q }) });
    },
  );

  router.get(
    '/:repositoryId/commits',
    requireAuth, requireActive,
    validate({ params: projectRepoResourceParamsSchema, query: commitsQuerySchema }),
    async (req, res) => {
      const p = req.validated!.params as { workspaceId: string; projectId: string; repositoryId: string };
      const q = (req.validated!.query ?? {}) as { branch?: string; page?: number; perPage?: number };
      sendSuccess(res, { items: await service.listRepositoryCommits({ userId: userId(req), ...p, ...q }) });
    },
  );

  const commitParamsSchema = projectRepoResourceParamsSchema.extend({ sha: z.string().regex(/^[0-9a-fA-F]{7,40}$/) });

  router.get(
    '/:repositoryId/commits/:sha',
    requireAuth, requireActive,
    validate({ params: commitParamsSchema }),
    async (req, res) => {
      const p = req.validated!.params as { workspaceId: string; projectId: string; repositoryId: string; sha: string };
      sendSuccess(res, await service.getRepositoryCommit({ userId: userId(req), ...p }));
    },
  );

  return router;
}

export function createTaskDevLinkRouter({
  config,
  service = createDevIntegrationService(config),
}: DevIntegrationRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get(
    '/',
    requireAuth,
    requireActive,
    validate({ params: taskParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as { workspaceId: string; projectId: string; taskId: string };
      sendSuccess(res, await service.listTaskDevLinks({ userId: userId(req), workspaceId, projectId, taskId }));
    },
  );

  router.post(
    '/',
    requireAuth,
    requireActive,
    validate({ params: taskParamsSchema, body: linkTaskDevLinkSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId } = req.validated!.params as { workspaceId: string; projectId: string; taskId: string };
      const body = req.validated!.body as any;
      sendSuccess(res, await service.linkTaskDevLink({ userId: userId(req), workspaceId, projectId, taskId, ...body }), 201);
    },
  );

  router.delete(
    '/:devLinkId',
    requireAuth,
    requireActive,
    validate({ params: taskDevLinkParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, taskId, devLinkId } = req.validated!.params as { workspaceId: string; projectId: string; taskId: string; devLinkId: string };
      sendSuccess(res, await service.unlinkTaskDevLink({ userId: userId(req), workspaceId, projectId, taskId, devLinkId }));
    },
  );

  return router;
}

function resultRedirectUrl(config: AppConfig, status: 'connected' | 'error' | 'denied', provider = 'github'): string {
  const base = config.frontendUrl || config.corsOrigins[0] || 'http://localhost:3000';
  const origin = new URL(base).origin;
  return `${origin}/app/integrations?devIntegration=${provider}&status=${status}`;
}

// Public callback router (mounted in API router; provider redirects browser here)
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
      return res.redirect(302, resultRedirectUrl(config, 'connected', 'github'));
    } catch (error) {
      logger.warn('github_app_callback_failed', { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined });
      return res.redirect(302, resultRedirectUrl(config, 'error', 'github'));
    }
  });

  router.get('/gitlab/callback', async (req, res) => {
    if ((req.query as any).error) {
      return res.redirect(302, resultRedirectUrl(config, 'denied', 'gitlab'));
    }
    const state = typeof (req.query as any).state === 'string' ? (req.query as any).state : '';
    const code = typeof (req.query as any).code === 'string' ? (req.query as any).code : '';
    if (!state || !code) {
      return res.redirect(302, resultRedirectUrl(config, 'error', 'gitlab'));
    }
    try {
      await service.handleGitlabCallback({ query: req.query as Record<string, unknown> });
      return res.redirect(302, resultRedirectUrl(config, 'connected', 'gitlab'));
    } catch (error) {
      logger.warn('gitlab_callback_failed', { error });
      return res.redirect(302, resultRedirectUrl(config, 'error', 'gitlab'));
    }
  });

  return router;
}
export function createDevActivityRouter({
  config,
  service = createDevIntegrationService(config),
}: DevIntegrationRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  // GET /workspaces/:workspaceId/projects/:projectId/dev-activity/commits
  router.get(
    '/commits',
    requireAuth,
    requireActive,
    validate({ params: projectParamsSchema, query: devActivityCommitsQuerySchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as { workspaceId: string; projectId: string };
      const query = (req.validated!.query ?? {}) as {
        cursor?: string;
        limit?: number;
        repositoryId?: string;
        authorLogin?: string;
        from?: string;
        to?: string;
      };
      sendSuccess(
        res,
        await service.listDevActivityCommits({
          userId: userId(req),
          workspaceId,
          projectId,
          ...query,
        }),
      );
    },
  );

  // GET /workspaces/:workspaceId/projects/:projectId/dev-activity/developers
  router.get(
    '/developers',
    requireAuth,
    requireActive,
    validate({ params: projectParamsSchema, query: devActivityDevelopersQuerySchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as { workspaceId: string; projectId: string };
      const query = req.validated!.query as { from: string; to: string; repositoryId?: string };
      sendSuccess(
        res,
        await service.listDevActivityDevelopers({
          userId: userId(req),
          workspaceId,
          projectId,
          ...query,
        }),
      );
    },
  );

  return router;
}
