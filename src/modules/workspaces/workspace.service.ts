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
import { enqueueAutomationRunsSafely } from '../automation/automation.events';
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
  UpdateDepartmentInput,
  TransferOwnershipInput,
  UpdateMemberRoleInput,
  UpdateWorkspaceInput,
} from './workspace.schemas';
import type { DepartmentSummary, WorkspaceMember, WorkspaceSummary } from './workspace.types';
import { reassignOpenTasksBeforeMemberRemoval } from './task-reassignment';
import { revokeSsoSessionsForMember } from '../sso/sso.service';
import {
  assertCanAssignOrganizationRole,
  assertMayManageOrganizationMember,
  effectiveWorkspaceRole,
  isOrganizationOwnerRole,
  ownerOrganizationRole,
} from '../authorization/organization-role';
import { DepartmentCapability, requireDepartmentAccess } from '../authorization/department.policy';
import {
  assertWorkspaceSeatCapacity,
  enqueueWorkspaceSeatReduction,
} from '../billing/membership-billing';

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
  updateDepartment(
    input: {
      userId: string;
      workspaceId: string;
      departmentId: string;
    } & UpdateDepartmentInput,
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
  ): Promise<{ transferId: string; status: 'PENDING' }>;
  listIncomingOwnershipTransfers(input: { userId: string; limit: number; offset: number }): Promise<unknown>;
  acceptOwnershipTransfer(input: { userId: string; workspaceId: string; transferId: string }, ctx: RequestContext): Promise<{ workspaceId: string; billingAcceptanceRequired: boolean }>;
  rejectOwnershipTransfer(input: { userId: string; workspaceId: string; transferId: string }, ctx: RequestContext): Promise<{ workspaceId: string; status: 'REJECTED' }>;
  acceptOwnershipBilling(input: { userId: string; workspaceId: string; transferId: string }, ctx: RequestContext): Promise<{ workspaceId: string }>;
  resolveDeletedOwner(input: { actorId: string; workspaceId: string; newOwnerId: string }, ctx: RequestContext): Promise<{ workspaceId: string; status: 'SUSPENDED' }>;
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

function isDepartmentNameConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'P2002') {
    return false;
  }
  const target =
    'meta' in error ? (error.meta as { target?: unknown } | undefined)?.target : undefined;
  return (
    (Array.isArray(target) && target.includes('workspaceId') && target.includes('name')) ||
    (typeof target === 'string' && target.includes('Department_workspaceId_name_key'))
  );
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

        if (created.type === 'COMPANY') {
          await tx.companyProfile.create({ data: { workspaceId: created.id, name: created.name } });
        } else if (created.type === 'INSTITUTION') {
          await tx.institutionProfile.create({
            data: { workspaceId: created.id, name: created.name },
          });
        }

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

        const archivedAt = new Date();
        await tx.invitation.updateMany({
          where: { workspaceId: changed.id, status: 'PENDING', expiresAt: { lte: archivedAt } },
          data: { status: 'EXPIRED', pendingKey: null },
        });
        await tx.invitation.updateMany({
          where: { workspaceId: changed.id, status: 'PENDING', expiresAt: { gt: archivedAt } },
          data: { status: 'REVOKED', revokedAt: archivedAt, pendingKey: null },
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
        allowArchived: true,
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
        allowArchived: true,
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
        allowArchived: true,
      });

      if (access.workspace.status !== 'ACTIVE') {
        throw new AppError(409, 'WORKSPACE_NOT_ACTIVE', 'This workspace is not active');
      }

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

    async updateDepartment(input, ctx): Promise<DepartmentSummary> {
      const access = await requireDepartmentAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        departmentId: input.departmentId,
        capability: DepartmentCapability.Update,
      });
      if (access.department.name !== input.name) {
        const duplicate = await client.department.findUnique({
          where: { workspaceId_name: { workspaceId: input.workspaceId, name: input.name } },
          select: { id: true },
        });
        if (duplicate && duplicate.id !== access.department.id) {
          throw new AppError(
            409,
            'DEPARTMENT_NAME_EXISTS',
            'A department with that name already exists in this institution',
          );
        }
      }

      try {
        const updated = await client.$transaction(async (tx) => {
          const department = await tx.department.update({
            where: { id: access.department.id },
            data: { name: input.name },
            include: { _count: { select: { members: true } } },
          });
          await recordAuditEvent(tx, {
            workspaceId: input.workspaceId,
            actorId: input.userId,
            action: WorkspaceAuditAction.DepartmentUpdated,
            targetType: 'Department',
            targetId: department.id,
            metadata: { previousName: access.department.name, name: department.name },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          return department;
        });
        return {
          id: updated.id,
          workspaceId: updated.workspaceId,
          name: updated.name,
          memberCount: updated._count.members,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        };
      } catch (error) {
        if (isDepartmentNameConflict(error)) {
          throw new AppError(
            409,
            'DEPARTMENT_NAME_EXISTS',
            'A department with that name already exists in this institution',
          );
        }
        throw error;
      }
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
        await assertWorkspaceSeatCapacity(tx, {
          workspaceId: access.workspace.id,
          userId: user.id,
        });
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

      await enqueueAutomationRunsSafely({
        workspaceId: access.workspace.id,
        trigger: 'EVENT_MEMBER_JOINED',
        eventKey: `member.joined:membership:${membership.id}`,
        payload: {
          workspaceId: access.workspace.id,
          userId: membership.userId,
          membershipId: membership.id,
          role: assignedRole,
          organizationRole: input.organizationRole ?? null,
          source: 'direct_add',
        },
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

        await enqueueWorkspaceSeatReduction(tx, access.workspace.id);

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
        await tx.institutionGroupMembership.deleteMany({
          where: {
            userId: input.targetUserId,
            group: { workspaceId: access.workspace.id },
          },
        });
        await tx.channelMembership.deleteMany({
          where: { userId: input.targetUserId, channel: { workspaceId: access.workspace.id } },
        });
        await tx.institutionGroup.updateMany({
          where: { workspaceId: access.workspace.id, leadId: input.targetUserId },
          data: { leadId: null },
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

      await revokeSsoSessionsForMember(client, access.workspace.id, input.targetUserId).catch(() => undefined);
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

        await enqueueWorkspaceSeatReduction(tx, access.workspace.id);

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

      await revokeSsoSessionsForMember(client, access.workspace.id, input.targetUserId).catch(() => undefined);
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
        await lockWorkspaceForOwnerChange(tx, access.workspace.id);
        await assertWorkspaceSeatCapacity(tx, {
          workspaceId: access.workspace.id,
          userId: target.user.id,
        });
        const changed = await tx.workspaceMembership.update({
          where: { id: target.id },
          data: { status: 'ACTIVE' },
          include: { user: { select: { id: true, name: true, email: true, status: true } } },
        });

        await enqueueWorkspaceSeatReduction(tx, access.workspace.id);

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

    async transferOwnership(input, ctx): Promise<{ transferId: string; status: 'PENDING' }> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.TransferOwnership,
      });
      if (input.newOwnerId === input.userId) {
        throw new AppError(400, 'TRANSFER_TO_SELF', 'You cannot transfer ownership to yourself');
      }
      const created = await client.$transaction(async (tx) => {
        await lockActiveWorkspaceAccount(tx, input.userId);
        await lockActiveWorkspaceAccount(tx, input.newOwnerId);
        const workspace = await lockWorkspaceForOwnerChange(tx, access.workspace.id);
        if (workspace.ownerId !== input.userId) {
          throw new AppError(403, 'ORGANIZATION_OWNER_REQUIRED', 'Only the current owner may initiate a transfer');
        }
        const [ownerMembership, recipientMembership] = await Promise.all([
          tx.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: input.userId } } }),
          tx.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: input.newOwnerId } } }),
        ]);
        if (!ownerMembership || !isOrganizationOwnerRole(ownerMembership.organizationRole) && ownerMembership.role !== 'OWNER') {
          throw new AppError(403, 'ORGANIZATION_OWNER_REQUIRED', 'Only the current owner may initiate a transfer');
        }
        if (!recipientMembership || recipientMembership.status !== 'ACTIVE') {
          throw new AppError(409, 'NEW_OWNER_NOT_ACTIVE', 'The recipient must be an active workspace member');
        }
        await tx.workspaceOwnershipTransfer.updateMany({
          where: { workspaceId: workspace.id, status: 'PENDING' },
          data: { status: 'CANCELLED' },
        });
        return tx.workspaceOwnershipTransfer.create({
          data: {
            workspaceId: workspace.id,
            initiatedById: input.userId,
            recipientUserId: input.newOwnerId,
            previousOwnerRole: input.newOwnerRole as WorkspaceRole,
          },
          select: { id: true },
        });
      });
      await recordAuditEvent(client, {
        workspaceId: access.workspace.id,
        actorId: input.userId,
        action: 'workspace.ownership_transfer_initiated',
        targetType: 'WorkspaceOwnershipTransfer',
        targetId: created.id,
        metadata: { recipientUserId: input.newOwnerId },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { transferId: created.id, status: 'PENDING' };
    },
    async listIncomingOwnershipTransfers({ userId, limit, offset }) {
      const now = new Date();
      const rows = await client.$queryRaw<Array<{ id: string }>>`
        SELECT t."id"
        FROM "WorkspaceOwnershipTransfer" t
        JOIN "Workspace" w ON w."id" = t."workspaceId"
        JOIN "WorkspaceMembership" m ON m."workspaceId" = t."workspaceId"
          AND m."userId" = t."recipientUserId" AND m."status" = 'ACTIVE'
        JOIN "User" u ON u."id" = t."recipientUserId"
        WHERE t."recipientUserId" = ${userId}
          AND t."status" = 'PENDING'
          AND (t."expiresAt" IS NULL OR t."expiresAt" > ${now})
          AND w."ownerId" = t."initiatedById"
          AND u."status" = 'ACTIVE' AND u."deletedAt" IS NULL
        ORDER BY t."createdAt", t."id"
        LIMIT ${limit} OFFSET ${offset}`;
      const transfers = rows.length > 0
        ? await client.workspaceOwnershipTransfer.findMany({
            where: { id: { in: rows.map((row) => row.id) } },
        select: {
          id: true,
          workspaceId: true,
          status: true,
          createdAt: true,
          expiresAt: true,
          acceptedAt: true,
          billingAcceptedAt: true,
          workspace: { select: { id: true, name: true, type: true, status: true } },
          initiatedBy: { select: { id: true, name: true } },
        },
          })
        : [];
      const byId = new Map(transfers.map((transfer) => [transfer.id, transfer]));
      const items = rows.flatMap((row) => {
        const transfer = byId.get(row.id);
        return transfer ? [transfer] : [];
      });
      return { items, limit, offset };
    },
    async acceptOwnershipTransfer(input: { userId: string; workspaceId: string; transferId: string }, ctx): Promise<{ workspaceId: string; billingAcceptanceRequired: boolean }> {
      return client.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "WorkspaceOwnershipTransfer"
          WHERE "id" = ${input.transferId} AND "workspaceId" = ${input.workspaceId}
          FOR UPDATE`;
        const transfer = locked
          ? await tx.workspaceOwnershipTransfer.findUnique({ where: { id: locked.id }, include: { workspace: { include: { subscription: true } } } })
          : null;
        if (!transfer || transfer.workspaceId !== input.workspaceId || transfer.recipientUserId !== input.userId || transfer.status !== 'PENDING') {
          throw new AppError(404, 'OWNERSHIP_TRANSFER_NOT_FOUND', 'The pending ownership transfer was not found');
        }
        const now = new Date();
        if (transfer.expiresAt && transfer.expiresAt <= now) {
          throw new AppError(409, 'OWNERSHIP_TRANSFER_EXPIRED', 'The ownership transfer has expired');
        }
        await lockWorkspaceForOwnerChange(tx, transfer.workspaceId);
        const [owners] = await tx.$queryRaw<Array<{ status: string; deletedAt: Date | null; scheduledDeletionAt: Date | null }>>`
          SELECT "status"::text AS "status", "deletedAt", "scheduledDeletionAt" FROM "User" WHERE "id" = ${transfer.initiatedById} FOR UPDATE`;
        if (!owners || owners.deletedAt || !['ACTIVE', 'PENDING_DELETION'].includes(owners.status) || owners.status === 'PENDING_DELETION' && (!owners.scheduledDeletionAt || owners.scheduledDeletionAt <= now)) {
          throw new AppError(409, 'OWNERSHIP_TRANSFER_EXPIRED', 'The current owner is no longer eligible to transfer ownership');
        }
        const [recipient] = await tx.$queryRaw<Array<{ status: string; deletedAt: Date | null }>>`
          SELECT "status"::text AS "status", "deletedAt" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
        if (!recipient || recipient.status !== 'ACTIVE' || recipient.deletedAt) {
          throw new AppError(403, 'NEW_OWNER_NOT_ACTIVE', 'The recipient must have an active account');
        }
        const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: transfer.workspaceId } });
        if (workspace.ownerId !== transfer.initiatedById) throw new AppError(409, 'WORKSPACE_OWNERSHIP_CHANGED', 'Workspace ownership changed before acceptance');
        const recipientMembership = await tx.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: transfer.workspaceId, userId: input.userId } } });
        if (!recipientMembership || recipientMembership.status !== 'ACTIVE') throw new AppError(409, 'NEW_OWNER_NOT_ACTIVE', 'The recipient must be an active workspace member');
        const ownerMembership = await tx.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: transfer.workspaceId, userId: transfer.initiatedById } } });
        if (!ownerMembership) throw new AppError(409, 'WORKSPACE_OWNER_MEMBERSHIP_MISSING', 'The current owner membership is unavailable');
        await tx.workspaceMembership.update({ where: { id: recipientMembership.id }, data: { role: 'OWNER', organizationRole: ownerOrganizationRole(workspace.type) } });
        await tx.workspaceMembership.update({ where: { id: ownerMembership.id }, data: { role: transfer.previousOwnerRole, organizationRole: null } });
        const billingAcceptanceRequired = Boolean(transfer.workspace.subscription && transfer.workspace.subscription.status !== 'CANCELLED');
        await tx.workspace.update({ where: { id: workspace.id }, data: { ownerId: input.userId, status: billingAcceptanceRequired ? 'SUSPENDED' : 'ACTIVE', deletionSuspendedAt: null } });
        await tx.workspaceOwnershipTransfer.update({ where: { id: transfer.id }, data: { status: 'ACCEPTED', acceptedAt: now } });
        await recordAuditEvent(tx, { workspaceId: workspace.id, actorId: input.userId, action: 'workspace.ownership_transfer_accepted', targetType: 'WorkspaceOwnershipTransfer', targetId: transfer.id, metadata: { previousOwnerId: transfer.initiatedById, newOwnerId: input.userId, billingAcceptanceRequired }, ip: ctx.ip, userAgent: ctx.userAgent });
        return { workspaceId: workspace.id, billingAcceptanceRequired };
      });
    },
    async rejectOwnershipTransfer(input: { userId: string; workspaceId: string; transferId: string }, ctx): Promise<{ workspaceId: string; status: 'REJECTED' }> {
      const result = await client.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "WorkspaceOwnershipTransfer"
          WHERE "id" = ${input.transferId} AND "workspaceId" = ${input.workspaceId}
          FOR UPDATE`;
        const transfer = locked
          ? await tx.workspaceOwnershipTransfer.findUnique({ where: { id: locked.id } })
          : null;
        if (!transfer || transfer.recipientUserId !== input.userId || transfer.status !== 'PENDING') {
          throw new AppError(404, 'OWNERSHIP_TRANSFER_NOT_FOUND', 'The pending ownership transfer was not found');
        }
        await lockActiveWorkspaceAccount(tx, input.userId);
        const now = new Date();
        if (transfer.expiresAt && transfer.expiresAt <= now) {
          await tx.workspaceOwnershipTransfer.update({ where: { id: transfer.id }, data: { status: 'EXPIRED' } });
          await recordAuditEvent(tx, { workspaceId: transfer.workspaceId, actorId: input.userId, action: 'workspace.ownership_transfer_expired', targetType: 'WorkspaceOwnershipTransfer', targetId: transfer.id, ip: ctx.ip, userAgent: ctx.userAgent });
          return null;
        }
        const membership = await tx.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId: transfer.workspaceId, userId: input.userId } },
          select: { status: true },
        });
        if (!membership || membership.status !== 'ACTIVE') {
          throw new AppError(403, 'NEW_OWNER_NOT_ACTIVE', 'The recipient must be an active workspace member');
        }
        await tx.workspaceOwnershipTransfer.update({ where: { id: transfer.id }, data: { status: 'REJECTED' } });
        await recordAuditEvent(tx, { workspaceId: transfer.workspaceId, actorId: input.userId, action: 'workspace.ownership_transfer_rejected', targetType: 'WorkspaceOwnershipTransfer', targetId: transfer.id, ip: ctx.ip, userAgent: ctx.userAgent });
        return { workspaceId: transfer.workspaceId, status: 'REJECTED' as const };
      });
      if (!result) throw new AppError(409, 'OWNERSHIP_TRANSFER_EXPIRED', 'The ownership transfer has expired');
      return result;
    },
    async acceptOwnershipBilling(input: { userId: string; workspaceId: string; transferId: string }, ctx): Promise<{ workspaceId: string }> {
      return client.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "WorkspaceOwnershipTransfer"
          WHERE "id" = ${input.transferId} AND "workspaceId" = ${input.workspaceId}
          FOR UPDATE`;
        const transfer = locked
          ? await tx.workspaceOwnershipTransfer.findUnique({ where: { id: locked.id }, include: { workspace: { include: { subscription: true } } } })
          : null;
        if (!transfer || transfer.workspaceId !== input.workspaceId || transfer.recipientUserId !== input.userId || transfer.status !== 'ACCEPTED' || transfer.acceptedAt === null) throw new AppError(404, 'OWNERSHIP_TRANSFER_NOT_FOUND', 'The accepted ownership transfer was not found');
        const now = new Date();
        if (transfer.expiresAt && transfer.expiresAt <= now) throw new AppError(409, 'OWNERSHIP_TRANSFER_EXPIRED', 'The ownership transfer has expired');
        await lockWorkspaceForOwnerChange(tx, transfer.workspaceId);
        const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: transfer.workspaceId } });
        if (workspace.ownerId !== input.userId) throw new AppError(403, 'WORKSPACE_OWNER_REQUIRED', 'Only the new owner may accept billing responsibility');
        if (!transfer.workspace.subscription || transfer.workspace.subscription.status === 'CANCELLED') throw new AppError(409, 'BILLING_ACCEPTANCE_NOT_REQUIRED', 'This workspace has no active subscription to accept');
        await tx.workspaceOwnershipTransfer.update({ where: { id: transfer.id }, data: { billingAcceptedAt: now, billingAcceptedById: input.userId } });
        await tx.subscription.update({ where: { workspaceId: workspace.id }, data: { billingOwnerId: input.userId } });
        await tx.billingCancellation.updateMany({ where: { workspaceId: workspace.id, status: 'PENDING' }, data: { status: 'CANCELLED', lastError: null } });
        await tx.workspace.update({ where: { id: workspace.id }, data: { status: 'ACTIVE', deletionSuspendedAt: null } });
        await recordAuditEvent(tx, { workspaceId: workspace.id, actorId: input.userId, action: 'workspace.billing_responsibility_accepted', targetType: 'WorkspaceOwnershipTransfer', targetId: transfer.id, metadata: { billingOwnerId: input.userId }, ip: ctx.ip, userAgent: ctx.userAgent });
        return { workspaceId: workspace.id };
      });
    },
    async resolveDeletedOwner(input: { actorId: string; workspaceId: string; newOwnerId: string }, ctx): Promise<{ workspaceId: string; status: 'SUSPENDED' }> {
      return client.$transaction(async (tx) => {
        const admin = await tx.user.findUnique({ where: { id: input.actorId }, select: { isPlatformAdmin: true, status: true, deletedAt: true } });
        if (!admin?.isPlatformAdmin || admin.status !== 'ACTIVE' || admin.deletedAt) throw new AppError(403, 'PLATFORM_ADMIN_REQUIRED', 'A platform administrator is required');
        const workspace = await lockWorkspaceForOwnerChange(tx, input.workspaceId);
        const formerOwner = await tx.user.findUnique({ where: { id: workspace.ownerId }, select: { status: true, deletedAt: true, scheduledDeletionAt: true } });
        if (!formerOwner?.deletedAt || formerOwner.status !== 'DEACTIVATED' || !formerOwner.scheduledDeletionAt || formerOwner.scheduledDeletionAt > new Date()) throw new AppError(409, 'OWNER_RECOVERY_PERIOD_ACTIVE', 'Ownership can be resolved only after final account deletion');
        const recipient = await tx.user.findUnique({ where: { id: input.newOwnerId }, select: { status: true, deletedAt: true } });
        const membership = await tx.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: input.newOwnerId } } });
        if (!recipient || recipient.status !== 'ACTIVE' || recipient.deletedAt || !membership || membership.status !== 'ACTIVE') throw new AppError(409, 'NEW_OWNER_NOT_ACTIVE', 'The new owner must be an active workspace member');
        await tx.workspaceMembership.update({ where: { id: membership.id }, data: { role: 'OWNER', organizationRole: ownerOrganizationRole(workspace.type) } });
        await tx.workspace.update({ where: { id: workspace.id }, data: { ownerId: input.newOwnerId, status: 'SUSPENDED', deletionSuspendedAt: null } });
        await recordAuditEvent(tx, { workspaceId: workspace.id, actorId: input.actorId, action: 'workspace.administrator_owner_assigned', targetType: 'Workspace', targetId: workspace.id, metadata: { formerOwnerId: workspace.ownerId, newOwnerId: input.newOwnerId }, ip: ctx.ip, userAgent: ctx.userAgent });
        return { workspaceId: workspace.id, status: 'SUSPENDED' };
      });
    },
  };
}
