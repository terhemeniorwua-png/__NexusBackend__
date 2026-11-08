import type { Department, DepartmentMembership, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { isOrganizationAdminRole, isOrganizationOwnerRole } from './organization-role';

export const DepartmentCapability = {
  View: 'department:view',
  Update: 'department:update',
  ManageMembers: 'department:manage_members',
  ManageTeams: 'department:manage_teams',
  ManageProjects: 'department:manage_projects',
} as const;

export type DepartmentCapabilityValue =
  (typeof DepartmentCapability)[keyof typeof DepartmentCapability];

export interface DepartmentAccess {
  department: Department;
  membership: DepartmentMembership | null;
}

export async function requireDepartmentAccess(
  client: PrismaClient,
  input: {
    userId: string;
    workspaceId: string;
    departmentId: string;
    capability: DepartmentCapabilityValue;
  },
): Promise<DepartmentAccess> {
  const department = await client.department.findFirst({
    where: { id: input.departmentId, workspaceId: input.workspaceId },
  });
  if (!department) {
    throw new AppError(404, 'DEPARTMENT_NOT_FOUND', 'That department does not exist');
  }

  const workspaceMembership = await client.workspaceMembership.findUnique({
    where: {
      workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId },
    },
    include: { workspace: { select: { type: true } } },
  });
  if (!workspaceMembership || workspaceMembership.status !== 'ACTIVE') {
    throw new AppError(403, 'WORKSPACE_ACCESS_DENIED', 'You are not an active workspace member');
  }
  if (workspaceMembership.workspace.type !== 'INSTITUTION') {
    throw new AppError(404, 'DEPARTMENT_NOT_FOUND', 'That department does not exist');
  }

  const organizationAdministrator =
    isOrganizationOwnerRole(workspaceMembership.organizationRole) ||
    isOrganizationAdminRole(workspaceMembership.organizationRole) ||
    (!workspaceMembership.organizationRole &&
      (workspaceMembership.role === 'OWNER' || workspaceMembership.role === 'PROJECT_MANAGER'));
  if (organizationAdministrator) return { department, membership: null };

  const departmentMembership = await client.departmentMembership.findUnique({
    where: {
      departmentId_userId: { departmentId: department.id, userId: input.userId },
    },
  });
  if (!departmentMembership) {
    throw new AppError(403, 'DEPARTMENT_ACCESS_DENIED', 'You are not assigned to this department');
  }

  if (departmentMembership.role === 'HEAD') return { department, membership: departmentMembership };
  if (input.capability !== DepartmentCapability.View) {
    throw new AppError(
      403,
      'INSUFFICIENT_DEPARTMENT_ROLE',
      'Your department role does not allow this action',
    );
  }
  return { department, membership: departmentMembership };
}
