/**
 * Workspace authorization — Phase 5 compatibility shim.
 *
 * Phase 5 shipped workspace access checks inline in this file.  Phase 6
 * moved every policy to the centralized `src/modules/authorization` module.
 *
 * This file re-exports everything that the workspace module consumers already
 * import from here so that no existing import paths need to change, while the
 * single source of truth lives in the authorization module.
 */
export {
  WorkspaceCapability,
  workspaceRoleCan as roleCan,
  workspaceRoleCan,
  requireWorkspaceAccess,
  assertMayManageMember,
  assertOwnershipSafe,
} from '../authorization/workspace.policy';

export type { WorkspaceCapabilityValue, WorkspaceAccess } from '../authorization/workspace.policy';
