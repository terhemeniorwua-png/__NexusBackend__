import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { getPrismaClient } from '../../db/prisma';
import { sendSuccess } from '../../utils/http';
import { AppError } from '../../utils/errors';
import { projectRoleDefinitions, requireWorkspaceAccess, WorkspaceCapability } from '../authorization';
import type { WorkspaceAccessContext } from '../authorization/workspace.policy';

export interface ProjectRolesRouterOptions {
  config: AppConfig;
}

/**
 * Workspace-level project role catalog.
 *
 *   GET /workspaces/:workspaceId/project-roles
 *
 * Returns the project roles that may be assigned inside the workspace together
 * with the permissions each role carries. Membership of the workspace is
 * required; the catalog itself is not project-specific.
 */
export function createProjectRolesRouter({ config }: ProjectRolesRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();

  router.get(
    '/',
    requireAuth,
    requireActiveAccount,
    async (req: Request, res) => {
      const userId = req.auth?.userId;
      if (!userId) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }
      const { workspaceId } = req.params as { workspaceId: string };
      const client = getPrismaClient();
      await requireWorkspaceAccess(client, {
        userId,
        workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
             context: (input as { context: WorkspaceAccessContext }).context,
      });

      sendSuccess(res, { items: projectRoleDefinitions() });
    },
  );

  return router;
}
