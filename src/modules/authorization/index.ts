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
} from './project.policy';
export type { ProjectCapabilityValue, ProjectAccess } from './project.policy';

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
