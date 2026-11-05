import type {
  OrganizationRole,
  PrismaClient,
  Project,
  ProjectMembership,
  ProjectRole,
  WorkspaceRole,
} from '@prisma/client';
import { AppError } from '../../utils/errors';
import { effectiveWorkspaceRole, isOrganizationRoleForWorkspace } from './organization-role';

/**
 * Project-level authorization policy.
 *
 * A project lives inside a workspace. Access is determined by a combination
 * of the caller's workspace role and their explicit project membership (if
 * any). The rules are:
 *
 * - The workspace OWNER and PROJECT_MANAGER can read and manage every project
 *   in the workspace regardless of whether they hold a project membership row.
 * - A project MEMBER or VIEWER must have an explicit `ProjectMembership` row
 *   or membership in the project-associated team to access the project.
 * - Private projects (`visibility = PRIVATE`) are only visible to explicitly
 *   invited project members or members of their associated team; workspace-
 *   wide roles do not grant access unless they are OWNER or PROJECT_MANAGER.
 * - Project-level management actions (update, archive, delete, manage members)
 *   require either the workspace OWNER / PROJECT_MANAGER role, or the project-
 *   level PROJECT_MANAGER role.
 *
 * Phase 6 establishes the policy table. The actual project endpoints are
 * implemented in Phase 8. The guards are available here so that the workspace
 * routes can already enforce project isolation for endpoints that return
 * project-scoped data.
 */

// ---------------------------------------------------------------------------
// Capability constants
// ---------------------------------------------------------------------------

export const ProjectCapability = {
  ViewProject: 'project:view',
  UpdateProject: 'project:update',
  ArchiveProject: 'project:archive',
  DeleteProject: 'project:delete',
  ManageMembers: 'project:manage_members',
  CreateTask: 'project:create_task',
  ManageTask: 'project:manage_task',
  ViewTasks: 'project:view_tasks',
  ViewFiles: 'project:view_files',
  ManageFiles: 'project:manage_files',
} as const;

export type ProjectCapabilityValue = (typeof ProjectCapability)[keyof typeof ProjectCapability];

// ---------------------------------------------------------------------------
// Role → capability matrices
// ---------------------------------------------------------------------------

/**
 * What a workspace-level role can do in any project it can access.
 *
 * The workspace OWNER and PROJECT_MANAGER have full control over every
 * project.  Lower workspace roles derive access only from their explicit
 * project membership row.
 */
const WORKSPACE_ROLE_PROJECT_CAPABILITIES: Record<
  WorkspaceRole,
  readonly ProjectCapabilityValue[]
> = {
  OWNER: [
    'project:view',
    'project:update',
    'project:archive',
    'project:delete',
    'project:manage_members',
    'project:create_task',
    'project:manage_task',
    'project:view_tasks',
    'project:view_files',
    'project:manage_files',
  ],
  PROJECT_MANAGER: [
    'project:view',
    'project:update',
    'project:archive',
    'project:delete',
    'project:manage_members',
    'project:create_task',
    'project:manage_task',
    'project:view_tasks',
    'project:view_files',
    'project:manage_files',
  ],
  MEMBER: [],
  COLLABORATOR: [],
  VIEWER: [],
};

/**
 * What an explicit project-level role can do.
 */
const PROJECT_ROLE_CAPABILITIES: Record<ProjectRole, readonly ProjectCapabilityValue[]> = {
  PROJECT_MANAGER: [
    'project:view',
    'project:update',
    'project:archive',
    'project:manage_members',
    'project:create_task',
    'project:manage_task',
    'project:view_tasks',
    'project:view_files',
    'project:manage_files',
  ],
  MEMBER: [
    'project:view',
    'project:create_task',
    'project:manage_task',
    'project:view_tasks',
    'project:view_files',
  ],
  VIEWER: ['project:view', 'project:view_tasks', 'project:view_files'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function workspaceRoleCanOnProject(
  workspaceRole: WorkspaceRole,
  capability: ProjectCapabilityValue,
): boolean {
  return WORKSPACE_ROLE_PROJECT_CAPABILITIES[workspaceRole].includes(capability);
}

export function projectRoleCan(
  projectRole: ProjectRole,
  capability: ProjectCapabilityValue,
): boolean {
  return PROJECT_ROLE_CAPABILITIES[projectRole].includes(capability);
}

function maximumProjectRole(role: OrganizationRole | null): ProjectRole | null {
  if (role === 'COMPANY_PROJECT_MANAGER') return 'PROJECT_MANAGER';
  if (
    role === 'COMPANY_OWNER' ||
    role === 'COMPANY_ADMIN' ||
    role === 'INSTITUTION_OWNER' ||
    role === 'INSTITUTION_ADMIN'
  )
    return 'PROJECT_MANAGER';
  if (role === 'COMPANY_VIEWER' || role === 'INSTITUTION_VIEWER') return 'VIEWER';
  if (role) return 'MEMBER';
  return null;
}

function capProjectRole(assigned: ProjectRole, maximum: ProjectRole | null): ProjectRole {
  if (!maximum || maximum === 'PROJECT_MANAGER') return assigned;
  if (maximum === 'VIEWER') return 'VIEWER';
  return assigned === 'PROJECT_MANAGER' ? 'MEMBER' : assigned;
}

// ---------------------------------------------------------------------------
// Access result
// ---------------------------------------------------------------------------

export interface ProjectAccess {
  project: Project;
  /** Explicit project membership row, if one exists. */
  projectMembership: ProjectMembership | null;
  /** Effective workspace role of the caller. */
  workspaceRole: WorkspaceRole;
}

// ---------------------------------------------------------------------------
// Access guard
// ---------------------------------------------------------------------------

/**
 * Loads the project and proves that the caller can perform the requested
 * capability.
 *
 * The function requires the caller's workspace membership to already be
 * confirmed (i.e. `requireWorkspaceAccess` was called first). Pass the
 * resolved `workspaceRole` from that call.
 *
 * Throws `AppError` with an appropriate status and code on any failure.
 */
export async function requireProjectAccess(
  client: PrismaClient,
  input: {
    userId: string;
    workspaceId: string;
    projectId: string;
    workspaceRole: WorkspaceRole;
    capability: ProjectCapabilityValue;
  },
): Promise<ProjectAccess> {
  const project = await client.project.findFirst({
    where: {
      id: input.projectId,
      workspaceId: input.workspaceId,
      deletedAt: null,
    },
  });

  if (!project) {
    throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
  }

  const workspaceMembership = await client.workspaceMembership.findUnique({
    where: {
      workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId },
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
  const effectiveRole = effectiveWorkspaceRole(
    workspaceMembership.workspace.type,
    workspaceMembership.role,
    workspaceMembership.organizationRole,
  );

  if (workspaceMembership.organizationRole === 'INSTITUTION_DEPARTMENT_HEAD') {
    if (!project.departmentId) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
    }
    const department = await client.department.findFirst({
      where: {
        id: project.departmentId,
        workspaceId: project.workspaceId,
        members: { some: { userId: input.userId, role: 'HEAD' } },
      },
    });
    if (!department) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
    }
    if (input.capability === ProjectCapability.DeleteProject) {
      throw new AppError(
        403,
        'INSUFFICIENT_PROJECT_ROLE',
        'Department heads cannot delete projects',
      );
    }
    return { project, projectMembership: null, workspaceRole: effectiveRole };
  }

  // Legacy workspace roles retain their established behavior. Organization
  // roles must have explicit project assignment, even when their mapped tier
  // would otherwise bypass project membership.
  if (
    !workspaceMembership.organizationRole &&
    workspaceRoleCanOnProject(effectiveRole, input.capability)
  ) {
    return { project, projectMembership: null, workspaceRole: effectiveRole };
  }

  // Association with a team grants that team's active members the base
  // project-member permissions. The team lookup is workspace scoped so a
  // mismatched or cross-workspace team reference cannot grant access. An
  // explicit project membership remains valid for a separately invited user.
  let teamMember = false;
  if (project.teamId) {
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
          where: { teamId_userId: { teamId: team.id, userId: input.userId } },
          select: { id: true },
        }),
      );
    }
  }

  // A department-only project inherits base access from active department
  // membership. When a project is also assigned to a team, the team is the
  // narrower scope and department membership alone does not bypass it.
  let departmentMember = false;
  if (project.departmentId && !project.teamId) {
    const department = await client.department.findFirst({
      where: { id: project.departmentId, workspaceId: project.workspaceId },
      select: { id: true },
    });
    if (department) {
      departmentMember = Boolean(
        await client.departmentMembership.findUnique({
          where: { departmentId_userId: { departmentId: department.id, userId: input.userId } },
          select: { id: true },
        }),
      );
    }
  }

  const projectMembership = await client.projectMembership.findUnique({
    where: { projectId_userId: { projectId: project.id, userId: input.userId } },
  });

  const isProjectOwner = project.ownerId === input.userId;
  if (!projectMembership && !teamMember && !departmentMember && !isProjectOwner) {
    // Private projects are hidden completely; WORKSPACE-visible projects
    // report the correct error.
    if (project.visibility === 'PRIVATE') {
      throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
    }

    throw new AppError(403, 'PROJECT_ACCESS_DENIED', 'You are not a member of this project');
  }

  const authorizedProjectRole = capProjectRole(
    projectMembership?.role ?? (isProjectOwner ? 'PROJECT_MANAGER' : 'MEMBER'),
    maximumProjectRole(workspaceMembership.organizationRole),
  );
  if (!projectRoleCan(authorizedProjectRole, input.capability)) {
    throw new AppError(
      403,
      'INSUFFICIENT_PROJECT_ROLE',
      'Your project role does not allow this action',
    );
  }

  return { project, projectMembership, workspaceRole: effectiveRole };
}
