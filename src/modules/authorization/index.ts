/**
 * Centralized authorization module.
 *
 * Phase 6 introduces a single entry point for every permission check in the
 * application. All three scopes (workspace, project, team) live here.
 *
 * Usage
 * -----
 * Import the relevant policy guards from this module:
 *
 *   import {
 *     WorkspaceCapability,
 *     requireWorkspaceAccess,
 *     assertMayManageMember,
 *     assertOwnershipSafe,
 *     ProjectCapability,
 *     requireProjectAccess,
 *     TeamCapability,
 *     requireTeamAccess,
 *   } from '../../modules/authorization';
 *
 * The workspace module re-exports from this module for backward compatibility
 * with Phase 5 code; no other module should import from
 * `../workspaces/authorization` directly.
 */

// Workspace
export {
  WorkspaceCapability,
  workspaceRoleCan,
  requireWorkspaceAccess,
  assertMayManageMember,
  assertMayAssignRole,
  assertOwnershipSafe,
} from './workspace.policy';
export type { WorkspaceCapabilityValue, WorkspaceAccess } from './workspace.policy';

// Project
export {
  ProjectCapability,
  workspaceRoleCanOnProject,
  projectRoleCan,
  requireProjectAccess,
  maximumProjectRoleForOrganizationRole,
  organizationRoleCanOwnProjects,
} from './project.policy';
export type { ProjectCapabilityValue, ProjectAccess } from './project.policy';

// Project permission catalog and central project authorization
export {
  ProjectPermission,
  ALL_PROJECT_PERMISSIONS,
  PROJECT_ROLE_RANK,
  PROJECT_ROLE_PERMISSIONS,
  PROJECT_ROLE_DEFINITIONS,
  WORKSPACE_ADMIN_PROJECT_PERMISSIONS,
  assignableProjectRoles,
  assertMayManageProjectMember,
  assertNotSelfReview,
  capProjectRole,
  maximumProjectRoleForMember,
  maximumProjectRoleForWorkspaceRole,
  projectPermissionsForRole,
  projectRoleExceedsCeiling,
  projectRoleHasPermission,
} from './project.permissions';
export type { ProjectPermissionValue, ProjectRoleDefinition } from './project.permissions';
export {
  authorizeProject,
  getProjectAuthorization,
  projectAssignableRoles,
  projectRoleDefinitions,
  requireProjectPermission,
  resolveProjectAuthorization,
} from './project.authorization';
export type {
  ProjectAccessSource,
  ProjectActor,
  ProjectAuthorization,
  ProjectAuthorizationClient,
  ProjectAuthorizationResource,
} from './project.authorization';

// Channel
export { ChannelCapability, requireChannelAccess } from './channel.policy';
export type { ChannelCapabilityValue, ChannelAccess } from './channel.policy';

// Team
export {
  TeamCapability,
  workspaceRoleCanOnTeam,
  teamRoleCan,
  requireTeamAccess,
} from './team.policy';
export type { TeamCapabilityValue, TeamAccess } from './team.policy';

// Shared types
export type { ScopeKind, AuthorizationFailure } from './types';

// Organization roles and scoped department access
export { DepartmentCapability, requireDepartmentAccess } from './department.policy';
export type { DepartmentAccess, DepartmentCapabilityValue } from './department.policy';
export {
  assertCanAssignOrganizationRole,
  assertMayManageOrganizationMember,
  effectiveWorkspaceRole,
  isOrganizationAdminRole,
  isOrganizationOwnerRole,
  isOrganizationRoleForWorkspace,
  ownerOrganizationRole,
  requireOrganizationRoleForWorkspace,
} from './organization-role';
