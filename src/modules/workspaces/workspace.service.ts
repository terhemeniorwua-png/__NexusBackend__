import type {
  Prisma,
  PrismaClient,
  User,
  Workspace,
  WorkspaceMembership,
  WorkspaceRole,
  WorkspaceType,
  WorkspaceVisibility,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import type { RequestContext } from '../auth/auth.types';
import { recordAuditEvent, WorkspaceAuditAction } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { createTaskAssignmentNotifier } from '../../services/task-assignment-notifier';
import { AppError } from '../../utils/errors';
import {
  assertMayManageMember,
  assertMayAssignRole,
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
import { reassignOpenTasksBeforeMemberRemoval } from './task-reassignment';

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
    input: {
      userId: string;
      name: string;
      description?: string | null;
      slug?: string;
      type: WorkspaceType;
      visibility: WorkspaceVisibility;
    },
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
  restore(
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
    input: {
      userId: string;
      workspaceId: string;
      targetUserId: string;
      reassignTasksToUserId?: string | undefined;
    },
    ctx: RequestContext,
  ): Promise<void>;
  suspendMember(
    input: { userId: string; workspaceId: string; targetUserId: string },
    ctx: RequestContext,
  ): Promise<WorkspaceMember>;
  restoreMember(
    input: { userId: string; workspaceId: string; targetUserId: string },
    ctx: RequestContext,
  ): Promise<WorkspaceMember>;
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
    type: workspace.type,
    isPersonal: workspace.isPersonal,
    visibility: workspace.visibility,
    status: workspace.status,
    ownerId: workspace.ownerId,
    role,
    joinCodeEnabled: Boolean(workspace.joinCodeHash),
    memberCount: counts.members,
    projectCount: counts.projects,
    teamCount: counts.teams,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

function assertVisibilityAllowed(type: WorkspaceType, visibility: WorkspaceVisibility): void {
  if (type === 'INDIVIDUAL' && visibility === 'PUBLIC') {
    throw new AppError(
      400,
      'INDIVIDUAL_WORKSPACE_NOT_DISCOVERABLE',
      'A personal workspace cannot be publicly discoverable',
    );
  }
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
    membershipStatus: membership.status,
    joinedAt: membership.joinedAt,
    owner: membership.user.id === ownerId,
  };
}

export function createWorkspaceService(config: AppConfig, prisma?: PrismaClient): WorkspaceService {
  const client = prisma ?? getPrismaClient();
  const taskAssignmentNotifier = createTaskAssignmentNotifier(config, { prisma: client });

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

  async function lockActiveWorkspaceAccount(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const [account] = await tx.$queryRaw<Array<{ status: string; deletedAt: Date | null }>>`
      SELECT "status"::text AS "status", "deletedAt"
      FROM "User"
      WHERE "id" = ${userId}
      FOR KEY SHARE
    `;

    if (
      !account ||
      account.deletedAt ||
      account.status === 'DEACTIVATED' ||
      account.status === 'PENDING_DELETION'
    ) {
      throw new AppError(403, 'ACCOUNT_DEACTIVATED', 'This account cannot own a workspace');
    }

    if (account.status === 'SUSPENDED') {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended');
    }

    if (account.status === 'PENDING_VERIFICATION') {
      throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address to continue');
    }
  }

  return {
    async create(input, ctx): Promise<WorkspaceSummary> {
      assertVisibilityAllowed(input.type, input.visibility);

      const slug = await uniqueSlug(input.name, input.slug);

      const workspace = await client.$transaction(async (tx) => {
        // Serialize workspace creation with account deletion. The owner row
        // lock is held until the workspace and its owner membership commit.
        await lockActiveWorkspaceAccount(tx, input.userId);

        const created = await tx.workspace.create({
          data: {
            name: input.name,
            slug,
            type: input.type,
            visibility: input.visibility,
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
          metadata: {
            name: created.name,
            slug: created.slug,
            type: created.type,
            visibility: created.visibility,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return created;
      });

      return toSummary(workspace, 'OWNER', { members: 1, projects: 0, teams: 0 });
    },

    async list(userId: string): Promise<WorkspaceSummary[]> {
      const memberships = await client.workspaceMembership.findMany({
        where: { userId, status: 'ACTIVE' },
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

      if (input.visibility !== undefined) {
        assertVisibilityAllowed(access.workspace.type, input.visibility);
      }

      const updated = await client.$transaction(async (tx) => {
        const changed = await tx.workspace.update({
          where: { id: access.workspace.id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
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
            ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
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

      if (access.workspace.isPersonal) {
        throw new AppError(
          409,
          'PERSONAL_WORKSPACE_LIFECYCLE_MANAGED',
          'A personal workspace can only be archived through account deletion',
        );
      }

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

    async restore(input, ctx): Promise<WorkspaceSummary> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ArchiveWorkspace,
      });

      const restored = await client.$transaction(async (tx) => {
        const changed = await tx.workspace.updateMany({
          where: {
            id: access.workspace.id,
            status: 'ARCHIVED',
            deletedAt: null,
          },
          data: { status: 'ACTIVE' },
        });

        if (changed.count === 0) {
          const existing = await tx.workspace.findFirst({
            where: { id: access.workspace.id, deletedAt: null },
            select: { id: true },
          });

          if (!existing) {
            throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'That workspace does not exist');
          }

          throw new AppError(
            409,
            'WORKSPACE_NOT_ARCHIVED',
            'Only an archived workspace can be restored',
          );
        }

        const workspace = await tx.workspace.findUniqueOrThrow({
          where: { id: access.workspace.id },
        });

        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.WorkspaceRestored,
          targetType: 'Workspace',
          targetId: workspace.id,
          metadata: { name: workspace.name },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return workspace;
      });

      return toSummary(restored, access.membership.role, await counts(restored.id));
    },

    async remove(input, ctx): Promise<void> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.DeleteWorkspace,
      });

      if (access.workspace.isPersonal) {
        throw new AppError(
          409,
          'PERSONAL_WORKSPACE_LIFECYCLE_MANAGED',
          'A personal workspace can only be deleted through account deletion',
        );
      }

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

      assertMayAssignRole({
        actorRole: access.membership.role,
        requestedRole: input.role as WorkspaceRole,
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
      assertMayAssignRole({
        actorRole: access.membership.role,
        requestedRole: input.role as WorkspaceRole,
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

      const reassigned = await client.$transaction(async (tx) => {
        const [actorMembership, currentTarget] = await Promise.all([
          tx.workspaceMembership.findUnique({
            where: {
              workspaceId_userId: { workspaceId: access.workspace.id, userId: input.userId },
            },
          }),
          tx.workspaceMembership.findUnique({
            where: {
              workspaceId_userId: {
                workspaceId: access.workspace.id,
                userId: input.targetUserId,
              },
            },
          }),
        ]);

        if (!actorMembership || actorMembership.status !== 'ACTIVE' || !currentTarget) {
          throw new AppError(
            409,
            'MEMBERSHIP_CHANGED',
            'Workspace membership changed before the removal could complete',
          );
        }

        assertMayManageMember({
          actorRole: actorMembership.role,
          targetRole: currentTarget.role,
          targetIsOwner: input.targetUserId === access.workspace.ownerId,
        });

        assertOwnershipSafe({
          actorId: input.userId,
          targetUserId: input.targetUserId,
          targetRole: currentTarget.role,
          workspaceOwnerId: access.workspace.ownerId,
        });

        const taskReassignment = await reassignOpenTasksBeforeMemberRemoval(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          memberId: input.targetUserId,
          reassignToUserId: input.reassignTasksToUserId,
        });

        const removed = await tx.workspaceMembership.deleteMany({
          where: {
            id: currentTarget.id,
            workspaceId: access.workspace.id,
            userId: input.targetUserId,
          },
        });

        if (removed.count !== 1) {
          throw new AppError(
            409,
            'MEMBERSHIP_CHANGED',
            'Workspace membership changed before the removal could complete',
          );
        }

        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.MemberRemoved,
          targetType: 'WorkspaceMembership',
          targetId: target.id,
          metadata: {
            userId: target.user.id,
            email: target.user.email,
            role: currentTarget.role,
            reassignedTaskCount: taskReassignment.taskCount,
            ...(input.reassignTasksToUserId
              ? { reassignTasksToUserId: input.reassignTasksToUserId }
              : {}),
          },
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

        return taskReassignment.notices;
      });

      for (const notice of reassigned) {
        await taskAssignmentNotifier.notify(notice);
      }
    },

    async suspendMember(input, ctx): Promise<WorkspaceMember> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ManageMembers,
      });

      if (input.targetUserId === input.userId) {
        throw new AppError(403, 'CANNOT_SUSPEND_SELF', 'You cannot suspend your own membership');
      }

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

      if (target.status === 'SUSPENDED') {
        throw new AppError(
          409,
          'MEMBERSHIP_ALREADY_SUSPENDED',
          'This membership is already suspended',
        );
      }

      const updated = await client.$transaction(async (tx) => {
        const changed = await tx.workspaceMembership.update({
          where: { id: target.id },
          data: { status: 'SUSPENDED' },
          include: { user: { select: { id: true, name: true, email: true, status: true } } },
        });

        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.MemberSuspended,
          targetType: 'WorkspaceMembership',
          targetId: changed.id,
          metadata: { userId: target.user.id, role: target.role },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        await createNotification(tx, {
          userId: target.user.id,
          type: 'MEMBERSHIP_SUSPENDED',
          title: `Your access to ${access.workspace.name} is suspended`,
          body: 'An administrator suspended your membership. Contact the workspace owner to restore it.',
          link: workspaceLink(access.workspace.id),
          data: { workspaceId: access.workspace.id },
        });

        return changed;
      });

      return toMember(updated, access.workspace.ownerId);
    },

    async restoreMember(input, ctx): Promise<WorkspaceMember> {
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

      if (target.status !== 'SUSPENDED') {
        throw new AppError(409, 'MEMBERSHIP_NOT_SUSPENDED', 'This membership is not suspended');
      }

      const updated = await client.$transaction(async (tx) => {
        const changed = await tx.workspaceMembership.update({
          where: { id: target.id },
          data: { status: 'ACTIVE' },
          include: { user: { select: { id: true, name: true, email: true, status: true } } },
        });

        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.MemberRestored,
          targetType: 'WorkspaceMembership',
          targetId: changed.id,
          metadata: { userId: target.user.id, role: target.role },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        await createNotification(tx, {
          userId: target.user.id,
          type: 'MEMBERSHIP_RESTORED',
          title: `Your access to ${access.workspace.name} was restored`,
          body: 'An administrator restored your membership.',
          link: workspaceLink(access.workspace.id),
          data: { workspaceId: access.workspace.id },
        });

        return changed;
      });

      return toMember(updated, access.workspace.ownerId);
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
        // A transfer and account deletion must agree on whether either user
        // can own this workspace. Locks are held through the whole transfer.
        await lockActiveWorkspaceAccount(tx, input.userId);
        await lockActiveWorkspaceAccount(tx, input.newOwnerId);

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
        const changed = await tx.workspace.updateMany({
          where: {
            id: access.workspace.id,
            ownerId: input.userId,
            deletedAt: null,
          },
          data: { ownerId: input.newOwnerId },
        });

        if (changed.count === 0) {
          throw new AppError(
            409,
            'WORKSPACE_OWNERSHIP_CHANGED',
            'Workspace ownership changed before the transfer could complete',
          );
        }

        const changedWorkspace = await tx.workspace.findUniqueOrThrow({
          where: { id: access.workspace.id },
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

        return changedWorkspace;
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
