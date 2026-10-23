import type {
  PrismaClient,
  Project,
  ProjectMembership,
  ProjectRole,
  WorkspaceRole,
} from '@prisma/client';
import { AppError } from '../../utils/errors';

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
 *   to access the project.
 * - Private projects (`visibility = PRIVATE`) are only visible to members
 *   with an explicit membership row; workspace-wide roles do not grant access
 *   to private projects unless they are OWNER or PROJECT_MANAGER.
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

  // Workspace OWNER and PROJECT_MANAGER bypass project-level membership for
  // WORKSPACE-visibility projects and always have access.
  if (workspaceRoleCanOnProject(input.workspaceRole, input.capability)) {
    return { project, projectMembership: null, workspaceRole: input.workspaceRole };
  }

  // For all other workspace roles an explicit project membership row is
  // required.
  const projectMembership = await client.projectMembership.findUnique({
    where: { projectId_userId: { projectId: project.id, userId: input.userId } },
  });

  if (!projectMembership) {
    // Private projects are hidden completely; WORKSPACE-visible projects
    // report the correct error.
    if (project.visibility === 'PRIVATE') {
      throw new AppError(404, 'PROJECT_NOT_FOUND', 'That project does not exist');
    }

    throw new AppError(403, 'PROJECT_ACCESS_DENIED', 'You are not a member of this project');
  }

  if (!projectRoleCan(projectMembership.role, input.capability)) {
    throw new AppError(
      403,
      'INSUFFICIENT_PROJECT_ROLE',
      'Your project role does not allow this action',
    );
  }

  return { project, projectMembership, workspaceRole: input.workspaceRole };
}
