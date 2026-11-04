import { Prisma, type PrismaClient, type WorkspaceType } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { AppError } from '../../utils/errors';
import { requireWorkspaceAccess, WorkspaceCapability } from '../authorization';
import type {
  CreateInstitutionGroupInput,
  UpdateCompanyProfileInput,
  UpdateInstitutionGroupInput,
  UpdateInstitutionProfileInput,
} from './organization.schemas';

type Context = { ip?: string; userAgent?: string };

function assertType(type: WorkspaceType, expected: WorkspaceType): void {
  if (type !== expected) {
    throw new AppError(
      404,
      'ORGANIZATION_PROFILE_NOT_FOUND',
      'That organization profile does not exist',
    );
  }
}

function assertOrganizationAdmin(access: Awaited<ReturnType<typeof requireWorkspaceAccess>>): void {
  const role = access.membership.organizationRole;
  const allowed = role
    ? role === 'COMPANY_OWNER' ||
      role === 'COMPANY_ADMIN' ||
      role === 'INSTITUTION_OWNER' ||
      role === 'INSTITUTION_ADMIN'
    : access.membership.role === 'OWNER' || access.membership.role === 'PROJECT_MANAGER';
  if (!allowed) {
    throw new AppError(
      403,
      'INSUFFICIENT_ROLE',
      'Only organization owners and administrators may change these settings',
    );
  }
}

function jsonField(value: Record<string, string> | null | undefined) {
  if (value === undefined) return undefined;
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

export function createOrganizationService(prisma?: PrismaClient) {
  const db = prisma ?? getPrismaClient();

  async function access(userId: string, workspaceId: string, write = false) {
    const result = await requireWorkspaceAccess(db, {
      userId,
      workspaceId,
      capability: write ? WorkspaceCapability.UpdateWorkspace : WorkspaceCapability.ViewWorkspace,
    });
    if (write) assertOrganizationAdmin(result);
    return result;
  }

  async function getCompanyProfile(input: { userId: string; workspaceId: string }) {
    const result = await access(input.userId, input.workspaceId);
    assertType(result.workspace.type, 'COMPANY');
    const profile = await db.companyProfile.findUnique({
      where: { workspaceId: input.workspaceId },
    });
    if (!profile)
      throw new AppError(404, 'ORGANIZATION_PROFILE_NOT_FOUND', 'Company profile was not found');
    return profile;
  }

  async function updateCompanyProfile(
    input: { userId: string; workspaceId: string } & UpdateCompanyProfileInput,
    context: Context,
  ) {
    const result = await access(input.userId, input.workspaceId, true);
    assertType(result.workspace.type, 'COMPANY');
    const { userId, workspaceId, ...changes } = input;
    const data = { ...changes, contactInformation: jsonField(changes.contactInformation) };
    return db.$transaction(async (tx) => {
      const profile = await tx.companyProfile.upsert({
        where: { workspaceId },
        create: { workspaceId, name: changes.name ?? result.workspace.name, ...data },
        update: data,
      });
      await recordAuditEvent(tx, {
        workspaceId,
        actorId: userId,
        action: 'company.profile_updated',
        targetType: 'CompanyProfile',
        targetId: profile.id,
        metadata: { fields: Object.keys(changes) },
        ...context,
      });
      return profile;
    });
  }

  async function getInstitutionProfile(input: { userId: string; workspaceId: string }) {
    const result = await access(input.userId, input.workspaceId);
    assertType(result.workspace.type, 'INSTITUTION');
    const profile = await db.institutionProfile.findUnique({
      where: { workspaceId: input.workspaceId },
    });
    if (!profile)
      throw new AppError(
        404,
        'ORGANIZATION_PROFILE_NOT_FOUND',
        'Institution profile was not found',
      );
    return profile;
  }

  async function updateInstitutionProfile(
    input: { userId: string; workspaceId: string } & UpdateInstitutionProfileInput,
    context: Context,
  ) {
    const result = await access(input.userId, input.workspaceId, true);
    assertType(result.workspace.type, 'INSTITUTION');
    const { userId, workspaceId, ...changes } = input;
    const data = { ...changes, contactInformation: jsonField(changes.contactInformation) };
    return db.$transaction(async (tx) => {
      const profile = await tx.institutionProfile.upsert({
        where: { workspaceId },
        create: { workspaceId, name: changes.name ?? result.workspace.name, ...data },
        update: data,
      });
      await recordAuditEvent(tx, {
        workspaceId,
        actorId: userId,
        action: 'institution.profile_updated',
        targetType: 'InstitutionProfile',
        targetId: profile.id,
        metadata: { fields: Object.keys(changes) },
        ...context,
      });
      return profile;
    });
  }

  async function listInstitutionGroups(input: { userId: string; workspaceId: string }) {
    const result = await access(input.userId, input.workspaceId);
    assertType(result.workspace.type, 'INSTITUTION');
    const canSeeAll =
      result.membership.organizationRole === 'INSTITUTION_OWNER' ||
      result.membership.organizationRole === 'INSTITUTION_ADMIN' ||
      (!result.membership.organizationRole &&
        ['OWNER', 'PROJECT_MANAGER'].includes(result.membership.role));
    return db.institutionGroup.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(canSeeAll ? {} : { members: { some: { userId: input.userId } } }),
      },
      include: { _count: { select: { members: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async function createInstitutionGroup(
    input: { userId: string; workspaceId: string } & CreateInstitutionGroupInput,
    context: Context,
  ) {
    const result = await access(input.userId, input.workspaceId, true);
    assertType(result.workspace.type, 'INSTITUTION');
    const { userId, workspaceId, ...data } = input;
    return db.$transaction(async (tx) => {
      if (data.leadId) await requireActiveMember(tx, workspaceId, data.leadId);
      const duplicate = await tx.institutionGroup.findUnique({
        where: { workspaceId_name: { workspaceId, name: data.name } },
      });
      if (duplicate)
        throw new AppError(
          409,
          'INSTITUTION_GROUP_EXISTS',
          'A group with that name already exists',
        );
      const group = await tx.institutionGroup.create({ data: { workspaceId, ...data } });
      if (data.leadId) {
        await tx.institutionGroupMembership.create({
          data: { groupId: group.id, userId: data.leadId, role: 'LEAD' },
        });
      }
      await recordAuditEvent(tx, {
        workspaceId,
        actorId: userId,
        action: 'institution.group_created',
        targetType: 'InstitutionGroup',
        targetId: group.id,
        metadata: { name: group.name },
        ...context,
      });
      return group;
    });
  }

  async function updateInstitutionGroup(
    input: { userId: string; workspaceId: string; groupId: string } & UpdateInstitutionGroupInput,
    context: Context,
  ) {
    const result = await access(input.userId, input.workspaceId, true);
    assertType(result.workspace.type, 'INSTITUTION');
    const { userId, workspaceId, groupId, ...data } = input;
    return db.$transaction(async (tx) => {
      const existing = await requireGroup(tx, workspaceId, groupId);
      if (data.leadId) await requireActiveMember(tx, workspaceId, data.leadId);
      if (data.name && data.name !== existing.name) {
        const duplicate = await tx.institutionGroup.findUnique({
          where: { workspaceId_name: { workspaceId, name: data.name } },
        });
        if (duplicate)
          throw new AppError(
            409,
            'INSTITUTION_GROUP_EXISTS',
            'A group with that name already exists',
          );
      }
      const group = await tx.institutionGroup.update({ where: { id: existing.id }, data });
      if (data.leadId !== undefined) {
        if (existing.leadId && existing.leadId !== data.leadId) {
          await tx.institutionGroupMembership.updateMany({
            where: { groupId, userId: existing.leadId, role: 'LEAD' },
            data: { role: 'MEMBER' },
          });
        }
        if (data.leadId) {
          await tx.institutionGroupMembership.upsert({
            where: { groupId_userId: { groupId, userId: data.leadId } },
            create: { groupId, userId: data.leadId, role: 'LEAD' },
            update: { role: 'LEAD' },
          });
        }
      }
      await recordAuditEvent(tx, {
        workspaceId,
        actorId: userId,
        action: 'institution.group_updated',
        targetType: 'InstitutionGroup',
        targetId: groupId,
        metadata: { fields: Object.keys(data) },
        ...context,
      });
      return group;
    });
  }

  async function deleteInstitutionGroup(
    input: { userId: string; workspaceId: string; groupId: string },
    context: Context,
  ) {
    const result = await access(input.userId, input.workspaceId, true);
    assertType(result.workspace.type, 'INSTITUTION');
    return db.$transaction(async (tx) => {
      const group = await requireGroup(tx, input.workspaceId, input.groupId);
      await tx.institutionGroup.delete({ where: { id: group.id } });
      await recordAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'institution.group_deleted',
        targetType: 'InstitutionGroup',
        targetId: group.id,
        metadata: { name: group.name },
        ...context,
      });
      return { id: group.id, deleted: true };
    });
  }

  async function addInstitutionGroupMember(
    input: {
      userId: string;
      workspaceId: string;
      groupId: string;
      targetUserId: string;
      role: 'LEAD' | 'MEMBER';
    },
    context: Context,
  ) {
    const result = await access(input.userId, input.workspaceId, true);
    assertType(result.workspace.type, 'INSTITUTION');
    return db.$transaction(async (tx) => {
      const group = await requireGroup(tx, input.workspaceId, input.groupId);
      await requireActiveMember(tx, input.workspaceId, input.targetUserId);
      const duplicate = await tx.institutionGroupMembership.findUnique({
        where: { groupId_userId: { groupId: group.id, userId: input.targetUserId } },
      });
      if (duplicate)
        throw new AppError(
          409,
          'GROUP_MEMBER_EXISTS',
          'That user is already a member of the group',
        );
      if (input.role === 'LEAD') {
        if (group.leadId && group.leadId !== input.targetUserId) {
          await tx.institutionGroupMembership.updateMany({
            where: { groupId: group.id, userId: group.leadId, role: 'LEAD' },
            data: { role: 'MEMBER' },
          });
        }
      }
      const member = await tx.institutionGroupMembership.upsert({
        where: { groupId_userId: { groupId: group.id, userId: input.targetUserId } },
        create: { groupId: group.id, userId: input.targetUserId, role: input.role },
        update: { role: input.role },
      });
      if (input.role === 'LEAD') {
        await tx.institutionGroup.update({
          where: { id: group.id },
          data: { leadId: input.targetUserId },
        });
      } else if (group.leadId === input.targetUserId) {
        await tx.institutionGroup.update({ where: { id: group.id }, data: { leadId: null } });
      }
      await recordAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'institution.group_member_added',
        targetType: 'InstitutionGroupMembership',
        targetId: member.id,
        metadata: { groupId: group.id, targetUserId: input.targetUserId, role: input.role },
        ...context,
      });
      await createNotification(tx, {
        userId: input.targetUserId,
        type: 'MEMBERSHIP_CHANGED',
        title: 'Added to an institution group',
        body: group.name,
        link: `/workspaces/${input.workspaceId}/institution-groups/${group.id}`,
        data: { workspaceId: input.workspaceId, groupId: group.id },
      });
      return member;
    });
  }

  async function removeInstitutionGroupMember(
    input: { userId: string; workspaceId: string; groupId: string; targetUserId: string },
    context: Context,
  ) {
    const result = await access(input.userId, input.workspaceId, true);
    assertType(result.workspace.type, 'INSTITUTION');
    return db.$transaction(async (tx) => {
      const group = await requireGroup(tx, input.workspaceId, input.groupId);
      const member = await tx.institutionGroupMembership.findUnique({
        where: { groupId_userId: { groupId: group.id, userId: input.targetUserId } },
      });
      if (!member)
        throw new AppError(404, 'GROUP_MEMBER_NOT_FOUND', 'That group member does not exist');
      await tx.institutionGroupMembership.delete({ where: { id: member.id } });
      if (group.leadId === input.targetUserId) {
        await tx.institutionGroup.update({ where: { id: group.id }, data: { leadId: null } });
      }
      await recordAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'institution.group_member_removed',
        targetType: 'InstitutionGroupMembership',
        targetId: member.id,
        metadata: { groupId: group.id, targetUserId: input.targetUserId },
        ...context,
      });
      await createNotification(tx, {
        userId: input.targetUserId,
        type: 'MEMBERSHIP_CHANGED',
        title: 'Removed from an institution group',
        body: group.name,
        data: { workspaceId: input.workspaceId, groupId: group.id },
      });
      return { userId: input.targetUserId, removed: true };
    });
  }

  async function updateInstitutionGroupMember(
    input: {
      userId: string;
      workspaceId: string;
      groupId: string;
      targetUserId: string;
      role: 'LEAD' | 'MEMBER';
    },
    context: Context,
  ) {
    const result = await access(input.userId, input.workspaceId, true);
    assertType(result.workspace.type, 'INSTITUTION');
    return db.$transaction(async (tx) => {
      const group = await requireGroup(tx, input.workspaceId, input.groupId);
      const membership = await tx.institutionGroupMembership.findUnique({
        where: { groupId_userId: { groupId: group.id, userId: input.targetUserId } },
      });
      if (!membership)
        throw new AppError(404, 'GROUP_MEMBER_NOT_FOUND', 'That group member does not exist');
      if (input.role === 'LEAD' && group.leadId && group.leadId !== input.targetUserId) {
        await tx.institutionGroupMembership.updateMany({
          where: { groupId: group.id, userId: group.leadId, role: 'LEAD' },
          data: { role: 'MEMBER' },
        });
      }
      const updated = await tx.institutionGroupMembership.update({
        where: { id: membership.id },
        data: { role: input.role },
      });
      await tx.institutionGroup.update({
        where: { id: group.id },
        data: {
          leadId:
            input.role === 'LEAD'
              ? input.targetUserId
              : group.leadId === input.targetUserId
                ? null
                : group.leadId,
        },
      });
      await recordAuditEvent(tx, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'institution.group_member_role_changed',
        targetType: 'InstitutionGroupMembership',
        targetId: membership.id,
        metadata: { groupId: group.id, targetUserId: input.targetUserId, role: input.role },
        ...context,
      });
      await createNotification(tx, {
        userId: input.targetUserId,
        type: 'MEMBERSHIP_CHANGED',
        title: 'Your institution group role changed',
        body: group.name,
        data: { workspaceId: input.workspaceId, groupId: group.id, role: input.role },
      });
      return updated;
    });
  }

  async function listInstitutionGroupMembers(input: {
    userId: string;
    workspaceId: string;
    groupId: string;
  }) {
    const result = await access(input.userId, input.workspaceId);
    assertType(result.workspace.type, 'INSTITUTION');
    const group = await requireGroup(db, input.workspaceId, input.groupId);
    const admin =
      result.membership.organizationRole === 'INSTITUTION_OWNER' ||
      result.membership.organizationRole === 'INSTITUTION_ADMIN' ||
      (!result.membership.organizationRole &&
        ['OWNER', 'PROJECT_MANAGER'].includes(result.membership.role));
    if (!admin) {
      const visibleGroup = await db.institutionGroup.findFirst({
        where: {
          id: group.id,
          workspaceId: input.workspaceId,
          members: { some: { userId: input.userId } },
        },
      });
      if (!visibleGroup)
        throw new AppError(
          404,
          'INSTITUTION_GROUP_NOT_FOUND',
          'That institution group does not exist',
        );
    }
    return db.institutionGroupMembership.findMany({
      where: { groupId: group.id },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  return {
    getCompanyProfile,
    updateCompanyProfile,
    getInstitutionProfile,
    updateInstitutionProfile,
    listInstitutionGroups,
    createInstitutionGroup,
    updateInstitutionGroup,
    deleteInstitutionGroup,
    listInstitutionGroupMembers,
    addInstitutionGroupMember,
    updateInstitutionGroupMember,
    removeInstitutionGroupMember,
  };
}

async function requireGroup(
  client: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
  groupId: string,
) {
  const group = await client.institutionGroup.findFirst({ where: { id: groupId, workspaceId } });
  if (!group)
    throw new AppError(404, 'INSTITUTION_GROUP_NOT_FOUND', 'That institution group does not exist');
  return group;
}

async function requireActiveMember(
  client: PrismaClient | Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
) {
  const member = await client.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    include: { user: { select: { status: true } } },
  });
  if (!member || member.status !== 'ACTIVE' || member.user.status !== 'ACTIVE') {
    throw new AppError(
      400,
      'GROUP_MEMBER_NOT_ACTIVE',
      'The selected user is not an active institution member',
    );
  }
  return member;
}
