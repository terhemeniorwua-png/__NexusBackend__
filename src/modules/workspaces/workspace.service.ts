import type {
  Prisma,
  PrismaClient,
  OrganizationRole,
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
  roleCan,
  requireWorkspaceAccess,
  WorkspaceCapability,
} from './authorization';
import type {
  AddMemberInput,
  CreateDepartmentInput,
  DepartmentMemberInput,
  TransferOwnershipInput,
  UpdateMemberRoleInput,
  UpdateWorkspaceInput,
} from './workspace.schemas';
import type { DepartmentSummary, WorkspaceMember, WorkspaceSummary } from './workspace.types';
import { reassignOpenTasksBeforeMemberRemoval } from './task-reassignment';
import {
  assertCanAssignOrganizationRole,
  assertMayManageOrganizationMember,
  effectiveWorkspaceRole,
  isOrganizationOwnerRole,
  ownerOrganizationRole,
} from '../authorization/organization-role';
import { DepartmentCapability, requireDepartmentAccess } from '../authorization/department.policy';

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
  listDepartments(input: { userId: string; workspaceId: string }): Promise<DepartmentSummary[]>;
  createDepartment(
    input: { userId: string; workspaceId: string } & CreateDepartmentInput,
    ctx: RequestContext,
  ): Promise<DepartmentSummary>;
  assignDepartmentMember(
    input: { userId: string; workspaceId: string; departmentId: string } & DepartmentMemberInput,
    ctx: RequestContext,
  ): Promise<void>;
  removeDepartmentMember(
    input: { userId: string; workspaceId: string; departmentId: string; targetUserId: string },
    ctx: RequestContext,
  ): Promise<void>;
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
  organizationRole: WorkspaceMember['organizationRole'] = null,
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
    organizationRole,
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

function ownerRolesForWorkspace(type: WorkspaceType): OrganizationRole[] {
  if (type === 'COMPANY') return ['COMPANY_OWNER'];
  if (type === 'INSTITUTION') return ['INSTITUTION_OWNER'];
  return [];
}

async function lockWorkspaceForOwnerChange(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<Workspace> {
  await tx.$queryRaw`SELECT "id" FROM "Workspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
  return tx.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
}

async function activeOrganizationOwners(
  tx: Prisma.TransactionClient,
  workspace: Workspace,
): Promise<Array<{ userId: string }>> {
  const roleValues = ownerRolesForWorkspace(workspace.type);
  const memberships = await tx.workspaceMembership.findMany({
    where: {
      workspaceId: workspace.id,
      status: 'ACTIVE',
      OR: [
        ...(roleValues.length ? [{ organizationRole: { in: roleValues } }] : []),
        { userId: workspace.ownerId, role: 'OWNER' },
      ],
    },
    select: { userId: true },
  });
  return [...new Map(memberships.map((membership) => [membership.userId, membership])).values()];
}

async function requireCurrentMemberManager(
  tx: Prisma.TransactionClient,
  workspace: Workspace,
  userId: string,
): Promise<WorkspaceMembership> {
  const membership = await tx.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
  });
  if (
    !membership ||
    membership.status !== 'ACTIVE' ||
    !roleCan(
      effectiveWorkspaceRole(workspace.type, membership.role, membership.organizationRole),
      WorkspaceCapability.ManageMembers,
    )
  ) {
    throw new AppError(
      403,
      'MEMBERSHIP_PERMISSION_CHANGED',
      'Your membership no longer allows this action',
    );
  }
  return membership;
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
    organizationRole: membership.organizationRole,
    membershipStatus: membership.status,
    joinedAt: membership.joinedAt,
    owner: membership.user.id === ownerId || isOrganizationOwnerRole(membership.organizationRole),
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
            organizationRole: ownerOrganizationRole(created.type),
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

      return toSummary(
        workspace,
        'OWNER',
        { members: 1, projects: 0, teams: 0 },
        ownerOrganizationRole(workspace.type),
      );
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
          toSummary(
            membership.workspace,
            effectiveWorkspaceRole(
              membership.workspace.type,
              membership.role,
              membership.organizationRole,
            ),
            {
              members: membership.workspace._count.members,
              projects: membership.workspace._count.projects,
              teams: membership.workspace._count.teams,
            },
            membership.organizationRole,
          ),
        );
    },

    async get(input): Promise<WorkspaceSummary> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      return toSummary(
        access.workspace,
        access.effectiveRole,
        await counts(access.workspace.id),
        access.membership.organizationRole,
      );
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

      return toSummary(
        updated,
        access.effectiveRole,
        await counts(updated.id),
        access.membership.organizationRole,
      );
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

      return toSummary(
        archived,
        access.effectiveRole,
        await counts(archived.id),
        access.membership.organizationRole,
      );
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

      return toSummary(
        restored,
        access.effectiveRole,
        await counts(restored.id),
        access.membership.organizationRole,
      );
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

      return toSummary(
        access.workspace,
        access.effectiveRole,
        await counts(access.workspace.id),
        access.membership.organizationRole,
      );
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

    async listDepartments(input): Promise<DepartmentSummary[]> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      if (access.workspace.type !== 'INSTITUTION') {
        throw new AppError(
          404,
          'DEPARTMENT_NOT_FOUND',
          'Departments are only available in institutions',
        );
      }

      const privileged =
        isOrganizationOwnerRole(access.membership.organizationRole) ||
        access.membership.organizationRole === 'INSTITUTION_ADMIN' ||
        (!access.membership.organizationRole && access.effectiveRole === 'PROJECT_MANAGER');
      const departments = await client.department.findMany({
        where: {
          workspaceId: access.workspace.id,
          ...(privileged ? {} : { members: { some: { userId: input.userId } } }),
        },
        include: { _count: { select: { members: true } } },
        orderBy: { name: 'asc' },
      });
      return departments.map((department) => ({
        id: department.id,
        workspaceId: department.workspaceId,
        name: department.name,
        memberCount: department._count.members,
        createdAt: department.createdAt,
        updatedAt: department.updatedAt,
      }));
    },

    async createDepartment(input, ctx): Promise<DepartmentSummary> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.UpdateWorkspace,
      });
      if (access.workspace.type !== 'INSTITUTION') {
        throw new AppError(
          404,
          'DEPARTMENT_NOT_FOUND',
          'Departments are only available in institutions',
        );
      }
      const privileged =
        isOrganizationOwnerRole(access.membership.organizationRole) ||
        access.membership.organizationRole === 'INSTITUTION_ADMIN' ||
        (!access.membership.organizationRole && access.effectiveRole === 'PROJECT_MANAGER');
      if (!privileged) {
        throw new AppError(
          403,
          'INSUFFICIENT_ROLE',
          'Only institution administrators can create departments',
        );
      }

      const department = await client.$transaction(async (tx) => {
        const created = await tx.department.create({
          data: { workspaceId: access.workspace.id, name: input.name },
          include: { _count: { select: { members: true } } },
        });
        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.DepartmentCreated,
          targetType: 'Department',
          targetId: created.id,
          metadata: { name: created.name },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return created;
      });
      return {
        id: department.id,
        workspaceId: department.workspaceId,
        name: department.name,
        memberCount: department._count.members,
        createdAt: department.createdAt,
        updatedAt: department.updatedAt,
      };
    },

    async assignDepartmentMember(input, ctx): Promise<void> {
      const access = await requireDepartmentAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        departmentId: input.departmentId,
        capability: DepartmentCapability.ManageMembers,
      });
      const actorMembership = await client.workspaceMembership.findUniqueOrThrow({
        where: {
          workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId },
        },
      });
      const institutionAdmin =
        isOrganizationOwnerRole(actorMembership.organizationRole) ||
        actorMembership.organizationRole === 'INSTITUTION_ADMIN' ||
        (!actorMembership.organizationRole &&
          (actorMembership.role === 'OWNER' || actorMembership.role === 'PROJECT_MANAGER'));
      if (input.role === 'HEAD' && !institutionAdmin) {
        throw new AppError(
          403,
          'INSUFFICIENT_ROLE',
          'Only an institution administrator can assign a department head',
        );
      }

      const target = await client.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: input.workspaceId, userId: input.targetUserId },
        },
      });
      if (!target || target.status !== 'ACTIVE') {
        throw new AppError(
          404,
          'MEMBER_NOT_FOUND',
          'The selected account is not an active institution member',
        );
      }
      if (input.role === 'HEAD' && target.organizationRole !== 'INSTITUTION_DEPARTMENT_HEAD') {
        throw new AppError(
          409,
          'DEPARTMENT_HEAD_ROLE_REQUIRED',
          'Assign the Institution Department Head organization role before department assignment',
        );
      }

      await client.$transaction(async (tx) => {
        const assigned = await tx.departmentMembership.upsert({
          where: {
            departmentId_userId: {
              departmentId: access.department.id,
              userId: input.targetUserId,
            },
          },
          create: {
            departmentId: access.department.id,
            userId: input.targetUserId,
            role: input.role,
          },
          update: { role: input.role },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: WorkspaceAuditAction.DepartmentMemberAdded,
          targetType: 'DepartmentMembership',
          targetId: assigned.id,
          metadata: {
            departmentId: access.department.id,
            userId: input.targetUserId,
            role: input.role,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      });
    },

    async removeDepartmentMember(input, ctx): Promise<void> {
      const access = await requireDepartmentAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        departmentId: input.departmentId,
        capability: DepartmentCapability.ManageMembers,
      });
      const target = await client.departmentMembership.findUnique({
        where: {
          departmentId_userId: {
            departmentId: access.department.id,
            userId: input.targetUserId,
          },
        },
      });
      if (!target) {
        throw new AppError(
          404,
          'DEPARTMENT_MEMBER_NOT_FOUND',
          'That user is not assigned to this department',
        );
      }
      if (target.role === 'HEAD' && input.userId !== input.targetUserId) {
        const actor = await client.workspaceMembership.findUniqueOrThrow({
          where: {
            workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId },
          },
        });
        const admin =
          isOrganizationOwnerRole(actor.organizationRole) ||
          actor.organizationRole === 'INSTITUTION_ADMIN' ||
          (!actor.organizationRole && (actor.role === 'OWNER' || actor.role === 'PROJECT_MANAGER'));
        if (!admin) {
          throw new AppError(
            403,
            'INSUFFICIENT_ROLE',
            'Only an institution administrator can remove a department head',
          );
        }
      }
      await client.$transaction(async (tx) => {
        await tx.departmentMembership.delete({ where: { id: target.id } });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: WorkspaceAuditAction.DepartmentMemberRemoved,
          targetType: 'DepartmentMembership',
          targetId: target.id,
          metadata: {
            departmentId: access.department.id,
            userId: input.targetUserId,
            role: target.role,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      });
    },

    async addMember(input, ctx): Promise<WorkspaceMember> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ManageMembers,
      });

      if (input.organizationRole) {
        assertCanAssignOrganizationRole({
          workspaceType: access.workspace.type,
          actorLegacyRole: access.membership.role,
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

      if (isOrganizationOwnerRole(input.organizationRole) && user.status !== 'ACTIVE') {
        throw new AppError(
          409,
          'OWNER_MUST_BE_ACTIVE',
          'An organization owner must have an active account',
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
        const lockedWorkspace = await lockWorkspaceForOwnerChange(tx, access.workspace.id);
        const actor = await requireCurrentMemberManager(tx, lockedWorkspace, input.userId);
        if (input.organizationRole) {
          assertCanAssignOrganizationRole({
            workspaceType: lockedWorkspace.type,
            actorLegacyRole: effectiveWorkspaceRole(
              lockedWorkspace.type,
              actor.role,
              actor.organizationRole,
            ),
            actorOrganizationRole: actor.organizationRole,
            requestedRole: input.organizationRole,
          });
        } else {
          assertMayAssignRole({
            actorRole: effectiveWorkspaceRole(
              lockedWorkspace.type,
              actor.role,
              actor.organizationRole,
            ),
            requestedRole: input.role as WorkspaceRole,
          });
        }
        const created = await tx.workspaceMembership.create({
          data: {
            workspaceId: access.workspace.id,
            userId: user.id,
            role: assignedRole,
            organizationRole: input.organizationRole ?? null,
          },
          include: { user: { select: { id: true, name: true, email: true, status: true } } },
        });

        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.MemberAdded,
          targetType: 'WorkspaceMembership',
          targetId: created.id,
          metadata: {
            userId: user.id,
            email: user.email,
            role: assignedRole,
            organizationRole: input.organizationRole ?? null,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        await createNotification(tx, {
          userId: user.id,
          type: 'MEMBERSHIP_CHANGED',
          title: `You joined ${access.workspace.name}`,
          body: `Your role in ${access.workspace.name} is ${(input.organizationRole ?? assignedRole).toLowerCase().replaceAll('_', ' ')}.`,
          link: workspaceLink(access.workspace.id),
          data: {
            workspaceId: access.workspace.id,
            role: assignedRole,
            organizationRole: input.organizationRole ?? null,
          },
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

      const targetIsOwner =
        isOrganizationOwnerRole(target.organizationRole) ||
        (!target.organizationRole && target.user.id === access.workspace.ownerId);
      assertMayManageOrganizationMember({
        actorLegacyRole: access.effectiveRole,
        actorOrganizationRole: access.membership.organizationRole,
        targetOrganizationRole: target.organizationRole,
        targetLegacyRole: target.role,
        targetIsPrimaryOwner: target.user.id === access.workspace.ownerId,
      });
      if (!target.organizationRole) {
        assertMayManageMember({
          actorRole: access.effectiveRole,
          targetRole: target.role,
          targetIsOwner,
        });
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
      const assignedOrganizationRole = input.organizationRole ?? null;
      if (
        isOrganizationOwnerRole(assignedOrganizationRole) &&
        (target.status !== 'ACTIVE' || target.user.status !== 'ACTIVE')
      ) {
        throw new AppError(
          409,
          'OWNER_MUST_BE_ACTIVE',
          'An organization owner must have an active account',
        );
      }

      const updated = await client.$transaction(async (tx) => {
        const currentWorkspace = await lockWorkspaceForOwnerChange(tx, access.workspace.id);
        const currentActor = await requireCurrentMemberManager(tx, currentWorkspace, input.userId);
        const currentTarget = await tx.workspaceMembership.findUniqueOrThrow({
          where: {
            workspaceId_userId: {
              workspaceId: access.workspace.id,
              userId: input.targetUserId,
            },
          },
        });
        assertMayManageOrganizationMember({
          actorLegacyRole: effectiveWorkspaceRole(
            currentWorkspace.type,
            currentActor.role,
            currentActor.organizationRole,
          ),
          actorOrganizationRole: currentActor.organizationRole,
          targetOrganizationRole: currentTarget.organizationRole,
          targetLegacyRole: currentTarget.role,
          targetIsPrimaryOwner: currentTarget.userId === currentWorkspace.ownerId,
        });
        if (!currentTarget.organizationRole) {
          assertMayManageMember({
            actorRole: effectiveWorkspaceRole(
              currentWorkspace.type,
              currentActor.role,
              currentActor.organizationRole,
            ),
            targetRole: currentTarget.role,
            targetIsOwner: currentTarget.userId === currentWorkspace.ownerId,
          });
        }
        if (input.organizationRole) {
          assertCanAssignOrganizationRole({
            workspaceType: currentWorkspace.type,
            actorLegacyRole: effectiveWorkspaceRole(
              currentWorkspace.type,
              currentActor.role,
              currentActor.organizationRole,
            ),
            actorOrganizationRole: currentActor.organizationRole,
            requestedRole: input.organizationRole,
          });
        } else {
          assertMayAssignRole({
            actorRole: effectiveWorkspaceRole(
              currentWorkspace.type,
              currentActor.role,
              currentActor.organizationRole,
            ),
            requestedRole: input.role as WorkspaceRole,
          });
        }
        const owners = await activeOrganizationOwners(tx, currentWorkspace);
        const targetIsOrgOwner =
          isOrganizationOwnerRole(currentTarget.organizationRole) ||
          (!currentTarget.organizationRole && currentTarget.userId === currentWorkspace.ownerId);
        const remainsOwner = isOrganizationOwnerRole(assignedOrganizationRole);

        if (targetIsOrgOwner && !remainsOwner) {
          const remainingOwners = owners.filter((owner) => owner.userId !== currentTarget.userId);
          if (remainingOwners.length === 0) {
            throw new AppError(
              409,
              'LAST_ORGANIZATION_OWNER',
              'An organization must retain at least one active owner',
            );
          }
          if (currentWorkspace.ownerId === currentTarget.userId) {
            await tx.workspace.update({
              where: { id: currentWorkspace.id },
              data: { ownerId: remainingOwners[0]!.userId },
            });
          }
        }

        const changed = await tx.workspaceMembership.update({
          where: { id: currentTarget.id },
          data: { role: assignedRole, organizationRole: assignedOrganizationRole },
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
            previousOrganizationRole: target.organizationRole,
            role: assignedRole,
            organizationRole: assignedOrganizationRole,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        await createNotification(tx, {
          userId: changed.user.id,
          type: 'MEMBERSHIP_CHANGED',
          title: `Your role in ${access.workspace.name} changed`,
          body: `Your role is now ${(assignedOrganizationRole ?? assignedRole).toLowerCase().replaceAll('_', ' ')}.`,
          link: workspaceLink(access.workspace.id),
          data: {
            workspaceId: access.workspace.id,
            role: assignedRole,
            organizationRole: assignedOrganizationRole,
          },
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

      const targetIsOwner =
        isOrganizationOwnerRole(target.organizationRole) ||
        (!target.organizationRole && target.user.id === access.workspace.ownerId);
      assertMayManageOrganizationMember({
        actorLegacyRole: access.effectiveRole,
        actorOrganizationRole: access.membership.organizationRole,
        targetOrganizationRole: target.organizationRole,
        targetLegacyRole: target.role,
        targetIsPrimaryOwner: target.user.id === access.workspace.ownerId,
      });
      if (!target.organizationRole) {
        assertMayManageMember({
          actorRole: access.effectiveRole,
          targetRole: target.role,
          targetIsOwner,
        });
      }

      // Prevent the owner from removing themselves (which would leave the
      // workspace permanently ownerless).
      if (!isOrganizationOwnerRole(target.organizationRole)) {
        assertOwnershipSafe({
          actorId: input.userId,
          targetUserId: input.targetUserId,
          targetRole: target.role,
          workspaceOwnerId: access.workspace.ownerId,
        });
      }

      const reassigned = await client.$transaction(async (tx) => {
        const currentWorkspace = await lockWorkspaceForOwnerChange(tx, access.workspace.id);
        const owners = await activeOrganizationOwners(tx, currentWorkspace);
        const targetIsOrgOwner =
          isOrganizationOwnerRole(target.organizationRole) ||
          (!target.organizationRole && target.user.id === currentWorkspace.ownerId);

        if (targetIsOrgOwner) {
          const remainingOwners = owners.filter((owner) => owner.userId !== target.user.id);
          if (remainingOwners.length === 0) {
            throw new AppError(
              409,
              'LAST_ORGANIZATION_OWNER',
              'An organization must retain at least one active owner',
            );
          }
          if (currentWorkspace.ownerId === target.user.id) {
            await tx.workspace.update({
              where: { id: currentWorkspace.id },
              data: { ownerId: remainingOwners[0]!.userId },
            });
          }
        }

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

        assertMayManageOrganizationMember({
          actorLegacyRole: effectiveWorkspaceRole(
            currentWorkspace.type,
            actorMembership.role,
            actorMembership.organizationRole,
          ),
          actorOrganizationRole: actorMembership.organizationRole,
          targetOrganizationRole: currentTarget.organizationRole,
          targetLegacyRole: currentTarget.role,
          targetIsPrimaryOwner: input.targetUserId === currentWorkspace.ownerId,
        });
        if (!currentTarget.organizationRole) {
          assertMayManageMember({
            actorRole: effectiveWorkspaceRole(
              currentWorkspace.type,
              actorMembership.role,
              actorMembership.organizationRole,
            ),
            targetRole: currentTarget.role,
            targetIsOwner: input.targetUserId === currentWorkspace.ownerId,
          });
          assertOwnershipSafe({
            actorId: input.userId,
            targetUserId: input.targetUserId,
            targetRole: currentTarget.role,
            workspaceOwnerId: currentWorkspace.ownerId,
          });
        }

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

        await tx.teamMembership.deleteMany({
          where: { userId: input.targetUserId, team: { workspaceId: access.workspace.id } },
        });
        await tx.projectMembership.deleteMany({
          where: { userId: input.targetUserId, project: { workspaceId: access.workspace.id } },
        });
        await tx.departmentMembership.deleteMany({
          where: {
            userId: input.targetUserId,
            department: { workspaceId: access.workspace.id },
          },
        });

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
            organizationRole: currentTarget.organizationRole,
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

      const targetIsOwner =
        isOrganizationOwnerRole(target.organizationRole) ||
        (!target.organizationRole && target.user.id === access.workspace.ownerId);
      assertMayManageOrganizationMember({
        actorLegacyRole: access.effectiveRole,
        actorOrganizationRole: access.membership.organizationRole,
        targetOrganizationRole: target.organizationRole,
        targetLegacyRole: target.role,
        targetIsPrimaryOwner: target.user.id === access.workspace.ownerId,
      });
      if (!target.organizationRole) {
        assertMayManageMember({
          actorRole: access.effectiveRole,
          targetRole: target.role,
          targetIsOwner,
        });
      }

      if (target.status === 'SUSPENDED') {
        throw new AppError(
          409,
          'MEMBERSHIP_ALREADY_SUSPENDED',
          'This membership is already suspended',
        );
      }

      const updated = await client.$transaction(async (tx) => {
        const currentWorkspace = await lockWorkspaceForOwnerChange(tx, access.workspace.id);
        const owners = await activeOrganizationOwners(tx, currentWorkspace);
        if (
          isOrganizationOwnerRole(target.organizationRole) ||
          (!target.organizationRole && target.user.id === currentWorkspace.ownerId)
        ) {
          const remainingOwners = owners.filter((owner) => owner.userId !== target.user.id);
          if (remainingOwners.length === 0) {
            throw new AppError(
              409,
              'LAST_ORGANIZATION_OWNER',
              'An organization must retain at least one active owner',
            );
          }
          if (currentWorkspace.ownerId === target.user.id) {
            await tx.workspace.update({
              where: { id: currentWorkspace.id },
              data: { ownerId: remainingOwners[0]!.userId },
            });
          }
        }
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

      const targetIsOwner =
        isOrganizationOwnerRole(target.organizationRole) ||
        (!target.organizationRole && target.user.id === access.workspace.ownerId);
      assertMayManageOrganizationMember({
        actorLegacyRole: access.effectiveRole,
        actorOrganizationRole: access.membership.organizationRole,
        targetOrganizationRole: target.organizationRole,
        targetLegacyRole: target.role,
        targetIsPrimaryOwner: target.user.id === access.workspace.ownerId,
      });
      if (!target.organizationRole) {
        assertMayManageMember({
          actorRole: access.effectiveRole,
          targetRole: target.role,
          targetIsOwner,
        });
      }

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

        const lockedWorkspace = await lockWorkspaceForOwnerChange(tx, access.workspace.id);
        const currentOwnerMembership = await tx.workspaceMembership.findUniqueOrThrow({
          where: {
            workspaceId_userId: { workspaceId: access.workspace.id, userId: input.userId },
          },
        });
        if (
          !isOrganizationOwnerRole(currentOwnerMembership.organizationRole) &&
          !(currentOwnerMembership.role === 'OWNER' && lockedWorkspace.ownerId === input.userId)
        ) {
          throw new AppError(
            403,
            'ORGANIZATION_OWNER_REQUIRED',
            'Only an owner may transfer ownership',
          );
        }

        const refreshedTarget = await tx.workspaceMembership.findUniqueOrThrow({
          where: {
            workspaceId_userId: { workspaceId: access.workspace.id, userId: input.newOwnerId },
          },
        });
        if (refreshedTarget.status !== 'ACTIVE') {
          throw new AppError(409, 'NEW_OWNER_NOT_ACTIVE', 'The new owner must be an active member');
        }

        const newOrganizationOwnerRole = ownerOrganizationRole(lockedWorkspace.type);
        if (newOrganizationOwnerRole) {
          // Organization ownership is multi-owner. A transfer changes the
          // primary owner while preserving the previous owner's approved role.
          await tx.workspaceMembership.update({
            where: { id: refreshedTarget.id },
            data: { role: 'OWNER', organizationRole: newOrganizationOwnerRole },
          });
          if (!currentOwnerMembership.organizationRole) {
            await tx.workspaceMembership.update({
              where: { id: currentOwnerMembership.id },
              data: { role: 'OWNER', organizationRole: newOrganizationOwnerRole },
            });
          }
        } else {
          await tx.workspaceMembership.update({
            where: { id: refreshedTarget.id },
            data: { role: 'OWNER' },
          });
          await tx.workspaceMembership.update({
            where: { id: currentOwnerMembership.id },
            data: { role: input.newOwnerRole as WorkspaceRole },
          });
        }

        // Transfer the authoritative owner column on the workspace itself.
        const changed = await tx.workspace.updateMany({
          where: {
            id: access.workspace.id,
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

      const callerStillOwner = ownerOrganizationRole(updatedWorkspace.type) !== null;
      return toSummary(
        updatedWorkspace,
        callerStillOwner ? 'OWNER' : (input.newOwnerRole as WorkspaceRole),
        await counts(updatedWorkspace.id),
        callerStillOwner ? ownerOrganizationRole(updatedWorkspace.type) : null,
      );
    },
  };
}
