import type {
  PrismaClient,
  User,
  Workspace,
  WorkspaceMembership,
  WorkspaceRole,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import type { RequestContext } from '../auth/auth.types';
import { recordAuditEvent, WorkspaceAuditAction } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { AppError } from '../../utils/errors';
import {
  assertMayManageMember,
  assertOwnershipSafe,
  requireWorkspaceAccess,
  WorkspaceCapability,
} from './authorization';
import type {
  AddMemberInput,
  TransferOwnershipInput,
  UpdateMemberRoleInput,
  UpdateWorkspaceInput,
} from './workspace.schemas';
import type { WorkspaceMember, WorkspaceSummary } from './workspace.types';

/**
 * Workspaces and their members.
 *
 * A workspace is the boundary of the product: teams, projects, tasks, files
 * and messages all live inside one. The service owns the rules of that
 * boundary, the routes only translate HTTP into calls.
 *
 * Every read and every change is checked against the membership of the
 * caller in the database. The role that a client sends in a request is never
 * trusted, and a workspace that the caller does not belong to is never
 * described.
 */

export interface WorkspaceService {
  create(
    input: { userId: string; name: string; description?: string | null; slug?: string },
    ctx: RequestContext,
  ): Promise<WorkspaceSummary>;
  list(userId: string): Promise<WorkspaceSummary[]>;
  get(input: { userId: string; workspaceId: string }): Promise<WorkspaceSummary>;
  update(
    input: { userId: string; workspaceId: string } & UpdateWorkspaceInput,
    ctx: RequestContext,
  ): Promise<WorkspaceSummary>;
  archive(
    input: { userId: string; workspaceId: string },
    ctx: RequestContext,
  ): Promise<WorkspaceSummary>;
  remove(input: { userId: string; workspaceId: string }, ctx: RequestContext): Promise<void>;
  switchTo(input: { userId: string; workspaceId: string }): Promise<WorkspaceSummary>;
  listMembers(input: { userId: string; workspaceId: string }): Promise<WorkspaceMember[]>;
  addMember(
    input: { userId: string; workspaceId: string } & AddMemberInput,
    ctx: RequestContext,
  ): Promise<WorkspaceMember>;
  updateMemberRole(
    input: { userId: string; workspaceId: string; targetUserId: string } & UpdateMemberRoleInput,
    ctx: RequestContext,
  ): Promise<WorkspaceMember>;
  removeMember(
    input: { userId: string; workspaceId: string; targetUserId: string },
    ctx: RequestContext,
  ): Promise<void>;
  transferOwnership(
    input: {
      userId: string;
      workspaceId: string;
      newOwnerId: string;
    } & TransferOwnershipInput,
    ctx: RequestContext,
  ): Promise<WorkspaceSummary>;
}

interface WorkspaceCounts {
  members: number;
  projects: number;
  teams: number;
}

export function slugifyWorkspaceName(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      // The combining marks of a decomposed letter are dropped, so "Ünïcode"
      // becomes "unicode" instead of "u-ni-code".
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/g, '')
  );
}

function toSummary(
  workspace: Workspace,
  role: WorkspaceRole,
  counts: WorkspaceCounts,
): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    description: workspace.description,
    status: workspace.status,
    ownerId: workspace.ownerId,
    role,
    memberCount: counts.members,
    projectCount: counts.projects,
    teamCount: counts.teams,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

function toMember(
  membership: WorkspaceMembership & { user: Pick<User, 'id' | 'name' | 'email' | 'status'> },
  ownerId: string,
): WorkspaceMember {
  return {
    id: membership.id,
    userId: membership.user.id,
    name: membership.user.name,
    email: membership.user.email,
    status: membership.user.status,
    role: membership.role,
    joinedAt: membership.joinedAt,
    owner: membership.user.id === ownerId,
  };
}

export function createWorkspaceService(config: AppConfig, prisma?: PrismaClient): WorkspaceService {
  const client = prisma ?? getPrismaClient();

  async function counts(workspaceId: string): Promise<WorkspaceCounts> {
    const counted = await client.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        _count: { select: { members: true, projects: true, teams: true } },
      },
    });

    return {
      members: counted?._count.members ?? 0,
      projects: counted?._count.projects ?? 0,
      teams: counted?._count.teams ?? 0,
    };
  }

  /**
   * Builds a slug that is not taken yet.
   *
   * The slug is part of the public address of a workspace, so it stays
   * readable. A name that collides with an existing slug gets a short
   * suffix, and the result is checked against the database.
   */
  async function uniqueSlug(name: string, requested?: string): Promise<string> {
    const base = slugifyWorkspaceName(requested ?? name) || 'workspace';

    const taken = await client.workspace.findUnique({
      where: { slug: base },
      select: { id: true },
    });

    if (!taken) {
      return base;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = `${base}-${randomBytes(3).toString('hex')}`;
      const exists = await client.workspace.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });

      if (!exists) {
        return candidate;
      }
    }

    return `${base}-${randomBytes(8).toString('hex')}`;
  }

  function workspaceLink(workspaceId: string): string {
    return `${config.frontendUrl.replace(/\/+$/, '')}/workspaces/${workspaceId}`;
  }

  return {
    async create(input, ctx): Promise<WorkspaceSummary> {
      const slug = await uniqueSlug(input.name, input.slug);

      const workspace = await client.$transaction(async (tx) => {
        const created = await tx.workspace.create({
          data: {
            name: input.name,
            slug,
            ...(input.description !== undefined ? { description: input.description } : {}),
            ownerId: input.userId,
          },
        });

        // The creator is the owner of the workspace from the start.
        await tx.workspaceMembership.create({
          data: {
            workspaceId: created.id,
            userId: input.userId,
            role: 'OWNER',
          },
        });

        await recordAuditEvent(tx, {
          workspaceId: created.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.WorkspaceCreated,
          targetType: 'Workspace',
          targetId: created.id,
          metadata: { name: created.name, slug: created.slug },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return created;
      });

      return toSummary(workspace, 'OWNER', { members: 1, projects: 0, teams: 0 });
    },

    async list(userId: string): Promise<WorkspaceSummary[]> {
      const memberships = await client.workspaceMembership.findMany({
        where: { userId },
        include: {
          workspace: {
            include: {
              _count: { select: { members: true, projects: true, teams: true } },
            },
          },
        },
        orderBy: { joinedAt: 'asc' },
      });

      return memberships
        .filter((membership) => !membership.workspace.deletedAt)
        .map((membership) =>
          toSummary(membership.workspace, membership.role, {
            members: membership.workspace._count.members,
            projects: membership.workspace._count.projects,
            teams: membership.workspace._count.teams,
          }),
        );
    },

    async get(input): Promise<WorkspaceSummary> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      return toSummary(access.workspace, access.membership.role, await counts(access.workspace.id));
    },

    async update(input, ctx): Promise<WorkspaceSummary> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.UpdateWorkspace,
      });

      const updated = await client.$transaction(async (tx) => {
        const changed = await tx.workspace.update({
          where: { id: access.workspace.id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
          },
        });

        await recordAuditEvent(tx, {
          workspaceId: changed.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.WorkspaceUpdated,
          targetType: 'Workspace',
          targetId: changed.id,
          metadata: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return changed;
      });

      return toSummary(updated, access.membership.role, await counts(updated.id));
    },

    async archive(input, ctx): Promise<WorkspaceSummary> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ArchiveWorkspace,
      });

      const archived = await client.$transaction(async (tx) => {
        const changed = await tx.workspace.update({
          where: { id: access.workspace.id },
          data: { status: 'ARCHIVED' },
        });

        await recordAuditEvent(tx, {
          workspaceId: changed.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.WorkspaceArchived,
          targetType: 'Workspace',
          targetId: changed.id,
          metadata: { name: changed.name },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return changed;
      });

      return toSummary(archived, access.membership.role, await counts(archived.id));
    },

    async remove(input, ctx): Promise<void> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.DeleteWorkspace,
      });

      await client.$transaction(async (tx) => {
        // The workspace is removed softly, so the records that point at it
        // keep their history.
        await tx.workspace.update({
          where: { id: access.workspace.id },
          data: { deletedAt: new Date(), status: 'ARCHIVED' },
        });

        // An invitation of a workspace that no longer exists can only
        // confuse the person who received it.
        await tx.invitation.updateMany({
          where: { workspaceId: access.workspace.id, status: 'PENDING' },
          data: { status: 'REVOKED', revokedAt: new Date(), pendingKey: null },
        });

        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.WorkspaceDeleted,
          targetType: 'Workspace',
          targetId: access.workspace.id,
          metadata: { name: access.workspace.name },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      });
    },

    async switchTo(input): Promise<WorkspaceSummary> {
      // Switching a workspace is a read of the membership. It fails with the
      // same error as any other access, so the frontend can send the user to
      // the invitations page.
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      return toSummary(access.workspace, access.membership.role, await counts(access.workspace.id));
    },

    async listMembers(input): Promise<WorkspaceMember[]> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewMembers,
      });

      const memberships = await client.workspaceMembership.findMany({
        where: { workspaceId: access.workspace.id },
        include: { user: { select: { id: true, name: true, email: true, status: true } } },
        orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
      });

      return memberships.map((membership) => toMember(membership, access.workspace.ownerId));
    },

    async addMember(input, ctx): Promise<WorkspaceMember> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ManageMembers,
      });

      const user = await client.user.findUnique({
        where: { email: input.email },
        select: { id: true, name: true, email: true, status: true, deletedAt: true },
      });

      if (!user || user.deletedAt) {
        throw new AppError(
          404,
          'USER_NOT_FOUND',
          'No account uses this email address. Send an invitation instead.',
        );
      }

      const existing = await client.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId: access.workspace.id, userId: user.id } },
      });

      if (existing) {
        throw new AppError(
          409,
          'ALREADY_A_MEMBER',
          'This account is already a member of the workspace',
        );
      }

      const membership = await client.$transaction(async (tx) => {
        const created = await tx.workspaceMembership.create({
          data: {
            workspaceId: access.workspace.id,
            userId: user.id,
            role: input.role as WorkspaceRole,
          },
          include: { user: { select: { id: true, name: true, email: true, status: true } } },
        });

        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.MemberAdded,
          targetType: 'WorkspaceMembership',
          targetId: created.id,
          metadata: { userId: user.id, email: user.email, role: input.role },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        await createNotification(tx, {
          userId: user.id,
          type: 'MEMBERSHIP_CHANGED',
          title: `You joined ${access.workspace.name}`,
          body: `Your role in ${access.workspace.name} is ${input.role.toLowerCase().replace('_', ' ')}.`,
          link: workspaceLink(access.workspace.id),
          data: { workspaceId: access.workspace.id, role: input.role },
        });

        return created;
      });

      return toMember(membership, access.workspace.ownerId);
    },

    async updateMemberRole(input, ctx): Promise<WorkspaceMember> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ManageMembers,
      });

      const target = await client.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: access.workspace.id, userId: input.targetUserId },
        },
        include: { user: { select: { id: true, name: true, email: true, status: true } } },
      });

      if (!target) {
        throw new AppError(
          404,
          'MEMBER_NOT_FOUND',
          'This account is not a member of the workspace',
        );
      }

      assertMayManageMember({
        actorRole: access.membership.role,
        targetRole: target.role,
        targetIsOwner: target.user.id === access.workspace.ownerId,
      });

      const updated = await client.$transaction(async (tx) => {
        const changed = await tx.workspaceMembership.update({
          where: { id: target.id },
          data: { role: input.role as WorkspaceRole },
          include: { user: { select: { id: true, name: true, email: true, status: true } } },
        });

        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.MemberRoleChanged,
          targetType: 'WorkspaceMembership',
          targetId: changed.id,
          metadata: {
            userId: changed.user.id,
            previousRole: target.role,
            role: input.role,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        await createNotification(tx, {
          userId: changed.user.id,
          type: 'MEMBERSHIP_CHANGED',
          title: `Your role in ${access.workspace.name} changed`,
          body: `Your role is now ${input.role.toLowerCase().replace('_', ' ')}.`,
          link: workspaceLink(access.workspace.id),
          data: { workspaceId: access.workspace.id, role: input.role },
        });

        return changed;
      });

      return toMember(updated, access.workspace.ownerId);
    },

    async removeMember(input, ctx): Promise<void> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ManageMembers,
      });

      const target = await client.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: access.workspace.id, userId: input.targetUserId },
        },
        include: { user: { select: { id: true, name: true, email: true, status: true } } },
      });

      if (!target) {
        throw new AppError(
          404,
          'MEMBER_NOT_FOUND',
          'This account is not a member of the workspace',
        );
      }

      assertMayManageMember({
        actorRole: access.membership.role,
        targetRole: target.role,
        targetIsOwner: target.user.id === access.workspace.ownerId,
      });

      // Prevent the owner from removing themselves (which would leave the
      // workspace permanently ownerless).
      assertOwnershipSafe({
        actorId: input.userId,
        targetUserId: input.targetUserId,
        targetRole: target.role,
        workspaceOwnerId: access.workspace.ownerId,
      });

      await client.$transaction(async (tx) => {
        await tx.workspaceMembership.delete({ where: { id: target.id } });

        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.MemberRemoved,
          targetType: 'WorkspaceMembership',
          targetId: target.id,
          metadata: { userId: target.user.id, email: target.user.email, role: target.role },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        await createNotification(tx, {
          userId: target.user.id,
          type: 'MEMBERSHIP_CHANGED',
          title: `You left ${access.workspace.name}`,
          body: 'Your access to this workspace was removed.',
          link: workspaceLink(access.workspace.id),
          data: { workspaceId: access.workspace.id },
        });
      });
    },

    async transferOwnership(input, ctx): Promise<WorkspaceSummary> {
      // Only the current owner may initiate a transfer.
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.TransferOwnership,
      });

      if (input.newOwnerId === input.userId) {
        throw new AppError(400, 'TRANSFER_TO_SELF', 'You cannot transfer ownership to yourself');
      }

      // The new owner must already be a member of the workspace.
      const newOwnerMembership = await client.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: access.workspace.id, userId: input.newOwnerId },
        },
        include: { user: { select: { id: true, name: true, email: true } } },
      });

      if (!newOwnerMembership) {
        throw new AppError(
          404,
          'MEMBER_NOT_FOUND',
          'The new owner must already be a member of the workspace',
        );
      }

      const updatedWorkspace = await client.$transaction(async (tx) => {
        // Promote the new owner.
        await tx.workspaceMembership.update({
          where: { id: newOwnerMembership.id },
          data: { role: 'OWNER' },
        });

        // Demote the previous owner to the requested role.
        await tx.workspaceMembership.update({
          where: {
            workspaceId_userId: { workspaceId: access.workspace.id, userId: input.userId },
          },
          data: { role: input.newOwnerRole as WorkspaceRole },
        });

        // Transfer the authoritative owner column on the workspace itself.
        const changed = await tx.workspace.update({
          where: { id: access.workspace.id },
          data: { ownerId: input.newOwnerId },
        });

        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.OwnershipTransferred,
          targetType: 'Workspace',
          targetId: access.workspace.id,
          metadata: {
            previousOwnerId: input.userId,
            newOwnerId: input.newOwnerId,
            previousOwnerNewRole: input.newOwnerRole,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        await createNotification(tx, {
          userId: input.newOwnerId,
          type: 'MEMBERSHIP_CHANGED',
          title: `You are now the owner of ${access.workspace.name}`,
          body: `Ownership of ${access.workspace.name} was transferred to you.`,
          link: workspaceLink(access.workspace.id),
          data: { workspaceId: access.workspace.id, role: 'OWNER' },
        });

        return changed;
      });

      return toSummary(
        updatedWorkspace,
        // The caller is no longer the owner after the transfer.
        input.newOwnerRole as WorkspaceRole,
        await counts(updatedWorkspace.id),
      );
    },
  };
}
