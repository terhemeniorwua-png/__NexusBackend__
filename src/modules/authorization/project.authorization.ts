import type {
  OrganizationRole,
  PrismaClient,
  Project,
  ProjectMembership,
  ProjectRole,
  WorkspaceMembership,
  WorkspaceRole,
  WorkspaceType,
} from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import { effectiveWorkspaceRole, isOrganizationRoleForWorkspace } from './organization-role';
import {
  ALL_PROJECT_PERMISSIONS,
  PROJECT_ROLE_DEFINITIONS,
  PROJECT_ROLE_PERMISSIONS,
  type ProjectPermissionValue,
  assignableProjectRoles,
  assertNotSelfReview,
  capProjectRole,
  maximumProjectRoleForMember,
} from './project.permissions';
import { requireWorkspaceAccess, WorkspaceCapability } from './workspace.policy';

/**
 * Central project authorization.
 *
 * Call order (matching the documented access model):
 *   1. authentication (route middleware)
 *   2. workspace membership (requireWorkspaceAccess)
 *   3. effective project access (this module)
 *   4. permission check (this module)
 *   5. resource-specific special rules (this module)
 *
 * The resolved access contains the effective project role, the source of that
 * access and the exact permission set the caller holds in the project.
 */

export type ProjectAccessSource =
  | 'workspace_admin'
  | 'project_member'
  | 'workspace_member'
  | 'team_member'
  | 'department_member';

export interface ProjectActor {
  userId: string;
  workspaceId: string;
  workspaceRole: WorkspaceRole;
}

export interface ProjectAuthorization {
  project: Project;
  membership: ProjectMembership | null;
  workspaceMembership: WorkspaceMembership & { workspace: { type: WorkspaceType } };
  workspaceRole: WorkspaceRole;
  organizationRole: OrganizationRole | null;
  projectRole: ProjectRole | null;
  accessSource: ProjectAccessSource;
  permissions: readonly ProjectPermissionValue[];
  isWorkspaceAdmin: boolean;
  ceiling: ProjectRole;
}

export type ProjectAuthorizationResource =
  | { kind: 'task'; taskId: string }
  | { kind: 'comment'; taskId: string; commentId: string }
  | { kind: 'file'; fileId: string }
  | {
      kind: 'submission';
      submissionId: string;
      subjectUserId: string;
      action: 'submit' | 'review' | 'approve' | 'reject' | 'request_revision';
    };

export type ProjectAuthorizationClient = Pick<
  PrismaClient,
  | 'project'
  | 'workspaceMembership'
  | 'team'
  | 'teamMembership'
  | 'department'
  | 'departmentMembership'
  | 'projectMembership'
  | 'task'
  | 'taskAssignee'
  | 'comment'
  | 'fileAttachment'
>;

const BASE_READ_PERMISSIONS: readonly ProjectPermissionValue[] = [
  'project.view',
  'task.view',
];

/**
 * Resolves the caller's effective access without requiring a specific
 * permission. Projects the caller cannot see are reported as 404 so the
 * endpoint cannot be used to probe private project identifiers.
 */
export async function resolveProjectAuthorization(
  client: ProjectAuthorizationClient,
  actor: ProjectActor,
  projectId: string,
): Promise<ProjectAuthorization> {
  const project = await client.project.findFirst({
    where: { id: projectId, workspaceId: actor.workspaceId, deletedAt: null },
  });
  if (!project) {
    throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
  }

  const workspaceMembership = await client.workspaceMembership.findUnique({
    where: {
      workspaceId_userId: {
        workspaceId: actor.workspaceId,
        userId: actor.userId,
      },
    },
    include: { workspace: { select: { type: true } } },
  });
  if (!workspaceMembership || workspaceMembership.status !== 'ACTIVE') {
    throw new AppError(403, 'PROJECT_ACCESS_DENIED', 'You are not an active workspace member');
  }
  if (
    workspaceMembership.organizationRole &&
    !isOrganizationRoleForWorkspace(
      workspaceMembership.workspace.type,
      workspaceMembership.organizationRole,
    )
  ) {
    throw new AppError(
      403,
      'ORGANIZATION_ROLE_WORKSPACE_MISMATCH',
      'The organization role is invalid',
    );
  }

  const workspaceRole = effectiveWorkspaceRole(
    workspaceMembership.workspace.type,
    workspaceMembership.role,
    workspaceMembership.organizationRole,
  );
  const organizationRole = workspaceMembership.organizationRole;
  const isWorkspaceAdmin =
    !organizationRole && (workspaceRole === 'OWNER' || workspaceRole === 'PROJECT_MANAGER');
  const ceiling = maximumProjectRoleForMember({
    workspaceType: workspaceMembership.workspace.type,
    workspaceRole,
    organizationRole,
  });

  const base: Omit<
    ProjectAuthorization,
    'projectRole' | 'accessSource' | 'permissions' | 'membership'
  > = {
    project,
    workspaceMembership,
    workspaceRole,
    organizationRole,
    isWorkspaceAdmin,
    ceiling,
  };

  if (isWorkspaceAdmin) {
    return {
      ...base,
      membership: null,
      projectRole: 'PROJECT_MANAGER',
      accessSource: 'workspace_admin',
      permissions: ALL_PROJECT_PERMISSIONS,
    };
  }

  const membership = await client.projectMembership.findUnique({
    where: { projectId_userId: { projectId: project.id, userId: actor.userId } },
  });

  const isProjectOwner = project.ownerId === actor.userId;
  if (membership || isProjectOwner) {
    const rawRole: ProjectRole = isProjectOwner
      ? 'PROJECT_MANAGER'
      : (membership as ProjectMembership).role;
    const projectRole = capProjectRole(rawRole, ceiling);
    const permissions = [...PROJECT_ROLE_PERMISSIONS[projectRole]];
    // The project owner may delete the project even though the project-manager
    // role does not carry `project.delete` on its own.
    if (isProjectOwner && projectRole === 'PROJECT_MANAGER') {
      permissions.push('project.delete');
    }
    return {
      ...base,
      membership,
      projectRole,
      accessSource: 'project_member',
      permissions,
    };
  }

  // Department heads inherit project-manager-capable access to their own
  // department's non-private projects. This preserves the Phase 6 department
  // rule; it is not general workspace-role access.
  if (
    organizationRole === 'INSTITUTION_DEPARTMENT_HEAD' &&
    project.visibility !== 'PRIVATE' &&
    project.departmentId
  ) {
    const department = await client.department.findFirst({
      where: {
        id: project.departmentId,
        workspaceId: project.workspaceId,
        members: { some: { userId: actor.userId, role: 'HEAD' } },
      },
      select: { id: true },
    });
    if (department) {
      const projectRole = capProjectRole('PROJECT_MANAGER', ceiling);
      return {
        ...base,
        membership: null,
        projectRole,
        accessSource: 'department_member',
        permissions: PROJECT_ROLE_PERMISSIONS[projectRole],
      };
    }
  }

  // Team and department membership grant base read access to a
  // DEPARTMENT_TEAM project. A project assigned to a team uses the team as the
  // narrower scope; department membership alone does not bypass it.
  let teamMember = false;
  if (project.visibility === 'DEPARTMENT_TEAM' && project.teamId) {
    const team = await client.team.findFirst({
      where: {
        id: project.teamId,
        workspaceId: project.workspaceId,
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: { id: true },
    });
    if (team) {
      teamMember = Boolean(
        await client.teamMembership.findUnique({
          where: { teamId_userId: { teamId: team.id, userId: actor.userId } },
          select: { id: true },
        }),
      );
    }
  }

  let departmentMember = false;
  if (project.visibility === 'DEPARTMENT_TEAM' && project.departmentId && !project.teamId) {
    const department = await client.department.findFirst({
      where: { id: project.departmentId, workspaceId: project.workspaceId },
      select: { id: true },
    });
    if (department) {
      departmentMember = Boolean(
        await client.departmentMembership.findUnique({
          where: { departmentId_userId: { departmentId: department.id, userId: actor.userId } },
          select: { id: true },
        }),
      );
    }
  }

  if (teamMember || departmentMember) {
    return {
      ...base,
      membership: null,
      projectRole: null,
      accessSource: teamMember ? 'team_member' : 'department_member',
      permissions: BASE_READ_PERMISSIONS,
    };
  }

  // Workspace-wide projects remain readable by active workspace members, but
  // read-only until they receive an explicit project membership.
  if (project.visibility === 'WORKSPACE') {
    return {
      ...base,
      membership: null,
      projectRole: null,
      accessSource: 'workspace_member',
      permissions: BASE_READ_PERMISSIONS,
    };
  }

  throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
}

/**
 * Resolves access and enforces one project permission, plus any resource-
 * scoped special rule for the permission.
 */
export async function authorizeProject(
  client: ProjectAuthorizationClient,
  input: {
    actor: ProjectActor;
    projectId: string;
    permission: ProjectPermissionValue;
    resource?: ProjectAuthorizationResource;
  },
): Promise<ProjectAuthorization> {
  const authorization = await resolveProjectAuthorization(client, input.actor, input.projectId);

  if (!authorization.permissions.includes(input.permission)) {
    throw new AppError(
      403,
      'PERMISSION_DENIED',
      'Your project role does not allow this action',
      { requiredPermission: input.permission },
    );
  }

  if (input.resource) {
    await enforceResourceScope(client, input.actor, authorization, input.permission, input.resource);
  }

  return authorization;
}

/**
 * Resource-scoped rules that the static role matrix cannot express.
 */
async function enforceResourceScope(
  client: ProjectAuthorizationClient,
  actor: ProjectActor,
  authorization: ProjectAuthorization,
  permission: ProjectPermissionValue,
  resource: ProjectAuthorizationResource,
): Promise<void> {
  switch (resource.kind) {
    case 'task': {
      const task = await client.task.findFirst({
        where: {
          id: resource.taskId,
          projectId: authorization.project.id,
          deletedAt: null,
        },
        select: {
          id: true,
          creatorId: true,
          assignees: { where: { userId: actor.userId }, select: { userId: true } },
        },
      });
      if (!task) {
        throw new AppError(404, 'TASK_NOT_FOUND', 'That task does not exist');
      }

      const isCreator = task.creatorId === actor.userId;
      const isAssigned = task.assignees.length > 0;
      const role = authorization.projectRole;

      if (role === 'COLLABORATOR') {
        const needsAssignment =
          permission === 'task.view' ||
          permission === 'task.complete' ||
          permission === 'task.comment';
        if (needsAssignment && !isAssigned) {
          throw new AppError(
            403,
            'PERMISSION_DENIED',
            'Collaborators can only access tasks assigned to them',
            { requiredPermission: permission },
          );
        }
      }

      if (role === 'MEMBER') {
        if (permission === 'task.update' && !isCreator && !isAssigned) {
          throw new AppError(
            403,
            'PERMISSION_DENIED',
            'Members can only update tasks they created or are assigned to',
            { requiredPermission: permission },
          );
        }
        if (permission === 'task.complete' && !isAssigned) {
          throw new AppError(
            403,
            'PERMISSION_DENIED',
            'Members can only complete tasks assigned to them',
            { requiredPermission: permission },
          );
        }
      }
      return;
    }

    case 'comment': {
      // Resolve the task first so a comment id from another task cannot be
      // used to bypass the task-level scope.
      await enforceResourceScope(client, actor, authorization, permission, {
        kind: 'task',
        taskId: resource.taskId,
      });
      const comment = await client.comment.findFirst({
        where: {
          id: resource.commentId,
          taskId: resource.taskId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!comment) {
        throw new AppError(404, 'COMMENT_NOT_FOUND', 'That comment does not exist');
      }
      return;
    }

    case 'file': {
      const file = await client.fileAttachment.findFirst({
        where: {
          id: resource.fileId,
          workspaceId: authorization.project.workspaceId,
          projectId: authorization.project.id,
          deletedAt: null,
        },
        select: { id: true, uploadedById: true },
      });
      if (!file) {
        throw new AppError(404, 'FILE_NOT_FOUND', 'That file does not exist');
      }
      if (permission === 'file.delete.own' && file.uploadedById !== actor.userId) {
        throw new AppError(
          403,
          'PERMISSION_DENIED',
          'You can only delete your own files',
          { requiredPermission: permission },
        );
      }
      return;
    }

    case 'submission': {
      if (
        resource.action === 'approve' ||
        resource.action === 'review' ||
        resource.action === 'reject' ||
        resource.action === 'request_revision'
      ) {
        assertNotSelfReview({
          actorId: actor.userId,
          subjectUserId: resource.subjectUserId,
          action: resource.action,
        });
      }
      return;
    }
  }
}

/**
 * Returns the caller's effective project access for the permissions endpoint.
 * Throws 404 when the project is not visible at all.
 */
export async function getProjectAuthorization(
  client: ProjectAuthorizationClient,
  actor: ProjectActor,
  projectId: string,
): Promise<ProjectAuthorization> {
  return resolveProjectAuthorization(client, actor, projectId);
}

export function projectAssignableRoles(
  authorization: ProjectAuthorization,
): ProjectRole[] {
  return assignableProjectRoles({
    isWorkspaceAdmin: authorization.isWorkspaceAdmin,
    actorProjectRole: authorization.projectRole,
    actorCeiling: authorization.ceiling,
  });
}

/**
 * Thin Express middleware for endpoints that only need a project-scoped
 * permission (for example the permissions read endpoint).
 */
export function requireProjectPermission(permission: ProjectPermissionValue) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }
      const params = req.params as { workspaceId?: string; projectId?: string };
      if (!params.workspaceId || !params.projectId) {
        throw new AppError(400, 'INVALID_REQUEST', 'A workspace and project are required');
      }
      const client = getPrismaClient();
      const workspace = await requireWorkspaceAccess(client, {
        userId: req.auth.userId,
        workspaceId: params.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const authorization = await authorizeProject(client, {
        actor: {
          userId: req.auth.userId,
          workspaceId: params.workspaceId,
          workspaceRole: workspace.effectiveRole,
        },
        projectId: params.projectId,
        permission,
      });
      res.locals.projectAuthorization = authorization;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Exposes the role matrix in the shape returned by the project-roles endpoint.
 */
export function projectRoleDefinitions() {
  return PROJECT_ROLE_DEFINITIONS;
}
