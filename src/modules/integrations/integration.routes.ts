import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  connectIntegrationSchema,
  disconnectParamsSchema,
  listIntegrationsQuerySchema,
  listSyncJobsQuerySchema,
  syncJobParamsSchema,
  updateIntegrationSchema,
  type ConnectIntegrationInput,
  type ListIntegrationsQuery,
  type ListSyncJobsQuery,
  type UpdateIntegrationInput,
} from './integration.schemas';
import { createIntegrationService } from './integration.service';
import { getPrismaClient } from '../../db/prisma';
import { logger } from '../../utils/logger';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import {
  buildSlackAuthorizeUrl,
  exchangeSlackCode,
  isSlackDefaultConnectEnabled,
  slackAuthorizeQuerySchema,
  slackCallbackQuerySchema,
  slackDefaultConnection,
  slackResultUrl,
  verifySlackState,
} from './slack.oauth';
import {
  buildDriveAuthorizeUrl,
  driveAuthorizeQuerySchema,
  driveCallbackQuerySchema,
  driveResultUrl,
  exchangeDriveCode,
  verifyDriveState,
} from './google-drive.oauth';
import {
  buildDropboxAuthorizeUrl,
  dropboxAuthorizeQuerySchema,
  dropboxCallbackQuerySchema,
  dropboxResultUrl,
  exchangeDropboxCode,
  verifyDropboxState,
} from './dropbox.oauth';
import {
  buildGmailAuthorizeUrl,
  exchangeGmailCode,
  gmailAuthorizeQuerySchema,
  gmailCallbackQuerySchema,
  gmailResultUrl,
  verifyGmailState,
} from './gmail.oauth';
import {
  buildGithubAuthorizeUrl,
  exchangeGithubCode,
  githubAuthorizeQuerySchema,
  githubCallbackQuerySchema,
  githubResultUrl,
  verifyGithubState,
} from './github.oauth';
import {
  buildCalendarAuthorizeUrl,
  calendarAuthorizeQuerySchema,
  calendarCallbackQuerySchema,
  calendarResultUrl,
  exchangeCalendarCode,
  verifyCalendarState,
} from './google-calendar.oauth';

export interface IntegrationRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createIntegrationService>;
}
function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in');
  return req.auth.userId;
}

export function createIntegrationRouter({
  config,
  service = createIntegrationService(),
}: IntegrationRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get(
    '/',
    requireAuth,
    requireActive,
    validate({ query: listIntegrationsQuerySchema }),
    async (req, res) => {
      const q = req.validated!.query as ListIntegrationsQuery;
      sendSuccess(res, await service.list({ userId: userId(req), workspaceId: q.workspaceId }));
    },
  );

  router.post(
    '/',
    requireAuth,
    requireActive,
    validate({ body: connectIntegrationSchema }),
    async (req, res) => {
      const body = req.validated!.body as ConnectIntegrationInput;
      // Slack tokens may only arrive through the OAuth callback, never from a client-supplied body.
      if (body.provider === 'SLACK') {
        throw new AppError(
          400,
          'USE_SLACK_OAUTH',
          'Connect Slack through the Slack authorization flow',
        );
      }
      // Same rule for Google Drive: tokens only come from the OAuth callback.
      if (body.provider === 'GOOGLE_DRIVE') {
        throw new AppError(
          400,
          'USE_GOOGLE_DRIVE_OAUTH',
          'Connect Google Drive through the Google authorization flow',
        );
      }

      if (body.provider === 'DROPBOX') {
        throw new AppError(
          400,
          'USE_DROPBOX_OAUTH',
          'Connect Dropbox through the Dropbox authorization flow',
        );
      }
      if (body.provider === 'GITHUB') {
        throw new AppError(
          400,
          'USE_GITHUB_OAUTH',
          'Connect GitHub through the GitHub authorization flow',
        );
      }
      if (body.provider === 'GOOGLE_CALENDAR') {
        throw new AppError(
          400,
          'USE_GOOGLE_CALENDAR_OAUTH',
          'Connect Google Calendar through the Google authorization flow',
        );
      }
      if (body.provider === 'GMAIL') {
        throw new AppError(
          400,
          'USE_GMAIL_OAUTH',
          'Connect Gmail through the Google authorization flow',
        );
      }
      sendSuccess(res, await service.connect({ userId: userId(req), ...body }), 201);
    },
  );

  router.delete(
    '/:integrationId',
    requireAuth,
    requireActive,
    validate({ params: disconnectParamsSchema }),
    async (req, res) => {
      const { integrationId } = req.validated!.params as { integrationId: string };
      sendSuccess(res, await service.disconnect({ userId: userId(req), integrationId }));
    },
  );

  router.patch(
    '/:integrationId',
    requireAuth,
    requireActive,
    validate({ params: disconnectParamsSchema, body: updateIntegrationSchema }),
    async (req, res) => {
      const { integrationId } = req.validated!.params as { integrationId: string };
      const { enabled } = req.validated!.body as UpdateIntegrationInput;
      sendSuccess(res, await service.setEnabled({ userId: userId(req), integrationId, enabled }));
    },
  );

  router.post(
    '/:integrationId/refresh',
    requireAuth,
    requireActive,
    validate({ params: disconnectParamsSchema }),
    async (req, res) => {
      const { integrationId } = req.validated!.params as { integrationId: string };
      sendSuccess(res, await service.refresh({ userId: userId(req), integrationId }));
    },
  );

  router.post(
    '/:integrationId/sync',
    requireAuth,
    requireActive,
    validate({ params: disconnectParamsSchema }),
    async (req, res) => {
      const { integrationId } = req.validated!.params as { integrationId: string };
      sendSuccess(res, await service.enqueueSync({ userId: userId(req), integrationId }), 202);
    },
  );

  router.get(
    '/:integrationId/sync-jobs',
    requireAuth,
    requireActive,
    validate({ params: disconnectParamsSchema, query: listSyncJobsQuerySchema }),
    async (req, res) => {
      const { integrationId } = req.validated!.params as { integrationId: string };
      const { limit } = req.validated!.query as ListSyncJobsQuery;
      sendSuccess(res, await service.listSyncJobs({ userId: userId(req), integrationId, limit }));
    },
  );

  router.post(
    '/:integrationId/sync-jobs/:jobId/retry',
    requireAuth,
    requireActive,
    validate({ params: syncJobParamsSchema }),
    async (req, res) => {
      const { integrationId, jobId } = req.validated!.params as {
        integrationId: string;
        jobId: string;
      };
      sendSuccess(res, await service.retrySyncJob({ userId: userId(req), integrationId, jobId }));
    },
  );

  // Slack step 1 (authenticated): the frontend asks for the Slack consent URL.
  router.get(
    '/slack/authorize',
    requireAuth,
    requireActive,
    validate({ query: slackAuthorizeQuerySchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.query as { workspaceId: string };
      await requireWorkspaceAccess(getPrismaClient(), {
        userId: userId(req),
        workspaceId,
        capability: WorkspaceCapability.UpdateWorkspace,
      });
      sendSuccess(res, { url: await buildSlackAuthorizeUrl({ userId: userId(req), workspaceId }) });
    },
  );

  // Slack step 2 (public): Slack redirects the browser here. Identity comes from the signed state.
  router.get('/slack/callback', async (req, res) => {
    const done = (status: 'connected' | 'denied' | 'error') =>
      res.redirect(302, slackResultUrl(status));
    const parsed = slackCallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) return done('error');
    const { code, state, error } = parsed.data;
    if (error) return done('denied');
    if (!code) return done('error');
    try {
      const claims = await verifySlackState(state);
      const token = await exchangeSlackCode(code);
      await service.connect({
        userId: claims.userId,
        provider: 'SLACK',
        workspaceId: claims.workspaceId,
        ...token,
      });
      return done('connected');
    } catch (err) {
      logger.warn('slack_oauth_failed', { error: err });
      return done('error');
    }
  });

  // Slack "default connect" (opt-in via SLACK_DEFAULT_CONNECT=true and SLACK_BOT_TOKEN): no Slack page.
  // The signed, single-use state proves an OWNER / PROJECT_MANAGER started it; connect() re-checks the role.
  router.get('/slack/default-callback', async (req, res) => {
    const done = (status: 'connected' | 'denied' | 'error') =>
      res.redirect(302, slackResultUrl(status));
    const parsed = slackCallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) return done('error');
    try {
      if (!isSlackDefaultConnectEnabled()) return done('error');
      const claims = await verifySlackState(parsed.data.state);
      await service.connect({
        userId: claims.userId,
        provider: 'SLACK',
        workspaceId: claims.workspaceId,
        ...slackDefaultConnection(),
      });
      return done('connected');
    } catch (err) {
      logger.warn('slack_default_connect_failed', { error: err });
      return done('error');
    }
  });

  router.get(
    '/google-drive/authorize',
    requireAuth,
    requireActive,
    validate({ query: driveAuthorizeQuerySchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.query as { workspaceId: string };
      await requireWorkspaceAccess(getPrismaClient(), {
        userId: userId(req),
        workspaceId,
        capability: WorkspaceCapability.UpdateWorkspace,
      });
      sendSuccess(res, { url: await buildDriveAuthorizeUrl({ userId: userId(req), workspaceId }) });
    },
  );

  router.get('/google-drive/callback', async (req, res) => {
    const done = (status: 'connected' | 'denied' | 'error') =>
      res.redirect(302, driveResultUrl(status));
    const parsed = driveCallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) return done('error');
    const { code, state, error } = parsed.data;
    if (error) return done('denied');
    if (!code) return done('error');
    try {
      const claims = await verifyDriveState(state);
      const token = await exchangeDriveCode(code);
      await service.connect({
        userId: claims.userId,
        provider: 'GOOGLE_DRIVE',
        workspaceId: claims.workspaceId,
        ...token,
      });
      return done('connected');
    } catch (err) {
      logger.warn('google_drive_oauth_failed', { error: err });
      return done('error');
    }
  });

  router.get(
    '/dropbox/authorize',
    requireAuth,
    requireActive,
    validate({ query: dropboxAuthorizeQuerySchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.query as { workspaceId: string };
      await requireWorkspaceAccess(getPrismaClient(), {
        userId: userId(req),
        workspaceId,
        capability: WorkspaceCapability.UpdateWorkspace,
      });
      sendSuccess(res, {
        url: await buildDropboxAuthorizeUrl({ userId: userId(req), workspaceId }),
      });
    },
  );

  router.get('/dropbox/callback', async (req, res) => {
    const done = (status: 'connected' | 'denied' | 'error') =>
      res.redirect(302, dropboxResultUrl(status));
    const parsed = dropboxCallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) return done('error');
    const { code, state, error } = parsed.data;
    if (error) return done('denied');
    if (!code) return done('error');
    try {
      const claims = await verifyDropboxState(state);
      const token = await exchangeDropboxCode(code);
      await service.connect({
        userId: claims.userId,
        provider: 'DROPBOX',
        workspaceId: claims.workspaceId,
        ...token,
      });
      return done('connected');
    } catch (err) {
      logger.warn('dropbox_oauth_failed', { error: err });
      return done('error');
    }
  });

  // Gmail is a personal connection (workspaceId null): any signed-in user can connect their own mailbox.
  router.get(
    '/gmail/authorize',
    requireAuth,
    requireActive,
    validate({ query: gmailAuthorizeQuerySchema }),
    async (req, res) => {
      sendSuccess(res, { url: await buildGmailAuthorizeUrl({ userId: userId(req) }) });
    },
  );

  router.get('/gmail/callback', async (req, res) => {
    const done = (status: 'connected' | 'denied' | 'error') =>
      res.redirect(302, gmailResultUrl(status));
    const parsed = gmailCallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) return done('error');
    const { code, state, error } = parsed.data;
    if (error) return done('denied');
    if (!code) return done('error');
    try {
      const claims = await verifyGmailState(state);
      const token = await exchangeGmailCode(code);
      await service.connect({
        userId: claims.userId,
        provider: 'GMAIL',
        workspaceId: null,
        ...token,
      });
      return done('connected');
    } catch (err) {
      logger.warn('gmail_oauth_failed', { error: err });
      return done('error');
    }
  });

  // GitHub is a personal connection (workspaceId null).
  router.get(
    '/github/authorize',
    requireAuth,
    requireActive,
    validate({ query: githubAuthorizeQuerySchema }),
    async (req, res) => {
      sendSuccess(res, { url: await buildGithubAuthorizeUrl({ userId: userId(req) }) });
    },
  );

  router.get('/github/callback', async (req, res) => {
    const done = (status: 'connected' | 'denied' | 'error') =>
      res.redirect(302, githubResultUrl(status));
    const parsed = githubCallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) return done('error');
    const { code, state, error } = parsed.data;
    if (error) return done('denied');
    if (!code) return done('error');
    try {
      const claims = await verifyGithubState(state);
      const token = await exchangeGithubCode(code);
      await service.connect({
        userId: claims.userId,
        provider: 'GITHUB',
        workspaceId: null,
        ...token,
      });
      return done('connected');
    } catch (err) {
      logger.warn('github_oauth_failed', { error: err });
      return done('error');
    }
  });

  // Google Calendar is a personal connection (workspaceId null).
  router.get(
    '/google-calendar/authorize',
    requireAuth,
    requireActive,
    validate({ query: calendarAuthorizeQuerySchema }),
    async (req, res) => {
      sendSuccess(res, { url: await buildCalendarAuthorizeUrl({ userId: userId(req) }) });
    },
  );

  router.get('/google-calendar/callback', async (req, res) => {
    const done = (status: 'connected' | 'denied' | 'error') =>
      res.redirect(302, calendarResultUrl(status));
    const parsed = calendarCallbackQuerySchema.safeParse(req.query);
    if (!parsed.success) return done('error');
    const { code, state, error } = parsed.data;
    if (error) return done('denied');
    if (!code) return done('error');
    try {
      const claims = await verifyCalendarState(state);
      const token = await exchangeCalendarCode(code);
      await service.connect({
        userId: claims.userId,
        provider: 'GOOGLE_CALENDAR',
        workspaceId: null,
        ...token,
      });
      return done('connected');
    } catch (err) {
      logger.warn('google_calendar_oauth_failed', { error: err });
      return done('error');
    }
  });

  return router;
}
