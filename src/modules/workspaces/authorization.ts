import type { PrismaClient, Workspace, WorkspaceMembership, WorkspaceRole } from '@prisma/client';
import { AppError } from '../../utils/errors';

/**
 * Workspace access rules.
 *
 * Phase 5 needs a small, explicit set of rules: who may read a workspace,
 * who may change it and who may manage the members and the invitations.
 * The full permission matrix, including project and team scopes, is built in
 * Phase 6 on top of these checks.
 *
 * Every check is made against the membership of the caller in the database.
 * A role that a client sends in a request body is never trusted.
 */

export const WorkspaceCapability = {
  ViewWorkspace: 'workspace:view',
  UpdateWorkspace: 'workspace:update',
  ArchiveWorkspace: 'workspace:archive',
  DeleteWorkspace: 'workspace:delete',
  ViewMembers: 'member:view',
  ManageMembers: 'member:manage',
  ViewInvitations: 'invitation:view',
  ManageInvitations: 'invitation:manage',
} as const;

export type WorkspaceCapabilityValue =
  (typeof WorkspaceCapability)[keyof typeof WorkspaceCapability];

const CAPABILITIES: Record<WorkspaceCapabilityValue, readonly WorkspaceRole[]> = {
  'workspace:view': ['OWNER', 'PROJECT_MANAGER', 'MEMBER', 'COLLABORATOR', 'VIEWER'],
  'workspace:update': ['OWNER', 'PROJECT_MANAGER'],
  'workspace:archive': ['OWNER'],
  'workspace:delete': ['OWNER'],
  'member:view': ['OWNER', 'PROJECT_MANAGER', 'MEMBER', 'COLLABORATOR', 'VIEWER'],
  'member:manage': ['OWNER', 'PROJECT_MANAGER'],
  'invitation:view': ['OWNER', 'PROJECT_MANAGER'],
  'invitation:manage': ['OWNER', 'PROJECT_MANAGER'],
};

export function roleCan(role: WorkspaceRole, capability: WorkspaceCapabilityValue): boolean {
  return CAPABILITIES[capability].includes(role);
}

export interface WorkspaceAccess {
  workspace: Workspace;
  membership: WorkspaceMembership;
}

/**
 * Loads a workspace and proves that the caller may use it.
 *
 * A workspace that does not exist is reported as missing, a workspace the
 * caller does not belong to is reported as forbidden. The two cases are kept
 * apart on purpose: a member learns that a workspace exists, somebody
 * outside does not, so the endpoint cannot be used to probe for identifiers.
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

  if (!roleCan(membership.role, input.capability)) {
    throw new AppError(
      403,
      'INSUFFICIENT_ROLE',
      'Your role in this workspace does not allow this action',
    );
  }

  return { workspace, membership };
}

/**
 * Checks that the actor may manage a member with the given role.
 *
 * The owner of a workspace is fixed and may not be touched at all. A project
 * manager may not change or remove another project manager, so a role can
 * only be widened by the owner.
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
