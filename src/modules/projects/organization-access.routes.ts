import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  DepartmentCapability,
  ProjectPermission,
  authorizeProject,
  requireDepartmentAccess,
  requireTeamAccess,
  requireWorkspaceAccess,
  TeamCapability,
  WorkspaceCapability,
} from '../authorization';
import type { WorkspaceAccessContext } from '../authorization/workspace.policy';
import { getPrismaClient } from '../../db/prisma';
import {
  projectOrganizationParamsSchema,
  updateProjectOrganizationAccessSchema,
  type UpdateProjectOrganizationAccessInput,
} from './organization-access.schemas';

function requestUserId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue');
  return req.auth.userId;
}

export interface ProjectOrganizationRouterOptions {
  config: AppConfig;
}

export function createProjectOrganizationRouter({
  config,
}: ProjectOrganizationRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const prisma = getPrismaClient();
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.patch(
    '/:projectId/organizational-access',
    requireAuth,
    requireActive,
    validate({
      params: projectOrganizationParamsSchema,
      body: updateProjectOrganizationAccessSchema,
    }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const input = req.validated!.body as UpdateProjectOrganizationAccessInput;
      const userId = requestUserId(req);
      const workspace = await requireWorkspaceAccess(prisma, {
        userId,
        workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
             context: (input as { context: WorkspaceAccessContext }).context,
      });
      const { project } = await authorizeProject(prisma, {
        actor: { userId, workspaceId, workspaceRole: workspace.effectiveRole },
        projectId,
        permission: ProjectPermission.Update,
      });

      const teamId = input.teamId !== undefined ? input.teamId : project.teamId;
      let departmentId =
        input.departmentId !== undefined ? input.departmentId : project.departmentId;
      let teamDepartmentId: string | null = null;

      if (teamId) {
        const team = await requireTeamAccess(prisma, {
          userId,
          workspaceId,
          teamId,
          workspaceRole: workspace.effectiveRole,
          capability: TeamCapability.UpdateTeam,
               context: (input as { context: WorkspaceAccessContext }).context,
      });
        teamDepartmentId = team.team.departmentId;
        if (input.teamId !== undefined && input.teamId !== project.teamId && teamDepartmentId) {
          departmentId = input.departmentId === undefined ? teamDepartmentId : departmentId;
        }
      }

      if (teamDepartmentId && departmentId !== teamDepartmentId) {
        throw new AppError(
          409,
          'PROJECT_ORGANIZATION_MISMATCH',
          'A project assigned to a department team must use the same department',
        );
      }

      if (departmentId) {
        await requireDepartmentAccess(prisma, {
          userId,
          workspaceId,
          departmentId,
          capability: DepartmentCapability.ManageProjects,
               context: (input as { context: WorkspaceAccessContext }).context,
      });
      }

      const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.project.update({
          where: { id: project.id },
          data: { teamId, departmentId },
          select: { id: true, workspaceId: true, teamId: true, departmentId: true },
        });
        await recordAuditEvent(tx, {
          workspaceId,
          actorId: userId,
          action: 'project.organization_access_updated',
          targetType: 'Project',
          targetId: project.id,
          metadata: {
            previousTeamId: project.teamId,
            previousDepartmentId: project.departmentId,
            teamId: result.teamId,
            departmentId: result.departmentId,
          },
          ip: req.ip,
          userAgent: req.header('user-agent'),
        });
        return result;
      });
      sendSuccess(res, updated);
    },
  );

  return router;
}
