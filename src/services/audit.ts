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
      ...(event.actorId ? { actorId: event.actorId } : {}),
      ...(event.metadata ? { metadata: event.metadata as Prisma.InputJsonValue } : {}),
      ...(event.ip ? { ip: event.ip.slice(0, 128) } : {}),
      ...(event.userAgent ? { userAgent: event.userAgent.slice(0, 512) } : {}),
    },
  });
}
