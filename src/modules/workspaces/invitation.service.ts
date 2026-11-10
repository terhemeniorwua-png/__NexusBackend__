import {
  Prisma,
  type Invitation,
  type OrganizationRole,
  type PrismaClient,
  type WorkspaceRole,
} from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import type { RequestContext } from '../auth/auth.types';
import { recordAuditEvent, WorkspaceAuditAction } from '../../services/audit';
import { buildEmailBrand, buildWorkspaceInvitationEmail } from '../../services/email';
import { sendEmail } from '../../services/email';
import { createNotification } from '../../services/notifications';
import { enqueueAutomationRunsSafely } from '../automation/automation.events';
import { generateSecureToken, hashSecret } from '../../utils/crypto';
import { AppError } from '../../utils/errors';
import { assertMayAssignRole, requireWorkspaceAccess, WorkspaceCapability } from './authorization';
import {
  assertCanAssignOrganizationRole,
  effectiveWorkspaceRole,
} from '../authorization/organization-role';
import type { CreateInvitationInput } from './workspace.schemas';
import type {
  InvitationPreview,
  InvitationResult,
  InvitationSummary,
  InvitationVerification,
  InvitationVerificationReason,
} from './workspace.types';
import { assertWorkspaceSeatCapacity } from '../billing/membership-billing';
import { TeamCapability, requireTeamAccess } from '../authorization';

/**
 * Workspace invitations.
 *
 * An invitation is a single use link that grants a membership. The raw token
 * only exists in the mail that carries it: the database keeps a SHA-256
 * digest, so a database leak does not hand out access.
 *
 * The rules the service enforces:
 *
 * - A pending invitation is unique per address and workspace, so the same
 *   person cannot hold two live invitations.
 * - The token expires, and an expired invitation is rejected instead of
 *   granted.
 * - The accepting account has to be the one the invitation was meant for:
 *   either the account it is bound to, or the account that owns the address
 *   it was sent to.
 * - The acceptance is applied once. A second attempt with the same token is
 *   rejected, even when it arrives at the same moment as the first one.
 */

export interface InvitationService {
  create(
    input: { userId: string; workspaceId: string } & CreateInvitationInput,
    ctx: RequestContext,
  ): Promise<InvitationResult>;
  createTeam(
    input: { userId: string; workspaceId: string; teamId: string; targetUserId: string },
    ctx: RequestContext,
  ): Promise<InvitationResult>;
  listTeam(input: {
    userId: string;
    workspaceId: string;
    teamId: string;
    status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED' | 'EXPIRED' | 'ALL';
  }): Promise<InvitationSummary[]>;
  revokeTeam(input: {
    userId: string;
    workspaceId: string;
    teamId: string;
    invitationId: string;
  }): Promise<InvitationSummary>;
  list(input: {
    userId: string;
    workspaceId: string;
    status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED' | 'EXPIRED' | 'ALL';
  }): Promise<InvitationSummary[]>;
  resend(
    input: { userId: string; workspaceId: string; invitationId: string },
    ctx: RequestContext,
  ): Promise<InvitationResult>;
  revoke(input: {
    userId: string;
    workspaceId: string;
    invitationId: string;
  }): Promise<InvitationSummary>;
  preview(token: string): Promise<InvitationPreview>;
  verify(input: { userId: string; token: string }): Promise<InvitationVerification>;
  accept(input: { userId: string; token: string }, ctx: RequestContext): Promise<InvitationSummary>;
  decline(
    input: { userId: string; token: string },
    ctx: RequestContext,
  ): Promise<InvitationSummary>;
  listMine(userId: string): Promise<InvitationSummary[]>;
}

const ROLE_LABELS: Record<WorkspaceRole, string> = {
  OWNER: 'owner',
  PROJECT_MANAGER: 'project manager',
  MEMBER: 'member',
  COLLABORATOR: 'collaborator',
  VIEWER: 'viewer',
};

export function maskInvitationEmail(email: string): string {
  const [local, domain] = email.split('@');

  if (!local || !domain) {
    return '***';
  }

  return `${local.slice(0, 1)}***@${domain}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isInvitationRecipient(
  invitation: Pick<Invitation, 'email' | 'forUserId'>,
  user: { id: string; email: string },
): boolean {
  // A bound invitation belongs to one account, even if that account later
  // changes its address. An unbound invitation belongs to the address it was
  // sent to.
  return invitation.forUserId !== null
    ? invitation.forUserId === user.id
    : normalizeEmail(invitation.email) === normalizeEmail(user.email);
}

function pendingKeyFor(workspaceId: string, email: string): string {
  return `workspace:${workspaceId}:email:${email}`;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function createInvitationService(
  config: AppConfig,
  prisma?: PrismaClient,
): InvitationService {
  const client = prisma ?? getPrismaClient();
  const brand = buildEmailBrand(config);
  const collaborationEmailNotifier = createCollaborationEmailNotifier(config, { prisma: client });

  function acceptUrl(token: string): string {
    const base = config.frontendUrl.replace(/\/+$/, '');

    return `${base}${config.workspaceInvitationLinkPath}?token=${encodeURIComponent(token)}`;
  }

  function roleLabel(role: WorkspaceRole, organizationRole: OrganizationRole | null): string {
    return organizationRole
      ? organizationRole.toLowerCase().replaceAll('_', ' ')
      : ROLE_LABELS[role];
  }

  function toSummary(
    invitation: Invitation & {
      workspace: { id: string; name: string };
      invitedBy: { id: string; name: string };
      team?: { id: string; name: string } | null;
    },
  ): InvitationSummary {
    return {
      id: invitation.id,
      workspaceId: invitation.workspaceId,
      workspaceName: invitation.workspace.name,
      email: invitation.email,
      role: invitation.role,
      organizationRole: invitation.organizationRole,
      type: invitation.type,
      ...(invitation.team ? { teamId: invitation.team.id, teamName: invitation.team.name } : {}),
      status: invitation.status,
      invitedBy: { id: invitation.invitedBy.id, name: invitation.invitedBy.name },
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      declinedAt: invitation.declinedAt,
      revokedAt: invitation.revokedAt,
      createdAt: invitation.createdAt,
    };
  }

  const summaryInclude = {
    workspace: { select: { id: true, name: true } },
    invitedBy: { select: { id: true, name: true } },
    team: { select: { id: true, name: true } },
  } as const;

  /**
   * Marks the invitations whose deadline has passed as expired.
   *
   * The check on the deadline is done on every read anyway, so the sweep only
   * keeps the stored state honest.
   */
  async function expireStale(workspaceId?: string): Promise<void> {
    await client.invitation.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: { lte: new Date() },
        ...(workspaceId ? { workspaceId } : {}),
      },
      data: { status: 'EXPIRED', pendingKey: null },
    });
  }

  async function lockActiveWorkspace(
    tx: Prisma.TransactionClient,
    workspaceId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ status: string; deletedAt: Date | null }>>`
      SELECT "status"::text AS "status", "deletedAt"
      FROM "Workspace"
      WHERE "id" = ${workspaceId}
      FOR UPDATE
    `;
    if (!rows[0] || rows[0].status !== 'ACTIVE' || rows[0].deletedAt) {
      throw new AppError(409, 'WORKSPACE_NOT_ACTIVE', 'This workspace is not active');
    }
  }

  /**
   * Builds and sends the invitation mail.
   *
   * A delivery failure is reported instead of thrown: the invitation itself
   * exists and the inviter can send it again.
   */
  async function sendInvitationMail(input: {
    invitationId: string;
    email: string;
    inviteeName: string | null;
    inviterName: string;
    workspaceName: string;
    role: WorkspaceRole;
    organizationRole: OrganizationRole | null;
    token: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<boolean> {
    const result = await sendEmail(
      buildWorkspaceInvitationEmail({
        to: input.email,
        name: input.inviteeName ?? 'there',
        brand,
        inviterName: input.inviterName,
        workspaceName: input.workspaceName,
        acceptUrl: acceptUrl(input.token),
        role: roleLabel(input.role, input.organizationRole),
        expiresAt: input.expiresAt,
        idempotencyKey: `workspace-invitation:${input.invitationId}:${input.tokenHash}`,
      }),
    );

    return result.accepted;
  }

  return {
    async create(input, ctx): Promise<InvitationResult> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ManageInvitations,
        allowArchived: true,
      });

      if (access.workspace.status !== 'ACTIVE') {
        throw new AppError(409, 'WORKSPACE_NOT_ACTIVE', 'This workspace is not active');
      }

      if (input.organizationRole) {
        assertCanAssignOrganizationRole({
          workspaceType: access.workspace.type,
          actorLegacyRole: access.effectiveRole,
          actorOrganizationRole: access.membership.organizationRole,
          requestedRole: input.organizationRole,
        });
      } else {
        assertMayAssignRole({
          actorRole: access.effectiveRole,
          requestedRole: input.role as WorkspaceRole,
        });
      }
      const assignedRole = input.organizationRole
        ? effectiveWorkspaceRole(access.workspace.type, 'MEMBER', input.organizationRole)
        : (input.role as WorkspaceRole);

      const inviter = await client.user.findUnique({
        where: { id: input.userId },
        select: { id: true, name: true, email: true },
      });

      if (!inviter) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      // An invitation for an address that already belongs to the workspace
      // makes no sense.
      const existingUser = await client.user.findUnique({
        where: { email: input.email },
        select: { id: true, name: true, status: true, deletedAt: true },
      });

      if (existingUser && !existingUser.deletedAt) {
        const membership = await client.workspaceMembership.findUnique({
          where: {
            workspaceId_userId: { workspaceId: access.workspace.id, userId: existingUser.id },
          },
        });

        if (membership) {
          throw new AppError(
            409,
            'ALREADY_A_MEMBER',
            'This account is already a member of the workspace',
          );
        }
      }

      const token = generateSecureToken();
      const tokenHash = hashSecret(token);
      const expiresAt = new Date(Date.now() + config.workspaceInvitationTtlSeconds * 1_000);

      let invitation: Invitation;
      try {
        invitation = await client.$transaction(async (tx) => {
          await lockActiveWorkspace(tx, access.workspace.id);
          await tx.invitation.updateMany({
            where: {
              workspaceId: access.workspace.id,
              email: input.email,
              status: 'PENDING',
              expiresAt: { lte: new Date() },
            },
            data: { status: 'EXPIRED', pendingKey: null },
          });
          const pending = await tx.invitation.findFirst({
            where: { workspaceId: access.workspace.id, email: input.email, status: 'PENDING' },
            select: { id: true },
          });
          if (pending) {
            throw new AppError(
              409,
              'INVITATION_EXISTS',
              'An invitation for this address is still pending. Resend it instead.',
            );
          }
          const created = await tx.invitation.create({
            data: {
              workspaceId: access.workspace.id,
              email: input.email,
              role: assignedRole,
              organizationRole: input.organizationRole ?? null,
              type: 'WORKSPACE',
              tokenHash,
              status: 'PENDING',
              invitedById: input.userId,
              // The invitation is bound to the account as soon as one exists,
              // so only that account can accept it.
              ...(existingUser && !existingUser.deletedAt ? { forUserId: existingUser.id } : {}),
              expiresAt,
              pendingKey: pendingKeyFor(access.workspace.id, input.email),
            },
          });

          await recordAuditEvent(tx, {
            workspaceId: access.workspace.id,
            actorId: input.userId,
            action: WorkspaceAuditAction.InvitationCreated,
            targetType: 'Invitation',
            targetId: created.id,
            metadata: {
              email: input.email,
              role: assignedRole,
              organizationRole: input.organizationRole ?? null,
              type: 'WORKSPACE',
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });

          return created;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError(
            409,
            'INVITATION_EXISTS',
            'An invitation for this address is still pending. Resend it instead.',
          );
        }
        throw error;
      }

      const emailSent = await sendInvitationMail({
        invitationId: invitation.id,
        email: invitation.email,
        inviteeName: existingUser && !existingUser.deletedAt ? existingUser.name : null,
        inviterName: inviter.name,
        workspaceName: access.workspace.name,
        role: invitation.role,
        organizationRole: invitation.organizationRole,
        token,
        tokenHash,
        expiresAt,
      });

      const stored = await client.invitation.findUnique({
        where: { id: invitation.id },
        include: summaryInclude,
      });

      if (!stored) {
        throw new AppError(500, 'INVITATION_NOT_STORED', 'The invitation could not be stored');
      }

      return { invitation: toSummary(stored), emailSent };
    },

    async createTeam(input, ctx): Promise<InvitationResult> {
      const workspace = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      if (workspace.workspace.status !== 'ACTIVE') {
        throw new AppError(409, 'WORKSPACE_NOT_ACTIVE', 'This workspace is not active');
      }
      const access = await requireTeamAccess(client, {
        userId: input.userId,
        workspaceId: workspace.workspace.id,
        teamId: input.teamId,
        workspaceRole: workspace.effectiveRole,
        capability: TeamCapability.ManageMembers,
      });
      if (access.team.status !== 'ACTIVE') {
        throw new AppError(409, 'TEAM_NOT_ACTIVE', 'Invitations cannot be sent to this team');
      }

      const recipientMembership = await client.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId: workspace.workspace.id, userId: input.targetUserId } },
        select: { status: true },
      });
      const recipient = await client.user.findUnique({
        where: { id: input.targetUserId },
        select: { id: true, name: true, email: true, status: true, deletedAt: true },
      });
      if (
        !recipient ||
        recipient.deletedAt ||
        recipient.status !== 'ACTIVE' ||
        recipientMembership?.status !== 'ACTIVE'
      ) {
        throw new AppError(404, 'TEAM_INVITATION_RECIPIENT_NOT_FOUND', 'That active workspace member does not exist');
      }

      const existingTeamMembership = await client.teamMembership.findUnique({
        where: { teamId_userId: { teamId: access.team.id, userId: recipient.id } },
        select: { id: true },
      });
      if (existingTeamMembership) {
        throw new AppError(409, 'ALREADY_A_TEAM_MEMBER', 'This account is already a member of the team');
      }

      const token = generateSecureToken();
      const tokenHash = hashSecret(token);
      const expiresAt = new Date(Date.now() + config.workspaceInvitationTtlSeconds * 1_000);
      const pendingKey = `team:${access.team.id}:user:${recipient.id}`;
      let invitation: Invitation;
      try {
        invitation = await client.$transaction(async (tx) => {
          await lockActiveWorkspace(tx, workspace.workspace.id);
          await tx.invitation.updateMany({
            where: { pendingKey, status: 'PENDING', expiresAt: { lte: new Date() } },
            data: { status: 'EXPIRED', pendingKey: null },
          });
          const pending = await tx.invitation.findFirst({
            where: { pendingKey, status: 'PENDING' },
            select: { id: true },
          });
          if (pending) {
            throw new AppError(409, 'TEAM_INVITATION_EXISTS', 'A team invitation is already pending');
          }
          const activeMembership = await tx.workspaceMembership.findUnique({
            where: {
              workspaceId_userId: { workspaceId: workspace.workspace.id, userId: recipient.id },
            },
            select: { status: true },
          });
          const activeRecipient = await tx.user.findFirst({
            where: { id: recipient.id, status: 'ACTIVE', deletedAt: null },
            select: { id: true },
          });
          const activeTeam = await tx.team.findFirst({
            where: { id: access.team.id, workspaceId: workspace.workspace.id, status: 'ACTIVE', deletedAt: null },
            select: { id: true },
          });
          if (activeMembership?.status !== 'ACTIVE' || !activeRecipient || !activeTeam) {
            throw new AppError(409, 'TEAM_INVITATION_NOT_AVAILABLE', 'The team invitation is no longer available');
          }
          const alreadyMember = await tx.teamMembership.findUnique({
            where: { teamId_userId: { teamId: access.team.id, userId: recipient.id } },
            select: { id: true },
          });
          if (alreadyMember) {
            throw new AppError(409, 'ALREADY_A_TEAM_MEMBER', 'This account is already a member of the team');
          }
          const created = await tx.invitation.create({
            data: {
              workspaceId: workspace.workspace.id,
              teamId: access.team.id,
              email: recipient.email,
              forUserId: recipient.id,
              role: 'MEMBER',
              type: 'TEAM',
              tokenHash,
              status: 'PENDING',
              invitedById: input.userId,
              expiresAt,
              pendingKey,
            },
          });
          await recordAuditEvent(tx, {
            workspaceId: workspace.workspace.id,
            actorId: input.userId,
            action: WorkspaceAuditAction.InvitationCreated,
            targetType: 'Invitation',
            targetId: created.id,
            metadata: { type: 'TEAM', teamId: access.team.id, recipientId: recipient.id },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          return created;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError(409, 'TEAM_INVITATION_EXISTS', 'A team invitation is already pending');
        }
        throw error;
      }

      const email = await collaborationEmailNotifier.notifyTeamInvitation({
        invitationId: invitation.id,
        token,
      });
      const stored = await client.invitation.findUnique({
        where: { id: invitation.id },
        include: summaryInclude,
      });
      if (!stored) throw new AppError(500, 'INVITATION_NOT_STORED', 'The invitation could not be stored');
      return { invitation: toSummary(stored), emailSent: email.accepted };
    },

    async listTeam(input): Promise<InvitationSummary[]> {
      const workspace = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      await requireTeamAccess(client, {
        userId: input.userId,
        workspaceId: workspace.workspace.id,
        teamId: input.teamId,
        workspaceRole: workspace.effectiveRole,
        capability: TeamCapability.ManageMembers,
      });
      await expireStale(workspace.workspace.id);
      const invitations = await client.invitation.findMany({
        where: {
          workspaceId: workspace.workspace.id,
          teamId: input.teamId,
          type: 'TEAM',
          ...(input.status === 'ALL' ? {} : { status: input.status }),
        },
        include: summaryInclude,
        orderBy: { createdAt: 'desc' },
      });
      return invitations.map(toSummary);
    },

    async revokeTeam(input): Promise<InvitationSummary> {
      const workspace = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      await requireTeamAccess(client, {
        userId: input.userId,
        workspaceId: workspace.workspace.id,
        teamId: input.teamId,
        workspaceRole: workspace.effectiveRole,
        capability: TeamCapability.ManageMembers,
      });
      const invitation = await client.invitation.findFirst({
        where: {
          id: input.invitationId,
          workspaceId: workspace.workspace.id,
          teamId: input.teamId,
          type: 'TEAM',
        },
      });
      if (!invitation) throw new AppError(404, 'INVITATION_NOT_FOUND', 'That invitation does not exist');
      if (invitation.status === 'ACCEPTED') {
        throw new AppError(409, 'INVITATION_ALREADY_ACCEPTED', 'This invitation has already been accepted');
      }
      if (invitation.status === 'REVOKED') {
        throw new AppError(409, 'INVITATION_REVOKED', 'This invitation was revoked');
      }
      const revoked = await client.$transaction(async (tx) => {
        await lockActiveWorkspace(tx, workspace.workspace.id);
        const changed = await tx.invitation.updateMany({
          where: {
            id: invitation.id,
            teamId: input.teamId,
            type: 'TEAM',
            status: { in: ['PENDING', 'DECLINED', 'EXPIRED'] },
          },
          data: { status: 'REVOKED', revokedAt: new Date(), pendingKey: null },
        });
        if (!changed.count) throw new AppError(409, 'INVITATION_STATE_CHANGED', 'The invitation state changed; refresh and try again');
        await recordAuditEvent(tx, {
          workspaceId: workspace.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.InvitationRevoked,
          targetType: 'Invitation',
          targetId: invitation.id,
          metadata: { type: 'TEAM', teamId: input.teamId, recipientId: invitation.forUserId },
        });
        return tx.invitation.findUnique({ where: { id: invitation.id }, include: summaryInclude });
      });
      if (!revoked) throw new AppError(500, 'INVITATION_NOT_STORED', 'The invitation could not be stored');
      return toSummary(revoked);
    },

    async list(input): Promise<InvitationSummary[]> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewInvitations,
      });

      await expireStale(access.workspace.id);

      const invitations = await client.invitation.findMany({
        where: {
          workspaceId: access.workspace.id,
          type: 'WORKSPACE',
          ...(input.status === 'ALL' ? {} : { status: input.status }),
        },
        include: summaryInclude,
        orderBy: { createdAt: 'desc' },
      });

      return invitations.map(toSummary);
    },

    async resend(input, ctx): Promise<InvitationResult> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ManageInvitations,
      });

      const invitation = await client.invitation.findFirst({
        where: { id: input.invitationId, workspaceId: access.workspace.id },
        include: { invitedBy: { select: { id: true, name: true } } },
      });

      if (!invitation) {
        throw new AppError(404, 'INVITATION_NOT_FOUND', 'That invitation does not exist');
      }
      if (invitation.type !== 'WORKSPACE') {
        throw new AppError(404, 'INVITATION_NOT_FOUND', 'That invitation does not exist');
      }

      // A resend re-issues the same role, so it must be held to the same role
      // assignment rule as creating the invitation. Otherwise a project
      // manager could not create a project-manager invitation but could
      // extend one that an owner created.
      if (invitation.organizationRole) {
        assertCanAssignOrganizationRole({
          workspaceType: access.workspace.type,
          actorLegacyRole: access.effectiveRole,
          actorOrganizationRole: access.membership.organizationRole,
          requestedRole: invitation.organizationRole,
        });
      } else {
        assertMayAssignRole({
          actorRole: access.effectiveRole,
          requestedRole: invitation.role,
        });
      }

      if (invitation.status === 'ACCEPTED') {
        throw new AppError(
          409,
          'INVITATION_ALREADY_ACCEPTED',
          'This invitation has already been accepted',
        );
      }

      if (invitation.status === 'REVOKED') {
        throw new AppError(409, 'INVITATION_REVOKED', 'This invitation was revoked');
      }

      if (invitation.status === 'DECLINED') {
        throw new AppError(409, 'INVITATION_DECLINED', 'The invitee declined this invitation');
      }

      if (invitation.status === 'EXPIRED' || invitation.expiresAt.getTime() <= Date.now()) {
        await client.invitation.updateMany({
          where: { id: invitation.id, status: 'PENDING', expiresAt: { lte: new Date() } },
          data: { status: 'EXPIRED', pendingKey: null },
        });

        throw new AppError(
          409,
          'INVITATION_EXPIRED',
          'This invitation has expired. Create a new one instead.',
        );
      }

      // A new token replaces the old one, so a link that was already sent
      // stops working.
      const token = generateSecureToken();
      const tokenHash = hashSecret(token);
      const expiresAt = new Date(Date.now() + config.workspaceInvitationTtlSeconds * 1_000);

      const updated = await client.$transaction(async (tx) => {
        await lockActiveWorkspace(tx, access.workspace.id);
        const result = await tx.invitation.updateMany({
          where: {
            id: invitation.id,
            workspaceId: access.workspace.id,
            status: 'PENDING',
            expiresAt: { gt: new Date() },
          },
          data: { tokenHash, expiresAt },
        });
        if (!result.count) {
          throw new AppError(
            409,
            'INVITATION_NOT_PENDING',
            'This invitation can no longer be resent',
          );
        }
        const changed = await tx.invitation.findUniqueOrThrow({ where: { id: invitation.id } });

        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.InvitationResent,
          targetType: 'Invitation',
          targetId: changed.id,
          metadata: { email: changed.email, role: changed.role },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return changed;
      });

      const invitee = await client.user.findUnique({
        where: { email: updated.email },
        select: { name: true, deletedAt: true },
      });

      const emailSent = await sendInvitationMail({
        invitationId: updated.id,
        email: updated.email,
        inviteeName: invitee && !invitee.deletedAt ? invitee.name : null,
        inviterName: invitation.invitedBy.name,
        workspaceName: access.workspace.name,
        role: updated.role,
        organizationRole: updated.organizationRole,
        token,
        tokenHash,
        expiresAt,
      });

      const stored = await client.invitation.findUnique({
        where: { id: updated.id },
        include: summaryInclude,
      });

      if (!stored) {
        throw new AppError(500, 'INVITATION_NOT_STORED', 'The invitation could not be stored');
      }

      return { invitation: toSummary(stored), emailSent };
    },

    async revoke(input): Promise<InvitationSummary> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ManageInvitations,
      });

      const invitation = await client.invitation.findFirst({
        where: { id: input.invitationId, workspaceId: access.workspace.id },
      });

      if (!invitation) {
        throw new AppError(404, 'INVITATION_NOT_FOUND', 'That invitation does not exist');
      }
      if (invitation.type !== 'WORKSPACE') {
        throw new AppError(404, 'INVITATION_NOT_FOUND', 'That invitation does not exist');
      }

      if (invitation.status === 'ACCEPTED') {
        throw new AppError(
          409,
          'INVITATION_ALREADY_ACCEPTED',
          'This invitation has already been accepted',
        );
      }

      if (invitation.status === 'REVOKED') {
        throw new AppError(409, 'INVITATION_REVOKED', 'This invitation was revoked');
      }

      const revoked = await client.$transaction(async (tx) => {
        await lockActiveWorkspace(tx, access.workspace.id);
        const result = await tx.invitation.updateMany({
          where: {
            id: invitation.id,
            workspaceId: access.workspace.id,
            status: { in: ['PENDING', 'DECLINED', 'EXPIRED'] },
          },
          data: { status: 'REVOKED', revokedAt: new Date(), pendingKey: null },
        });
        if (!result.count) {
          throw new AppError(
            409,
            'INVITATION_STATE_CHANGED',
            'The invitation state changed; refresh and try again',
          );
        }
        const changed = await tx.invitation.findUniqueOrThrow({ where: { id: invitation.id } });

        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.InvitationRevoked,
          targetType: 'Invitation',
          targetId: changed.id,
          metadata: { email: changed.email },
        });

        return changed;
      });

      const stored = await client.invitation.findUnique({
        where: { id: revoked.id },
        include: summaryInclude,
      });

      if (!stored) {
        throw new AppError(500, 'INVITATION_NOT_STORED', 'The invitation could not be stored');
      }

      return toSummary(stored);
    },

    async preview(token: string): Promise<InvitationPreview> {
      const invitation = await client.invitation.findUnique({
        where: { tokenHash: hashSecret(token) },
        include: {
          workspace: {
            select: { id: true, name: true, slug: true, status: true, deletedAt: true },
          },
          invitedBy: { select: { id: true, name: true } },
          team: { select: { id: true, name: true, status: true, deletedAt: true } },
        },
      });

      if (!invitation) {
        throw new AppError(404, 'INVITATION_NOT_FOUND', 'This invitation link is not valid');
      }

      if (invitation.type === 'TEAM' && (!invitation.team || invitation.team.status !== 'ACTIVE' || invitation.team.deletedAt)) {
        throw new AppError(410, 'TEAM_INVITATION_UNAVAILABLE', 'This team invitation is no longer available');
      }

      if (invitation.workspace.status !== 'ACTIVE' || invitation.workspace.deletedAt) {
        throw new AppError(
          410,
          'INVITATION_WORKSPACE_UNAVAILABLE',
          'This workspace is no longer available',
        );
      }

      if (invitation.status === 'EXPIRED') {
        throw new AppError(410, 'INVITATION_EXPIRED', 'This invitation link has expired');
      }

      if (invitation.status === 'PENDING' && invitation.expiresAt.getTime() <= Date.now()) {
        await client.invitation.updateMany({
          where: { id: invitation.id, status: 'PENDING', expiresAt: { lte: new Date() } },
          data: { status: 'EXPIRED', pendingKey: null },
        });

        throw new AppError(410, 'INVITATION_EXPIRED', 'This invitation link has expired');
      }

      if (invitation.status === 'REVOKED') {
        throw new AppError(410, 'INVITATION_REVOKED', 'This invitation was revoked');
      }

      if (invitation.status === 'ACCEPTED') {
        throw new AppError(
          410,
          'INVITATION_ALREADY_ACCEPTED',
          'This invitation has already been accepted',
        );
      }

      return {
        workspace: invitation.workspace,
        invitedBy: invitation.invitedBy,
        role: invitation.role,
        organizationRole: invitation.organizationRole,
        ...(invitation.team ? { team: { id: invitation.team.id, name: invitation.team.name } } : {}),
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        maskedEmail: maskInvitationEmail(invitation.email),
        boundToAccount: Boolean(invitation.forUserId),
      };
    },

    /**
     * Verifies the invitation for the signed-in account without changing it.
     *
     * The public preview cannot answer whether the current account may act on
     * the invitation, because it has no viewer. This method does, and it
     * deliberately reports terminal states instead of throwing so the
     * frontend can render "already accepted", "revoked", "expired" or "wrong
     * account" without guessing from an error.
     */
    async verify(input): Promise<InvitationVerification> {
      const invitation = await client.invitation.findUnique({
        where: { tokenHash: hashSecret(input.token) },
        include: {
          workspace: {
            select: { id: true, name: true, slug: true, status: true, deletedAt: true },
          },
          invitedBy: { select: { id: true, name: true } },
          team: { select: { id: true, name: true, status: true, deletedAt: true } },
        },
      });

      if (!invitation) {
        throw new AppError(404, 'INVITATION_NOT_FOUND', 'This invitation link is not valid');
      }

      const user = await client.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true, deletedAt: true },
      });

      if (!user || user.deletedAt) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      let status = invitation.status;

      // Keep the stored state honest, exactly like the public preview does.
      if (status === 'PENDING' && invitation.expiresAt.getTime() <= Date.now()) {
        await client.invitation.updateMany({
          where: { id: invitation.id, status: 'PENDING', expiresAt: { lte: new Date() } },
          data: { status: 'EXPIRED', pendingKey: null },
        });
        status = 'EXPIRED';
      }

      const workspaceAvailable =
        invitation.workspace.status === 'ACTIVE' && !invitation.workspace.deletedAt;
      const teamAvailable = invitation.type !== 'TEAM' || Boolean(
        invitation.team && invitation.team.status === 'ACTIVE' && !invitation.team.deletedAt,
      );
      const emailMatches = isInvitationRecipient(invitation, user);

      // Only ask about membership when the viewer is the recipient. A
      // stranger must not learn anything about the recipient's memberships.
      const membership = emailMatches
        ? await client.workspaceMembership.findUnique({
            where: {
              workspaceId_userId: { workspaceId: invitation.workspaceId, userId: user.id },
            },
            select: { role: true, status: true },
          })
        : null;
      const alreadyMember = membership?.status === 'ACTIVE';
      const teamMembership = emailMatches && invitation.type === 'TEAM' && invitation.teamId
        ? await client.teamMembership.findUnique({
            where: { teamId_userId: { teamId: invitation.teamId, userId: user.id } },
            select: { id: true },
          })
        : null;
      const alreadyTeamMember = Boolean(teamMembership);

      let reason: InvitationVerificationReason | null = null;

      if (!emailMatches) {
        reason = 'EMAIL_MISMATCH';
      } else if (!workspaceAvailable) {
        reason = 'WORKSPACE_UNAVAILABLE';
      } else if (!teamAvailable) {
        reason = 'TEAM_UNAVAILABLE';
      } else if (status === 'ACCEPTED') {
        reason = 'ALREADY_ACCEPTED';
      } else if (status === 'DECLINED') {
        reason = 'DECLINED';
      } else if (status === 'REVOKED') {
        reason = 'REVOKED';
      } else if (status === 'EXPIRED') {
        reason = 'EXPIRED';
      } else if (invitation.type === 'TEAM' && !alreadyMember) {
        reason = 'WORKSPACE_MEMBERSHIP_REQUIRED';
      } else if (invitation.type === 'TEAM' && alreadyTeamMember) {
        reason = 'ALREADY_A_TEAM_MEMBER';
      } else if (invitation.type !== 'TEAM' && alreadyMember) {
        reason = 'ALREADY_A_MEMBER';
      }

      const actionable = emailMatches && workspaceAvailable && teamAvailable && status === 'PENDING' &&
        (invitation.type === 'TEAM' ? alreadyMember && !alreadyTeamMember : !alreadyMember);
      const canDecline = emailMatches && workspaceAvailable && teamAvailable && status === 'PENDING';

      return {
        workspace: {
          id: invitation.workspace.id,
          name: invitation.workspace.name,
          slug: invitation.workspace.slug,
        },
        invitedBy: invitation.invitedBy,
        role: invitation.role,
        organizationRole: invitation.organizationRole,
        ...(invitation.team ? { team: { id: invitation.team.id, name: invitation.team.name } } : {}),
        status,
        expiresAt: invitation.expiresAt,
        maskedEmail: maskInvitationEmail(invitation.email),
        boundToAccount: Boolean(invitation.forUserId),
        viewer: {
          userId: user.id,
          email: user.email,
          emailMatches,
          alreadyMember,
          membershipRole: membership?.role ?? null,
          ...(invitation.type === 'TEAM' ? { alreadyTeamMember } : {}),
          canAccept: actionable,
          canDecline,
          reason,
        },
      };
    },

    async accept(input, ctx): Promise<InvitationSummary> {
      const invitation = await client.invitation.findUnique({
        where: { tokenHash: hashSecret(input.token) },
        include: {
          workspace: { select: { id: true, name: true } },
          invitedBy: { select: { id: true, name: true } },
          team: { select: { id: true, name: true, status: true, deletedAt: true } },
        },
      });

      if (!invitation) {
        throw new AppError(404, 'INVITATION_NOT_FOUND', 'This invitation link is not valid');
      }

      if (invitation.status === 'ACCEPTED') {
        throw new AppError(
          409,
          'INVITATION_ALREADY_ACCEPTED',
          'This invitation has already been accepted',
        );
      }

      if (invitation.status === 'REVOKED') {
        throw new AppError(409, 'INVITATION_REVOKED', 'This invitation was revoked');
      }

      const expired =
        invitation.status === 'EXPIRED' || invitation.expiresAt.getTime() <= Date.now();

      if (expired) {
        if (invitation.status !== 'EXPIRED') {
          await client.invitation.updateMany({
            where: { id: invitation.id, status: 'PENDING', expiresAt: { lte: new Date() } },
            data: { status: 'EXPIRED', pendingKey: null },
          });
        }

        throw new AppError(410, 'INVITATION_EXPIRED', 'This invitation link has expired');
      }

      // Only a pending invitation may grant a membership. The status guard
      // inside the transaction keeps this race-safe, but rejecting here makes
      // sure no membership is ever attempted for a spent invitation.
      if (invitation.status !== 'PENDING') {
        throw new AppError(
          409,
          'INVITATION_NOT_PENDING',
          'This invitation can no longer be accepted',
        );
      }

      const user = await client.user.findUnique({
        where: { id: input.userId },
        select: { id: true, name: true, email: true, status: true, deletedAt: true },
      });

      if (!user || user.deletedAt) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      // The invitation is meant for one recipient. A bound invitation belongs
      // to one account, an unbound one to the address it was sent to.
      if (!isInvitationRecipient(invitation, user)) {
        throw new AppError(
          403,
          'INVITATION_FOR_OTHER_USER',
          'This invitation was sent to a different account',
        );
      }

      let joined = false;
      if (invitation.type === 'TEAM') {
        if (!invitation.teamId || !invitation.team || invitation.team.status !== 'ACTIVE' || invitation.team.deletedAt) {
          throw new AppError(410, 'TEAM_INVITATION_UNAVAILABLE', 'This team invitation is no longer available');
        }
        const acceptedTeamInvitation = await client.$transaction(async (tx) => {
          await lockActiveWorkspace(tx, invitation.workspaceId);
          const membership = await tx.workspaceMembership.findUnique({
            where: {
              workspaceId_userId: { workspaceId: invitation.workspaceId, userId: user.id },
            },
            select: { status: true },
          });
          if (membership?.status !== 'ACTIVE') {
            throw new AppError(403, 'TEAM_INVITATION_REQUIRES_WORKSPACE_MEMBER', 'An active workspace membership is required');
          }
          const team = await tx.team.findFirst({
            where: {
              id: invitation.teamId!,
              workspaceId: invitation.workspaceId,
              status: 'ACTIVE',
              deletedAt: null,
            },
            select: { id: true, name: true },
          });
          if (!team) {
            throw new AppError(410, 'TEAM_INVITATION_UNAVAILABLE', 'This team invitation is no longer available');
          }
          const alreadyMember = await tx.teamMembership.findUnique({
            where: { teamId_userId: { teamId: team.id, userId: user.id } },
            select: { id: true },
          });
          if (alreadyMember) {
            throw new AppError(409, 'ALREADY_A_TEAM_MEMBER', 'This account is already a member of the team');
          }
          const now = new Date();
          const updated = await tx.invitation.updateMany({
            where: {
              id: invitation.id,
              workspaceId: invitation.workspaceId,
              teamId: team.id,
              type: 'TEAM',
              tokenHash: hashSecret(input.token),
              status: 'PENDING',
              expiresAt: { gt: now },
            },
            data: { status: 'ACCEPTED', acceptedAt: now, acceptedById: user.id, pendingKey: null },
          });
          if (!updated.count) {
            throw new AppError(409, 'INVITATION_ALREADY_ACCEPTED', 'This invitation can no longer be accepted');
          }
          await tx.teamMembership.create({ data: { teamId: team.id, userId: user.id, role: 'MEMBER' } });
          await recordAuditEvent(tx, {
            workspaceId: invitation.workspaceId,
            actorId: user.id,
            action: WorkspaceAuditAction.InvitationAccepted,
            targetType: 'Invitation',
            targetId: invitation.id,
            metadata: { type: 'TEAM', teamId: team.id, userId: user.id },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          if (invitation.invitedById !== user.id) {
            await createNotification(tx, {
              userId: invitation.invitedById,
              type: 'INVITATION_ACCEPTED',
              title: `${user.name} joined ${team.name}`,
              data: { workspaceId: invitation.workspaceId, teamId: team.id, userId: user.id },
            });
          }
          return tx.invitation.findUnique({ where: { id: invitation.id }, include: summaryInclude });
        });
        if (!acceptedTeamInvitation) {
          throw new AppError(500, 'INVITATION_NOT_STORED', 'The invitation could not be stored');
        }
        return toSummary(acceptedTeamInvitation);
      }

      const accepted = await client.$transaction(async (tx) => {
        await lockActiveWorkspace(tx, invitation.workspaceId);
        const existing = await tx.workspaceMembership.findUnique({
          where: {
            workspaceId_userId: { workspaceId: invitation.workspaceId, userId: user.id },
          },
        });

        // An account that already belongs to the workspace keeps its role.
        if (!existing) {
          joined = true;
          await assertWorkspaceSeatCapacity(tx, {
            workspaceId: invitation.workspaceId,
            userId: user.id,
          });
          await tx.workspaceMembership.create({
            data: {
              workspaceId: invitation.workspaceId,
              userId: user.id,
              role: invitation.role,
              organizationRole: invitation.organizationRole,
            },
          });
        }

        // The status guard makes the acceptance single use, even when two
        // requests arrive with the same token at the same time.
        const updated = await tx.invitation.updateMany({
          where: {
            id: invitation.id,
            workspaceId: invitation.workspaceId,
            tokenHash: hashSecret(input.token),
            status: 'PENDING',
            expiresAt: { gt: new Date() },
          },
          data: {
            status: 'ACCEPTED',
            acceptedAt: new Date(),
            acceptedById: user.id,
            pendingKey: null,
          },
        });

        if (updated.count === 0) {
          throw new AppError(
            409,
            'INVITATION_ALREADY_ACCEPTED',
            'This invitation has already been accepted',
          );
        }

        await recordAuditEvent(tx, {
          workspaceId: invitation.workspaceId,
          actorId: user.id,
          action: WorkspaceAuditAction.InvitationAccepted,
          targetType: 'Invitation',
          targetId: invitation.id,
          metadata: {
            userId: user.id,
            email: invitation.email,
            role: invitation.role,
            alreadyMember: Boolean(existing),
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        if (invitation.invitedById !== user.id) {
          await createNotification(tx, {
            userId: invitation.invitedById,
            type: 'INVITATION_ACCEPTED',
            title: `${user.name} joined ${invitation.workspace.name}`,
            body: `The invitation you sent to ${maskInvitationEmail(invitation.email)} was accepted.`,
            link: `${config.frontendUrl.replace(/\/+$/, '')}/workspaces/${invitation.workspaceId}`,
            data: { workspaceId: invitation.workspaceId, userId: user.id, role: invitation.role },
          });
        }

        return tx.invitation.findUnique({
          where: { id: invitation.id },
          include: summaryInclude,
        });
      });

      if (!accepted) {
        throw new AppError(500, 'INVITATION_NOT_STORED', 'The invitation could not be stored');
      }

      if (joined) {
        await enqueueAutomationRunsSafely({
          workspaceId: invitation.workspaceId,
          trigger: 'EVENT_MEMBER_JOINED',
          eventKey: `member.joined:invitation:${invitation.id}`,
          payload: {
            workspaceId: invitation.workspaceId,
            userId: user.id,
            role: invitation.role,
            organizationRole: invitation.organizationRole ?? null,
            source: 'invitation',
          },
        });
      }

      return toSummary(accepted);
    },

    async decline(input, ctx): Promise<InvitationSummary> {
      const invitation = await client.invitation.findUnique({
        where: { tokenHash: hashSecret(input.token) },
        include: {
          workspace: { select: { id: true, name: true } },
          invitedBy: { select: { id: true, name: true } },
        },
      });

      if (!invitation) {
        throw new AppError(404, 'INVITATION_NOT_FOUND', 'This invitation link is not valid');
      }

      const user = await client.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true, deletedAt: true },
      });

      if (!user || user.deletedAt) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      if (!isInvitationRecipient(invitation, user)) {
        throw new AppError(
          403,
          'INVITATION_FOR_OTHER_USER',
          'This invitation was sent to a different account',
        );
      }

      if (invitation.status === 'PENDING' && invitation.expiresAt.getTime() <= Date.now()) {
        await client.invitation.updateMany({
          where: { id: invitation.id, status: 'PENDING' },
          data: { status: 'EXPIRED', pendingKey: null },
        });
        throw new AppError(410, 'INVITATION_EXPIRED', 'This invitation link has expired');
      }

      if (invitation.status !== 'PENDING') {
        throw new AppError(
          409,
          invitation.status === 'DECLINED' ? 'INVITATION_DECLINED' : 'INVITATION_NOT_PENDING',
          'This invitation can no longer be declined',
        );
      }

      const declined = await client.$transaction(async (tx) => {
        await lockActiveWorkspace(tx, invitation.workspaceId);
        const now = new Date();
        const updated = await tx.invitation.updateMany({
          where: {
            id: invitation.id,
            tokenHash: hashSecret(input.token),
            status: 'PENDING',
            expiresAt: { gt: now },
          },
          data: { status: 'DECLINED', declinedAt: now, pendingKey: null },
        });

        if (updated.count === 0) {
          throw new AppError(
            409,
            'INVITATION_NOT_PENDING',
            'This invitation can no longer be declined',
          );
        }

        await recordAuditEvent(tx, {
          workspaceId: invitation.workspaceId,
          actorId: user.id,
          action: WorkspaceAuditAction.InvitationDeclined,
          targetType: 'Invitation',
          targetId: invitation.id,
          metadata: { userId: user.id },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return tx.invitation.findUnique({
          where: { id: invitation.id },
          include: summaryInclude,
        });
      });

      if (!declined) {
        throw new AppError(500, 'INVITATION_NOT_STORED', 'The invitation could not be stored');
      }
      return toSummary(declined);
    },

    async listMine(userId: string): Promise<InvitationSummary[]> {
      const user = await client.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true },
      });

      if (!user) {
        return [];
      }

      await expireStale();

      const invitations = await client.invitation.findMany({
        where: {
          OR: [{ forUserId: user.id }, { email: user.email }],
        },
        include: summaryInclude,
        orderBy: { createdAt: 'desc' },
      });

      return invitations.map(toSummary);
    },
  };
}
