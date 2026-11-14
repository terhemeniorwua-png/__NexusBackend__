import type { OrganizationRole, ProjectRole, WorkspaceRole, WorkspaceType } from '@prisma/client';
import { AppError } from '../../utils/errors';

/**
 * Project-level permission catalog.
 *
 * This file is the single source of truth for the project permission names,
 * the project-role → permission matrix, the project-role ceiling imposed by the
 * caller's workspace role (or institution role), and the project-specific
 * special rules (self-approval and member-management escalation).
 *
 * The catalog is intentionally separate from `project.policy.ts`, which still
 * contains the older visibility/capability guards used by documents, meetings
 * and other modules. New project, task, comment, file and member checks should
 * use `authorizeProject` from `project.authorization.ts` instead.
 */

// ---------------------------------------------------------------------------
// Permission catalog
// ---------------------------------------------------------------------------

export const ProjectPermission = {
  // Project
  View: 'project.view',
  Update: 'project.update',
  Archive: 'project.archive',
  Delete: 'project.delete',
  ManageSettings: 'project.settings.manage',
  ManageMembers: 'project.member.manage',
  ViewReport: 'project.report.view',

  // Tasks
  TaskView: 'task.view',
  TaskCreate: 'task.create',
  TaskUpdate: 'task.update',
  TaskDelete: 'task.delete',
  TaskAssign: 'task.assign',
  TaskReassign: 'task.reassign',
  TaskComplete: 'task.complete',
  TaskComment: 'task.comment',

  // Files
  FileUpload: 'file.upload',
  FileDeleteOwn: 'file.delete.own',
  FileDeleteAny: 'file.delete.any',

  // Submissions
  SubmissionSubmit: 'submission.submit',
  SubmissionReview: 'submission.review',
  SubmissionApprove: 'submission.approve',
  SubmissionReject: 'submission.reject',
  SubmissionRequestRevision: 'submission.request_revision',
} as const;

export type ProjectPermissionValue =
  (typeof ProjectPermission)[keyof typeof ProjectPermission];

export const ALL_PROJECT_PERMISSIONS: readonly ProjectPermissionValue[] = Object.freeze(
  Object.values(ProjectPermission),
);

// ---------------------------------------------------------------------------
// Project roles
// ---------------------------------------------------------------------------

/**
 * Numeric rank used for ceiling checks. Higher means more privileged.
 */
export const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  VIEWER: 0,
  COLLABORATOR: 1,
  MEMBER: 2,
  PROJECT_MANAGER: 3,
};

export interface ProjectRoleDefinition {
  role: ProjectRole;
  label: string;
  description: string;
  permissions: readonly ProjectPermissionValue[];
}

const PROJECT_MANAGER_PERMISSIONS: readonly ProjectPermissionValue[] = [
  ProjectPermission.View,
  ProjectPermission.Update,
  ProjectPermission.Archive,
  ProjectPermission.ManageSettings,
  ProjectPermission.ManageMembers,
  ProjectPermission.ViewReport,
  ProjectPermission.TaskView,
  ProjectPermission.TaskCreate,
  ProjectPermission.TaskUpdate,
  ProjectPermission.TaskDelete,
  ProjectPermission.TaskAssign,
  ProjectPermission.TaskReassign,
  ProjectPermission.TaskComplete,
  ProjectPermission.TaskComment,
  ProjectPermission.FileUpload,
  ProjectPermission.FileDeleteOwn,
  ProjectPermission.FileDeleteAny,
  ProjectPermission.SubmissionSubmit,
  ProjectPermission.SubmissionReview,
  ProjectPermission.SubmissionApprove,
  ProjectPermission.SubmissionReject,
  ProjectPermission.SubmissionRequestRevision,
];

/**
 * The project-role → permission matrix.
 *
 * `project.delete` is deliberately absent from every project role: only a
 * workspace administrator or the project owner may delete a project.
 */
export const PROJECT_ROLE_PERMISSIONS: Record<
  ProjectRole,
  readonly ProjectPermissionValue[]
> = {
  PROJECT_MANAGER: PROJECT_MANAGER_PERMISSIONS,
  MEMBER: [
    ProjectPermission.View,
    ProjectPermission.TaskView,
    ProjectPermission.TaskCreate,
    ProjectPermission.TaskUpdate,
    ProjectPermission.TaskComplete,
    ProjectPermission.TaskComment,
    ProjectPermission.FileUpload,
    ProjectPermission.FileDeleteOwn,
    ProjectPermission.SubmissionSubmit,
  ],
  COLLABORATOR: [
    ProjectPermission.View,
    ProjectPermission.TaskView,
    ProjectPermission.TaskComplete,
    ProjectPermission.TaskComment,
    ProjectPermission.FileUpload,
    ProjectPermission.FileDeleteOwn,
    ProjectPermission.SubmissionSubmit,
  ],
  VIEWER: [
    ProjectPermission.View,
    ProjectPermission.TaskView,
    ProjectPermission.ViewReport,
  ],
};

export const PROJECT_ROLE_DEFINITIONS: readonly ProjectRoleDefinition[] = [
  {
    role: 'PROJECT_MANAGER',
    label: 'Project manager',
    description:
      'Manages the project, its members, tasks, files and submissions. Cannot delete the project.',
    permissions: PROJECT_ROLE_PERMISSIONS.PROJECT_MANAGER,
  },
  {
    role: 'MEMBER',
    label: 'Member',
    description:
      'Full project participant. Creates tasks, updates their own or assigned tasks, comments, uploads files and submits work.',
    permissions: PROJECT_ROLE_PERMISSIONS.MEMBER,
  },
  {
    role: 'COLLABORATOR',
    label: 'Collaborator',
    description:
      'Contributes to assigned tasks and submissions. Cannot create or edit tasks.',
    permissions: PROJECT_ROLE_PERMISSIONS.COLLABORATOR,
  },
  {
    role: 'VIEWER',
    label: 'Viewer',
    description: 'Read-only access to the project, its tasks and reports.',
    permissions: PROJECT_ROLE_PERMISSIONS.VIEWER,
  },
];

export function projectPermissionsForRole(
  role: ProjectRole,
): readonly ProjectPermissionValue[] {
  return PROJECT_ROLE_PERMISSIONS[role];
}

export function projectRoleHasPermission(
  role: ProjectRole,
  permission: ProjectPermissionValue,
): boolean {
  return PROJECT_ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Permissions held by a legacy workspace administrator (workspace OWNER or
 * PROJECT_MANAGER without an organization role). They include `project.delete`.
 */
export const WORKSPACE_ADMIN_PROJECT_PERMISSIONS: readonly ProjectPermissionValue[] =
  ALL_PROJECT_PERMISSIONS;

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

/**
 * The highest project role a workspace role may hold or assign, when the
 * member does not have an organization role.
 */
export function maximumProjectRoleForWorkspaceRole(role: WorkspaceRole): ProjectRole {
  switch (role) {
    case 'VIEWER':
      return 'VIEWER';
    case 'COLLABORATOR':
      return 'COLLABORATOR';
    case 'OWNER':
    case 'PROJECT_MANAGER':
    case 'MEMBER':
    default:
      return 'PROJECT_MANAGER';
  }
}

/**
 * The highest project role an organization role may hold or assign.
 *
 * This is the single place where institution roles are translated into project
 * roles:
 * - Department Head and Lecturer/Staff are project-manager capable.
 * - Students are members.
 * - Collaborators and viewers keep their matching project role.
 * - Organization owners and administrators are project-manager capable.
 */
export function maximumProjectRoleForOrganizationRole(
  role: OrganizationRole | null,
): ProjectRole | null {
  if (!role) return null;

  switch (role) {
    case 'COMPANY_OWNER':
    case 'COMPANY_ADMIN':
    case 'COMPANY_PROJECT_MANAGER':
    case 'INSTITUTION_OWNER':
    case 'INSTITUTION_ADMIN':
    case 'INSTITUTION_DEPARTMENT_HEAD':
    case 'INSTITUTION_LECTURER_STAFF':
      return 'PROJECT_MANAGER';

    case 'COMPANY_MEMBER':
    case 'COMPANY_COLLABORATOR':
    case 'INSTITUTION_STUDENT':
      return 'MEMBER';

    case 'INSTITUTION_COLLABORATOR':
      return 'COLLABORATOR';

    case 'COMPANY_VIEWER':
    case 'INSTITUTION_VIEWER':
      return 'VIEWER';
  }
}

/**
 * The effective ceiling for a member: organization role takes precedence over
 * the legacy workspace role because institution roles are more specific.
 */
export function maximumProjectRoleForMember(input: {
  workspaceType?: WorkspaceType;
  workspaceRole: WorkspaceRole;
  organizationRole: OrganizationRole | null;
}): ProjectRole {
  if (input.organizationRole) {
    return (
      maximumProjectRoleForOrganizationRole(input.organizationRole) ??
      maximumProjectRoleForWorkspaceRole(input.workspaceRole)
    );
  }
  return maximumProjectRoleForWorkspaceRole(input.workspaceRole);
}

/**
 * Caps a requested project role at the member's ceiling.
 */
export function capProjectRole(role: ProjectRole, ceiling: ProjectRole | null): ProjectRole {
  if (!ceiling) return role;
  return PROJECT_ROLE_RANK[role] > PROJECT_ROLE_RANK[ceiling] ? ceiling : role;
}

export function projectRoleExceedsCeiling(
  role: ProjectRole,
  ceiling: ProjectRole | null,
): boolean {
  return ceiling !== null && PROJECT_ROLE_RANK[role] > PROJECT_ROLE_RANK[ceiling];
}

/**
 * Roles an actor with the given effective project role may assign. A workspace
 * administrator may assign every role; a project manager may assign up to and
 * including the project-manager role (target ceilings are applied separately).
 */
export function assignableProjectRoles(input: {
  isWorkspaceAdmin: boolean;
  actorProjectRole: ProjectRole | null;
  actorCeiling: ProjectRole | null;
}): ProjectRole[] {
  const roles: ProjectRole[] = ['PROJECT_MANAGER', 'MEMBER', 'COLLABORATOR', 'VIEWER'];
  if (input.isWorkspaceAdmin) return roles;

  if (!input.actorProjectRole) return [];
  if (!projectRoleHasPermission(input.actorProjectRole, ProjectPermission.ManageMembers)) {
    return [];
  }

  const maxRank = Math.min(
    PROJECT_ROLE_RANK[input.actorProjectRole],
    input.actorCeiling ? PROJECT_ROLE_RANK[input.actorCeiling] : PROJECT_ROLE_RANK.PROJECT_MANAGER,
  );

  return roles.filter((role) => PROJECT_ROLE_RANK[role] <= maxRank);
}

// ---------------------------------------------------------------------------
// Special rules
// ---------------------------------------------------------------------------

/**
 * Prevents a user approving, reviewing, rejecting or requesting changes on
 * their own submission/task.
 */
export function assertNotSelfReview(input: {
  actorId: string;
  subjectUserId: string;
  action: 'review' | 'approve' | 'reject' | 'request_revision';
}): void {
  if (input.actorId !== input.subjectUserId) return;
  throw new AppError(
    403,
    'SELF_REVIEW_FORBIDDEN',
    `You cannot ${input.action.replace('_', ' ')} your own submission`,
    { details: { action: input.action } },
  );
}

/**
 * Validates a project-member role change or removal.
 *
 * Rules:
 * - The project owner must always retain the PROJECT_MANAGER role and cannot
 *   be removed.
 * - Nobody may change their own project role.
 * - A project manager cannot grant a role above their own effective role.
 * - A role cannot exceed the target member's workspace/institution ceiling.
 * - The last project manager cannot be demoted or removed.
 */
export function assertMayManageProjectMember(input: {
  actorId: string;
  actorIsWorkspaceAdmin: boolean;
  actorProjectRole: ProjectRole | null;
  targetUserId: string;
  targetProjectRole: ProjectRole;
  targetIsOwner: boolean;
  targetCeiling: ProjectRole;
  requestedRole?: ProjectRole | undefined;
  action: 'add' | 'update' | 'remove';
}): void {
  if (input.action === 'remove') {
    if (input.targetIsOwner) {
      throw new AppError(
        409,
        'PROJECT_OWNER_CANNOT_BE_REMOVED',
        'Transfer project ownership before removing the project owner',
      );
    }
    if (!input.actorIsWorkspaceAdmin && input.actorId === input.targetUserId) {
      throw new AppError(
        403,
        'PROJECT_SELF_MEMBER_CHANGE_FORBIDDEN',
        'You cannot remove your own project membership',
      );
    }
    if (input.actorProjectRole === 'PROJECT_MANAGER' && input.targetProjectRole === 'PROJECT_MANAGER') {
      // The last-manager guard is enforced by the service inside the
      // transaction where the manager count is known.
      return;
    }
  }

  const requestedRole = input.requestedRole;
  if (!requestedRole) return;

  if (input.targetIsOwner && requestedRole !== 'PROJECT_MANAGER') {
    throw new AppError(
      409,
      'PROJECT_OWNER_ROLE_REQUIRED',
      'The project owner must retain the project manager role',
    );
  }

  if (input.actorId === input.targetUserId && input.action === 'update') {
    throw new AppError(
      403,
      'PROJECT_SELF_ROLE_CHANGE_FORBIDDEN',
      'You cannot change your own project role',
    );
  }

  if (!input.actorIsWorkspaceAdmin) {
    const actorCeiling = input.actorProjectRole
      ? PROJECT_ROLE_RANK[input.actorProjectRole]
      : -1;
    if (PROJECT_ROLE_RANK[requestedRole] > actorCeiling) {
      throw new AppError(
        403,
        'PROJECT_ROLE_ESCALATION',
        'You cannot grant a project role above your own role',
        { details: { requestedRole, actorRole: input.actorProjectRole } },
      );
    }
  }

  if (projectRoleExceedsCeiling(requestedRole, input.targetCeiling)) {
    throw new AppError(
      422,
      'PROJECT_ROLE_EXCEEDS_TARGET_CEILING',
      'The requested project role is above the target member’s maximum project role',
      { details: { requestedRole, maximumRole: input.targetCeiling } },
    );
  }
}
