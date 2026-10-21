import type {
  InvitationStatus,
  InvitationType,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '@prisma/client';

/**
 * Shapes the workspace module returns over HTTP.
 *
 * The types are deliberately flat. The frontend needs a stable contract, and a
 * flat shape keeps the response format consistent with the other modules.
 */

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: WorkspaceStatus;
  ownerId: string;
  /** The role of the caller inside this workspace. */
  role: WorkspaceRole;
  memberCount: number;
  projectCount: number;
  teamCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  status: UserStatus;
  role: WorkspaceRole;
  joinedAt: Date;
  /** True for the account that owns the workspace. */
  owner: boolean;
}

export interface InvitationSummary {
  id: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  role: WorkspaceRole;
  type: InvitationType;
  status: InvitationStatus;
  invitedBy: { id: string; name: string };
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * The public view of an invitation.
 *
 * It is reachable with the invitation token alone, so it only carries the
 * details a person needs to decide whether to accept: the workspace, who sent
 * the invitation, the role and the expiry. The address is masked, because the
 * link can end up in a forwarded mail.
 */
export interface InvitationPreview {
  workspace: { id: string; name: string; slug: string };
  invitedBy: { id: string; name: string };
  role: WorkspaceRole;
  status: InvitationStatus;
  expiresAt: Date;
  /** The address the invitation was sent to, with the local part masked. */
  maskedEmail: string;
  /** True when the invitation is bound to a registered account. */
  boundToAccount: boolean;
}

export interface InvitationResult {
  invitation: InvitationSummary;
  /** False when the invitation could not be handed to the mail provider. */
  emailSent: boolean;
}
