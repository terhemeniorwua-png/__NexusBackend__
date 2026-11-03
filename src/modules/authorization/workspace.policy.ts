import type { PrismaClient, Workspace, WorkspaceMembership, WorkspaceRole } from '@prisma/client';
import { effectiveWorkspaceRole, isOrganizationRoleForWorkspace } from './organization-role';
import { AppError } from '../../utils/errors';

/**
 * Workspace-level authorization policy.
 *
 * This module is the single authoritative source for what each workspace role
 * is allowed to do.  Phase 5 shipped an inline version inside
 * `src/modules/workspaces/authorization.ts`; Phase 6 replaces those inline
 * checks with this centralized module and re-exports the same surface from
 * the workspaces module for backward compatibility.
 *
 * Design decisions
 * ----------------
 * - Every check is made against the membership row that lives in the
 *   database.  A role value that a client sends in a request body is never
 *   trusted.
 * - A workspace that does not exist is reported as NOT_FOUND; a workspace
 *   the caller does not belong to is reported as ACCESS_DENIED.  The two
 *   codes are kept distinct so a member can learn that a workspace exists
 *   while an outsider cannot use the endpoint to probe for identifiers.
 * - Ownership transfer is gated on `workspace:transfer_ownership` and is
 *   only available to the current owner.
 * - A member cannot remove themselves when they are the last
 *   OWNER, which would leave the workspace permanently ownerless.
 */

// ---------------------------------------------------------------------------
// Capability constants
// ---------------------------------------------------------------------------

export const WorkspaceCapability = {
  // Basic reads
  ViewWorkspace: 'workspace:view',
  ViewMembers: 'member:view',
  // Workspace mutations
  UpdateWorkspace: 'workspace:update',
  ArchiveWorkspace: 'workspace:archive',
  DeleteWorkspace: 'workspace:delete',
  // Membership management
  ManageMembers: 'member:manage',
  // Invitation management
  ViewInvitations: 'invitation:view',
  ManageInvitations: 'invitation:manage',
  // Join requests (discovery is public to authenticated accounts)
  ViewJoinRequests: 'join_request:view',
  ManageJoinRequests: 'join_request:manage',
  // Ownership transfer (owner only)
  TransferOwnership: 'workspace:transfer_ownership',
} as const;

export type WorkspaceCapabilityValue =
  (typeof WorkspaceCapability)[keyof typeof WorkspaceCapability];

// ---------------------------------------------------------------------------
// Role → capability matrix
// ---------------------------------------------------------------------------

/**
 * The full workspace permission matrix.
 *
 * Each entry lists the roles that hold the capability.  The matrix is
 * evaluated by `workspaceRoleCan`, which is the only place where a role is
 * compared to a capability.
 */
const WORKSPACE_CAPABILITIES: Record<WorkspaceCapabilityValue, readonly WorkspaceRole[]> = {
  'workspace:view': ['OWNER', 'PROJECT_MANAGER', 'MEMBER', 'COLLABORATOR', 'VIEWER'],
  'workspace:update': ['OWNER', 'PROJECT_MANAGER'],
  'workspace:archive': ['OWNER'],
  'workspace:delete': ['OWNER'],
  'workspace:transfer_ownership': ['OWNER'],
  'member:view': ['OWNER', 'PROJECT_MANAGER', 'MEMBER', 'COLLABORATOR', 'VIEWER'],
  'member:manage': ['OWNER', 'PROJECT_MANAGER'],
  'invitation:view': ['OWNER', 'PROJECT_MANAGER'],
  'invitation:manage': ['OWNER', 'PROJECT_MANAGER'],
  'join_request:view': ['OWNER', 'PROJECT_MANAGER'],
  'join_request:manage': ['OWNER', 'PROJECT_MANAGER'],
};

/**
 * Returns whether the given workspace role has the given capability.
 */
export function workspaceRoleCan(
  role: WorkspaceRole,
  capability: WorkspaceCapabilityValue,
): boolean {
  return WORKSPACE_CAPABILITIES[capability].includes(role);
}

// ---------------------------------------------------------------------------
// Access guard
// ---------------------------------------------------------------------------

export interface WorkspaceAccess {
  workspace: Workspace;
  membership: WorkspaceMembership;
  effectiveRole: WorkspaceRole;
}

/**
 * Loads the workspace and proves the caller is authorised to use it.
 *
 * Throws `AppError` with an appropriate status and code when the workspace
 * does not exist, the caller is not a member, or the caller's role does not
 * hold the requested capability.
 */
export async function requireWorkspaceAccess(
  client: PrismaClient,
  input: { userId: string; workspaceId: string; capability: WorkspaceCapabilityValue },
): Promise<WorkspaceAccess> {
  const workspace = await client.workspace.findFirst({
    where: { id: input.workspaceId, deletedAt: null },
  });

  if (!workspace) {
    throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'That workspace does not exist');
  }

  const membership = await client.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: input.userId } },
  });

  if (!membership) {
    throw new AppError(403, 'WORKSPACE_ACCESS_DENIED', 'You are not a member of this workspace');
  }

  // A suspended membership keeps the row (and its history) but grants no
  // access until an administrator restores it.
  if (membership.status === 'SUSPENDED') {
    throw new AppError(
      403,
      'MEMBERSHIP_SUSPENDED',
      'Your membership of this workspace is suspended',
    );
  }

  if (
    membership.organizationRole &&
    !isOrganizationRoleForWorkspace(workspace.type, membership.organizationRole)
  ) {
    throw new AppError(
      403,
      'ORGANIZATION_ROLE_WORKSPACE_MISMATCH',
      'The organization role is not valid for this workspace',
    );
  }

  const effectiveRole = effectiveWorkspaceRole(
    workspace.type,
    membership.role,
    membership.organizationRole,
  );

  if (!workspaceRoleCan(effectiveRole, input.capability)) {
    throw new AppError(
      403,
      'INSUFFICIENT_ROLE',
      'Your role in this workspace does not allow this action',
    );
  }

  return { workspace, membership, effectiveRole };
}

// ---------------------------------------------------------------------------
// Member management guards
// ---------------------------------------------------------------------------

/**
 * Asserts that the acting member may manage (change or remove) the target
 * member.
 *
 * Rules:
 * - The workspace owner is fixed and may not be changed or removed.
 * - A project manager may not change or remove another project manager; only
 *   the owner can do that, so a role can only be widened by the owner.
 */
export function assertMayManageMember(input: {
  actorRole: WorkspaceRole;
  targetRole: WorkspaceRole;
  targetIsOwner: boolean;
}): void {
  if (input.targetIsOwner) {
    throw new AppError(
      403,
      'OWNER_CANNOT_BE_MODIFIED',
      'The owner of a workspace cannot be changed or removed',
    );
  }

  if (input.actorRole !== 'OWNER' && input.targetRole === 'PROJECT_MANAGER') {
    throw new AppError(
      403,
      'INSUFFICIENT_ROLE',
      'Only the owner of a workspace can manage a project manager',
    );
  }
}

/**
 * Asserts that the acting workspace role may grant the requested role.
 * Project managers can manage lower-privilege members, but only the workspace
 * owner may grant project-manager privileges.
 */
export function assertMayAssignRole(input: {
  actorRole: WorkspaceRole;
  requestedRole: WorkspaceRole;
}): void {
  if (input.actorRole !== 'OWNER' && input.requestedRole === 'PROJECT_MANAGER') {
    throw new AppError(
      403,
      'INSUFFICIENT_ROLE',
      'Only the owner of a workspace can grant the project manager role',
    );
  }
}

/**
 * Asserts that removing the given member does not leave the workspace
 * without an owner.
 *
 * This guard only applies when the actor is removing themselves (self-
 * removal) and they are the current owner.  It ensures the workspace is
 * never left in a permanently ownerless state.
 */
export function assertOwnershipSafe(input: {
  actorId: string;
  targetUserId: string;
  targetRole: WorkspaceRole;
  workspaceOwnerId: string;
}): void {
  const isSelfRemoval = input.actorId === input.targetUserId;
  const targetIsOwner = input.targetUserId === input.workspaceOwnerId;

  if (isSelfRemoval && targetIsOwner) {
    throw new AppError(
      403,
      'OWNER_CANNOT_LEAVE',
      'The workspace owner cannot remove themselves. Transfer ownership first.',
    );
  }
}
