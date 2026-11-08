import type {
  InvitationStatus,
  InvitationType,
  JoinRequestStatus,
  OrganizationRole,
  UserStatus,
  WorkspaceMembershipStatus,
  WorkspaceRole,
  WorkspaceStatus,
  WorkspaceType,
  WorkspaceVisibility,
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
  type: WorkspaceType;
  isPersonal: boolean;
  visibility: WorkspaceVisibility;
  status: WorkspaceStatus;
  ownerId: string;
  /** The role of the caller inside this workspace. */
  role: WorkspaceRole;
  organizationRole: OrganizationRole | null;
  /** True when an administrator has enabled a join code. */
  joinCodeEnabled: boolean;
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
  organizationRole: OrganizationRole | null;
  membershipStatus: WorkspaceMembershipStatus;
  joinedAt: Date;
  /** True for the account that owns the workspace. */
  owner: boolean;
}

export interface DepartmentSummary {
  id: string;
  workspaceId: string;
  name: string;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface InvitationSummary {
  id: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  role: WorkspaceRole;
  organizationRole: OrganizationRole | null;
  type: InvitationType;
  status: InvitationStatus;
  invitedBy: { id: string; name: string };
  expiresAt: Date;
  acceptedAt: Date | null;
  declinedAt: Date | null;
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
  organizationRole: OrganizationRole | null;
  status: InvitationStatus;
  expiresAt: Date;
  /** The address the invitation was sent to, with the local part masked. */
  maskedEmail: string;
  /** True when the invitation is bound to a registered account. */
  boundToAccount: boolean;
}

/**
 * Why an invitation cannot be accepted or declined by the signed-in account.
 *
 * The public preview only describes the invitation. The authenticated
 * verification endpoint adds the viewer context, because whether an invitation
 * is actionable depends on the account that is signed in.
 */
export type InvitationVerificationReason =
  | 'EMAIL_MISMATCH'
  | 'ALREADY_ACCEPTED'
  | 'DECLINED'
  | 'REVOKED'
  | 'EXPIRED'
  | 'WORKSPACE_UNAVAILABLE'
  | 'ALREADY_A_MEMBER';

export interface InvitationViewer {
  userId: string;
  email: string;
  /** True when the signed-in account is the intended recipient. */
  emailMatches: boolean;
  /** True when the signed-in account already belongs to the workspace. */
  alreadyMember: boolean;
  /** The caller's current role when they already belong to the workspace. */
  membershipRole: WorkspaceRole | null;
  /** True only when accepting would create access the caller does not have. */
  canAccept: boolean;
  canDecline: boolean;
  /** Null when the invitation is actionable. */
  reason: InvitationVerificationReason | null;
}

/**
 * The authenticated view of an invitation.
 *
 * It carries the same safe preview as the public endpoint plus the caller's
 * eligibility, so the frontend never has to infer whether the signed-in
 * account is the intended recipient.
 */
export interface InvitationVerification extends InvitationPreview {
  viewer: InvitationViewer;
}

export interface InvitationResult {
  invitation: InvitationSummary;
  /** False when the invitation could not be handed to the mail provider. */
  emailSent: boolean;
}

/** A workspace shown in organisation discovery. */
export interface DiscoveredWorkspace {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  type: WorkspaceType;
  memberCount: number;
}

export interface JoinRequestSummary {
  id: string;
  workspaceId: string;
  workspaceName: string;
  userId: string;
  userName: string;
  userEmail: string;
  status: JoinRequestStatus;
  role: WorkspaceRole;
  organizationRole: OrganizationRole | null;
  teamId: string | null;
  message: string | null;
  reviewedBy: { id: string; name: string } | null;
  reviewedAt: Date | null;
  decisionNote: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface JoinCodeResult {
  workspaceId: string;
  code: string;
  link: string;
}
