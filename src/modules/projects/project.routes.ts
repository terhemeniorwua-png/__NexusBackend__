import { Router, type Request } from 'express';
import type { ProjectRole } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  addProjectTeamSchema,
  assignProjectManagersSchema,
  bulkAddProjectMembersByTeamSchema,
  completeProjectSchema,
  createProjectMilestoneSchema,
  createProjectSchema,
  listProjectsQuerySchema,
  projectActivityQuerySchema,
  projectMemberParamsSchema,
  projectMemberSchema,
  projectMilestoneParamsSchema,
  projectParamsSchema,
  projectTeamParamsSchema,
  projectWorkspaceParamsSchema,
  transferProjectOwnershipSchema,
  updateProjectMemberSchema,
  updateProjectMilestoneSchema,
  updateProjectSchema,
  type AddProjectTeamInput,
  type AssignProjectManagersInput,
  type BulkAddProjectMembersByTeamInput,
  type CompleteProjectInput,
  type CreateProjectInput,
  type ListProjectsQuery,
  type TransferProjectOwnershipInput,
  type UpdateProjectInput,
} from './project.schemas';
import { createProjectService } from './project.service';
import { getProjectAuthorization, projectAssignableRoles } from '../authorization';
import { getPrismaClient } from '../../db/prisma';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';

export interface ProjectRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createProjectService>;
}

function context(req: Request) {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}

function userId(req: Request): string {
  if (!req.auth)
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  return req.auth.userId;
}

export function createProjectRouter({
  config,
  service = createProjectService(),
}: ProjectRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();

  router.get(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectWorkspaceParamsSchema, query: listProjectsQuerySchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      const query = req.validated!.query as ListProjectsQuery;
      sendSuccess(res, await service.list({ userId: userId(req), workspaceId, ...query }));
    },
  );

  router.post(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectWorkspaceParamsSchema, body: createProjectSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      const body = req.validated!.body as CreateProjectInput;
      sendSuccess(
        res,
        await service.create({ userId: userId(req), workspaceId, ...body }, context(req)),
        201,
      );
    },
  );

  router.get(
    '/:projectId/permissions',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as { workspaceId: string; projectId: string };
      const currentUserId = userId(req);
      const client = getPrismaClient();
      const workspace = await requireWorkspaceAccess(client, {
        userId: currentUserId,
        workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const authorization = await getProjectAuthorization(
        client,
        {
          userId: currentUserId,
          workspaceId,
          workspaceRole: workspace.effectiveRole,
        },
        projectId,
      );
      const assignable = projectAssignableRoles(authorization);
      sendSuccess(res, {
        projectId: authorization.project.id,
        workspaceRole: authorization.workspaceRole,
        projectRole: authorization.projectRole,
        accessSource: authorization.accessSource,
        permissions: authorization.permissions,
        assignableRoles: assignable,
      });
    },
  );

  router.get(
    '/:projectId/activity',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema, query: projectActivityQuerySchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const query = req.validated!.query as { cursor?: string; limit: number };
      sendSuccess(
        res,
        await service.activity({
          userId: userId(req),
          workspaceId,
          projectId,
          cursor: query.cursor ? new Date(query.cursor) : undefined,
          limit: query.limit,
        }),
      );
    },
  );

  router.get(
    '/:projectId/progress',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      sendSuccess(res, await service.progress({ userId: userId(req), workspaceId, projectId }));
    },
  );

  router.post(
    '/:projectId/complete',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema, body: completeProjectSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const body = req.validated!.body as CompleteProjectInput;
      sendSuccess(
        res,
        await service.complete(
          { userId: userId(req), workspaceId, projectId, ...body },
          context(req),
        ),
      );
    },
  );

  router.post(
    '/:projectId/members/bulk-by-team',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema, body: bulkAddProjectMembersByTeamSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const body = req.validated!.body as BulkAddProjectMembersByTeamInput;
      sendSuccess(
        res,
        await service.bulkAddMembersByTeam(
          { userId: userId(req), workspaceId, projectId, ...body },
          context(req),
        ),
        201,
      );
    },
  );

  router.post(
    '/:projectId/managers',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema, body: assignProjectManagersSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const body = req.validated!.body as AssignProjectManagersInput;
      sendSuccess(
        res,
        await service.assignManagers(
          { userId: userId(req), workspaceId, projectId, ...body },
          context(req),
        ),
      );
    },
  );

  router.post(
    '/:projectId/teams',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema, body: addProjectTeamSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const body = req.validated!.body as AddProjectTeamInput;
      sendSuccess(
        res,
        await service.addTeam(
          { userId: userId(req), workspaceId, projectId, ...body },
          context(req),
        ),
        201,
      );
    },
  );

  router.delete(
    '/:projectId/teams/:teamId',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectTeamParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, teamId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        teamId: string;
      };
      sendSuccess(
        res,
        await service.removeTeam(
          { userId: userId(req), workspaceId, projectId, teamId },
          context(req),
        ),
      );
    },
  );

  router.post(
    '/:projectId/transfer-ownership',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema, body: transferProjectOwnershipSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const body = req.validated!.body as TransferProjectOwnershipInput;
      sendSuccess(
        res,
        await service.transferOwnership(
          { userId: userId(req), workspaceId, projectId, ...body },
          context(req),
        ),
      );
    },
  );

  router.get(
    '/:projectId/milestones',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      sendSuccess(
        res,
        await service.listMilestones({ userId: userId(req), workspaceId, projectId }),
      );
    },
  );

  router.post(
    '/:projectId/milestones',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema, body: createProjectMilestoneSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      sendSuccess(
        res,
        await service.createMilestone(
          {
            userId: userId(req),
            workspaceId,
            projectId,
            ...(req.validated!.body as {
              name: string;
              description?: string | null;
              dueDate?: string | null;
              position?: number;
            }),
          },
          context(req),
        ),
        201,
      );
    },
  );

  router.patch(
    '/:projectId/milestones/:milestoneId',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectMilestoneParamsSchema, body: updateProjectMilestoneSchema }),
    async (req, res) => {
      const { workspaceId, projectId, milestoneId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        milestoneId: string;
      };
      sendSuccess(
        res,
        await service.updateMilestone(
          {
            userId: userId(req),
            workspaceId,
            projectId,
            milestoneId,
            ...(req.validated!.body as {
              name?: string;
              description?: string | null;
              dueDate?: string | null;
              completed?: boolean;
              position?: number;
            }),
          },
          context(req),
        ),
      );
    },
  );

  router.delete(
    '/:projectId/milestones/:milestoneId',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectMilestoneParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId, milestoneId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
        milestoneId: string;
      };
      sendSuccess(
        res,
        await service.deleteMilestone(
          { userId: userId(req), workspaceId, projectId, milestoneId },
          context(req),
        ),
      );
    },
  );

  router.get(
    '/:projectId/members',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      sendSuccess(res, await service.listMembers({ userId: userId(req), workspaceId, projectId }));
    },
  );

  router.post(
    '/:projectId/members',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema, body: projectMemberSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const body = req.validated!.body as { userId: string; role: ProjectRole };
      sendSuccess(
        res,
        await service.addMember(
          {
            userId: userId(req),
            workspaceId,
            projectId,
            targetUserId: body.userId,
            role: body.role,
          },
          context(req),
        ),
        201,
      );
    },
  );

  router.patch(
    '/:projectId/members/:userId',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectMemberParamsSchema, body: updateProjectMemberSchema }),
    async (req, res) => {
      const {
        workspaceId,
        projectId,
        userId: targetUserId,
      } = req.validated!.params as { workspaceId: string; projectId: string; userId: string };
      const body = req.validated!.body as { role: ProjectRole };
      sendSuccess(
        res,
        await service.updateMember(
          { userId: userId(req), workspaceId, projectId, targetUserId, role: body.role },
          context(req),
        ),
      );
    },
  );

  router.delete(
    '/:projectId/members/:userId',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectMemberParamsSchema }),
    async (req, res) => {
      const {
        workspaceId,
        projectId,
        userId: targetUserId,
      } = req.validated!.params as { workspaceId: string; projectId: string; userId: string };
      sendSuccess(
        res,
        await service.removeMember(
          { userId: userId(req), workspaceId, projectId, targetUserId },
          context(req),
        ),
      );
    },
  );

  router.post(
    '/:projectId/archive',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      sendSuccess(
        res,
        await service.archive({ userId: userId(req), workspaceId, projectId }, context(req)),
      );
    },
  );

  router.post(
    '/:projectId/restore',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      sendSuccess(
        res,
        await service.restore({ userId: userId(req), workspaceId, projectId }, context(req)),
      );
    },
  );

  router.get(
    '/:projectId',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      sendSuccess(res, await service.get({ userId: userId(req), workspaceId, projectId }));
    },
  );

  router.patch(
    '/:projectId',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema, body: updateProjectSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      const body = req.validated!.body as UpdateProjectInput;
      sendSuccess(
        res,
        await service.update(
          { userId: userId(req), workspaceId, projectId, ...body },
          context(req),
        ),
      );
    },
  );

  router.delete(
    '/:projectId',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated!.params as {
        workspaceId: string;
        projectId: string;
      };
      sendSuccess(
        res,
        await service.remove({ userId: userId(req), workspaceId, projectId }, context(req)),
      );
    },
  );

  return router;
}