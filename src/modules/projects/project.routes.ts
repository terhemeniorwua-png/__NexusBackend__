import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  addProjectMemberSchema,
  changeProjectOwnerSchema,
  createProjectSchema,
  listProjectsQuerySchema,
  projectActivityQuerySchema,
  projectMemberParamsSchema,
  projectParamsSchema,
  updateProjectMemberRoleSchema,
  updateProjectSchema,
  workspaceIdParamsSchema,
  type AddProjectMemberInput,
  type ChangeProjectOwnerInput,
  type CreateProjectInput,
  type ListProjectsQuery,
  type ProjectActivityQuery,
  type UpdateProjectInput,
  type UpdateProjectMemberRoleInput,
} from './project.schemas';
import { createProjectService, type ProjectService } from './project.service';

export interface ProjectRouterOptions {
  config: AppConfig;
  service?: ProjectService;
}

function context(req: Request) {
  return {
    ip: req.ip,
    userAgent: req.header('user-agent'),
  };
}

function requireUser(req: Request): string {
  const auth = req.auth;
  if (!auth) {
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  }
  return auth.userId;
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
    validate({ params: workspaceIdParamsSchema, query: listProjectsQuerySchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const query = req.validated?.query as ListProjectsQuery;
      const result = await service.list({ userId: requireUser(req), workspaceId, ...query });
      sendSuccess(res, result);
    },
  );

  router.get(
    '/overview',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const overview = await service.overview({ userId: requireUser(req), workspaceId });
      sendSuccess(res, overview);
    },
  );

  router.post(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: workspaceIdParamsSchema, body: createProjectSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated?.params as { workspaceId: string };
      const input = req.validated?.body as CreateProjectInput;
      const project = await service.create(
        { userId: requireUser(req), workspaceId, ...input },
        context(req),
      );
      sendSuccess(res, project, 201);
    },
  );

  router.get(
    '/:projectId',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated?.params as {
        workspaceId: string;
        projectId: string;
      };
      const project = await service.get({ userId: requireUser(req), workspaceId, projectId });
      sendSuccess(res, project);
    },
  );

  router.get(
    '/:projectId/detail',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated?.params as {
        workspaceId: string;
        projectId: string;
      };
      const detail = await service.getDetail({ userId: requireUser(req), workspaceId, projectId });
      sendSuccess(res, detail);
    },
  );

  router.patch(
    '/:projectId',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema, body: updateProjectSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated?.params as {
        workspaceId: string;
        projectId: string;
      };
      const input = req.validated?.body as UpdateProjectInput;
      const project = await service.update(
        { userId: requireUser(req), workspaceId, projectId, ...input },
        context(req),
      );
      sendSuccess(res, project);
    },
  );

  router.post(
    '/:projectId/archive',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated?.params as {
        workspaceId: string;
        projectId: string;
      };
      const project = await service.archive(
        { userId: requireUser(req), workspaceId, projectId },
        context(req),
      );
      sendSuccess(res, project);
    },
  );

  router.delete(
    '/:projectId',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated?.params as {
        workspaceId: string;
        projectId: string;
      };
      await service.remove({ userId: requireUser(req), workspaceId, projectId }, context(req));
      sendSuccess(res, { id: projectId, deleted: true });
    },
  );

  router.get(
    '/:projectId/members',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated?.params as {
        workspaceId: string;
        projectId: string;
      };
      const members = await service.listMembers({
        userId: requireUser(req),
        workspaceId,
        projectId,
      });
      sendSuccess(res, members);
    },
  );

  router.post(
    '/:projectId/members',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema, body: addProjectMemberSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated?.params as {
        workspaceId: string;
        projectId: string;
      };
      const input = req.validated?.body as AddProjectMemberInput;
      const member = await service.addMember(
        {
          userId: requireUser(req),
          workspaceId,
          projectId,
          targetUserId: (input as AddProjectMemberInput).userId,
          role: (input as AddProjectMemberInput).role,
        },
        context(req),
      );
      sendSuccess(res, member, 201);
    },
  );

  router.patch(
    '/:projectId/members/:userId',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectMemberParamsSchema, body: updateProjectMemberRoleSchema }),
    async (req, res) => {
      const {
        workspaceId,
        projectId,
        userId: targetUserId,
      } = req.validated?.params as { workspaceId: string; projectId: string; userId: string };
      const input = req.validated?.body as UpdateProjectMemberRoleInput;
      const member = await service.updateMemberRole(
        { userId: requireUser(req), workspaceId, projectId, targetUserId, ...input },
        context(req),
      );
      sendSuccess(res, member);
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
      } = req.validated?.params as { workspaceId: string; projectId: string; userId: string };
      await service.removeMember(
        { userId: requireUser(req), workspaceId, projectId, targetUserId },
        context(req),
      );
      sendSuccess(res, { userId: targetUserId, removed: true });
    },
  );

  router.patch(
    '/:projectId/owner',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema, body: changeProjectOwnerSchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated?.params as {
        workspaceId: string;
        projectId: string;
      };
      const input = req.validated?.body as ChangeProjectOwnerInput;
      const callerId = requireUser(req);
      const project = await service.changeOwner(
        { userId: callerId, workspaceId, projectId } as any,
        { ...context(req), userId: input.userId } as any,
      );
      sendSuccess(res, project);
    },
  );

  router.get(
    '/:projectId/activity',
    requireAuth,
    requireActiveAccount,
    validate({ params: projectParamsSchema, query: projectActivityQuerySchema }),
    async (req, res) => {
      const { workspaceId, projectId } = req.validated?.params as {
        workspaceId: string;
        projectId: string;
      };
      const query = req.validated?.query as ProjectActivityQuery;
      const activity = await service.activity({
        userId: requireUser(req),
        workspaceId,
        projectId,
        ...query,
      });
      sendSuccess(res, activity);
    },
  );

  return router;
}
