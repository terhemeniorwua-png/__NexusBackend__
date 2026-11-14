import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Audit trail.
 *
 * Every change to a workspace, its members and its invitations is written to
 * the `AuditLog` table. The row is written inside the transaction that
 * performs the change, so a change and its audit entry either both happen or
 * neither does.
 *
 * The trail never contains invitation tokens, passwords or other secrets. It
 * holds identifiers, roles and timestamps.
 */

export type AuditClient = PrismaClient | Prisma.TransactionClient;

export const WorkspaceAuditAction = {
  WorkspaceCreated: 'workspace.created',
  WorkspaceUpdated: 'workspace.updated',
  WorkspaceArchived: 'workspace.archived',
  WorkspaceRestored: 'workspace.restored',
  WorkspaceDeleted: 'workspace.deleted',
  OwnershipTransferred: 'workspace.ownership_transferred',
  MemberAdded: 'workspace.member_added',
  MemberRoleChanged: 'workspace.member_role_changed',
  MemberRemoved: 'workspace.member_removed',
  InvitationCreated: 'workspace.invitation_created',
  InvitationResent: 'workspace.invitation_resent',
  InvitationRevoked: 'workspace.invitation_revoked',
  InvitationAccepted: 'workspace.invitation_accepted',
  InvitationDeclined: 'workspace.invitation_declined',
  JoinRequestCreated: 'workspace.join_request_created',
  JoinRequestApproved: 'workspace.join_request_approved',
  JoinRequestRejected: 'workspace.join_request_rejected',
  JoinRequestWithdrawn: 'workspace.join_request_withdrawn',
  JoinCodeRotated: 'workspace.join_code_rotated',
  JoinCodeDisabled: 'workspace.join_code_disabled',
  MemberSuspended: 'workspace.member_suspended',
  MemberRestored: 'workspace.member_restored',
  DepartmentCreated: 'institution.department_created',
  DepartmentUpdated: 'institution.department_updated',
  DepartmentMemberAdded: 'institution.department_member_added',
  DepartmentMemberRemoved: 'institution.department_member_removed',
  TaskReassigned: 'task.reassigned',
} as const;

export type WorkspaceAuditActionValue =
  (typeof WorkspaceAuditAction)[keyof typeof WorkspaceAuditAction];

export const TeamAuditAction = {
  TeamCreated: 'team.created',
  TeamUpdated: 'team.updated',
  TeamArchived: 'team.archived',
  TeamDeleted: 'team.deleted',
  MemberAdded: 'team.member_added',
  MemberRoleChanged: 'team.member_role_changed',
  MemberRemoved: 'team.member_removed',
  LeadChanged: 'team.lead_changed',
} as const;

export type TeamAuditActionValue = (typeof TeamAuditAction)[keyof typeof TeamAuditAction];

export const ChannelAuditAction = {
  Created: 'channel.created',
  Updated: 'channel.updated',
  Archived: 'channel.archived',
  Deleted: 'channel.deleted',
  MemberAdded: 'channel.member_added',
  MemberRemoved: 'channel.member_removed',
} as const;

export const TaskAuditAction = {
  TaskCreated: 'task.created',
  TaskUpdated: 'task.updated',
  TaskDeleted: 'task.deleted',
  TaskArchived: 'task.archived',
  TaskRestored: 'task.restored',
  TaskCompleted: 'task.completed',
  TaskReopened: 'task.reopened',
  TaskReviewed: 'task.reviewed',
  TaskApproved: 'task.approved',
  TaskChangesRequested: 'task.changes_requested',
  AssigneeAdded: 'task.assignee_added',
  AssigneeRemoved: 'task.assignee_removed',
  DependencyAdded: 'task.dependency_added',
  DependencyRemoved: 'task.dependency_removed',
  CommentCreated: 'task.comment_created',
  CommentUpdated: 'task.comment_updated',
  CommentDeleted: 'task.comment_deleted',
} as const;

export type TaskAuditActionValue = (typeof TaskAuditAction)[keyof typeof TaskAuditAction];

/**
 * Project-scoped audit actions. These cover project settings, ownership,
 * membership (including role changes), archive/delete and milestones.
 */
export const ProjectAuditAction = {
  ProjectCreated: 'project.created',
  ProjectUpdated: 'project.updated',
  ProjectArchived: 'project.archived',
  ProjectRestored: 'project.restored',
  ProjectDeleted: 'project.deleted',
  OwnershipTransferred: 'project.ownership_transferred',
  MemberAdded: 'project.member_added',
  MemberRoleChanged: 'project.member_role_changed',
  MemberRemoved: 'project.member_removed',
  MilestoneCreated: 'project.milestone_created',
  MilestoneUpdated: 'project.milestone_updated',
  MilestoneDeleted: 'project.milestone_deleted',
  OrganizationAccessUpdated: 'project.organization_access_updated',
} as const;

export type ProjectAuditActionValue =
  (typeof ProjectAuditAction)[keyof typeof ProjectAuditAction];

/**
 * Audit actions that represent a security-relevant change to a workspace or
 * its membership. These are flagged on the audit log so they can be queried
 * and monitored separately from routine entries.
 */
export const SecurityAuditAction = {
  WorkspaceOwnershipTransferred: 'workspace.ownership_transferred',
  WorkspaceArchived: 'workspace.archived',
  WorkspaceDeleted: 'workspace.deleted',
  MemberRoleChanged: 'workspace.member_role_changed',
  MemberRemoved: 'workspace.member_removed',
  MemberSuspended: 'workspace.member_suspended',
  MemberRestored: 'workspace.member_restored',
  InvitationRevoked: 'workspace.invitation_revoked',
  JoinRequestRejected: 'workspace.join_request_rejected',
  JoinRequestWithdrawn: 'workspace.join_request_withdrawn',
  JoinCodeRotated: 'workspace.join_code_rotated',
  JoinCodeDisabled: 'workspace.join_code_disabled',
  DepartmentMemberRemoved: 'institution.department_member_removed',
  AiActionApproved: 'ai.action_approved',
  AiActionExecuted: 'ai.action_executed',
} as const;

export type SecurityAuditActionValue =
  (typeof SecurityAuditAction)[keyof typeof SecurityAuditAction];

/**
 * Returns true when an audit action is classified as a security event.
 */
export function isSecurityEvent(action: string): boolean {
  return Object.values(SecurityAuditAction).includes(action as SecurityAuditActionValue);
}

export const MessageAuditAction = {
  MessageCreated: 'message.created',
  MessageEdited: 'message.edited',
  MessageDeleted: 'message.deleted',
  MessagePinned: 'message.pinned',
  MessageUnpinned: 'message.unpinned',
  ReactionAdded: 'message.reaction_added',
  ReactionRemoved: 'message.reaction_removed',
} as const;

export type MessageAuditActionValue = (typeof MessageAuditAction)[keyof typeof MessageAuditAction];

export interface AuditEventInput {
  workspaceId?: string | null;
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown> | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Writes an audit entry.
 *
 * The caller decides whether the write happens inside a transaction. A change
 * to a membership must always be recorded, so those calls run inside the same
 * transaction as the change itself.
 */
export async function recordAuditEvent(client: AuditClient, event: AuditEventInput): Promise<void> {
  await client.auditLog.create({
    data: {
      workspaceId: event.workspaceId ?? null,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      securityEvent: isSecurityEvent(event.action),
      ...(event.actorId ? { actorId: event.actorId } : {}),
      ...(event.metadata ? { metadata: event.metadata as Prisma.InputJsonValue } : {}),
      ...(event.ip ? { ip: event.ip.slice(0, 128) } : {}),
      ...(event.userAgent ? { userAgent: event.userAgent.slice(0, 512) } : {}),
    },
  });
}
