import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { workspaceIntegrationParamsSchema } from './integration.schemas';
import { createIntegrationPickerService } from './integration-picker.service';

/**
 * Workspace-scoped integration resource pickers.
 *
 * Mounted at `/workspaces/:workspaceId/integrations`:
 * - `GET /google-calendar/calendars`
 * - `GET /slack/channels`
 *
 * Both endpoints are admin-only: the service enforces
 * `WorkspaceCapability.UpdateWorkspace` (OWNER or PROJECT_MANAGER) before any
 * provider call, and the token never leaves the server. The response is
 * identical in shape to what the picker UI renders; nothing else from the
 * provider is forwarded.
 */

export interface WorkspaceIntegrationRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createIntegrationPickerService>;
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in');
  return req.auth.userId;
}

export function createWorkspaceIntegrationRouter({
  config,
  service = createIntegrationPickerService(),
}: WorkspaceIntegrationRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get(
    '/google-calendar/calendars',
    requireAuth,
    requireActive,
    validate({ params: workspaceIntegrationParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(res, {
        calendars: await service.listGoogleCalendars({ userId: userId(req), workspaceId }),
      });
    },
  );

  router.get(
    '/slack/channels',
    requireAuth,
    requireActive,
    validate({ params: workspaceIntegrationParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(res, {
        channels: await service.listSlackChannels({ userId: userId(req), workspaceId }),
      });
    },
  );

  return router;
}
