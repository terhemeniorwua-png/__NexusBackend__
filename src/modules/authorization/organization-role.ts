import type { OrganizationRole, WorkspaceRole, WorkspaceType } from '@prisma/client';
import { AppError } from '../../utils/errors';

const COMPANY_ROLES = new Set<OrganizationRole>([
  'COMPANY_OWNER',
  'COMPANY_ADMIN',
  'COMPANY_PROJECT_MANAGER',
  'COMPANY_MEMBER',
  'COMPANY_COLLABORATOR',
  'COMPANY_VIEWER',
]);

const INSTITUTION_ROLES = new Set<OrganizationRole>([
  'INSTITUTION_OWNER',
  'INSTITUTION_ADMIN',
  'INSTITUTION_DEPARTMENT_HEAD',
  'INSTITUTION_LECTURER_STAFF',
  'INSTITUTION_STUDENT',
  'INSTITUTION_COLLABORATOR',
  'INSTITUTION_VIEWER',
]);

export function isOrganizationRoleForWorkspace(
  workspaceType: WorkspaceType,
  role: OrganizationRole,
): boolean {
  return (
    (workspaceType === 'COMPANY' && COMPANY_ROLES.has(role)) ||
    (workspaceType === 'INSTITUTION' && INSTITUTION_ROLES.has(role))
  );
}

export function requireOrganizationRoleForWorkspace(
  workspaceType: WorkspaceType,
  role: OrganizationRole,
): void {
  if (!isOrganizationRoleForWorkspace(workspaceType, role)) {
    throw new AppError(
      400,
      'ORGANIZATION_ROLE_WORKSPACE_MISMATCH',
      'This organization role cannot be assigned in this workspace type',
    );
  }
}

export function ownerOrganizationRole(workspaceType: WorkspaceType): OrganizationRole | null {
  if (workspaceType === 'COMPANY') return 'COMPANY_OWNER';
  if (workspaceType === 'INSTITUTION') return 'INSTITUTION_OWNER';
  return null;
}

export function isOrganizationOwnerRole(role: OrganizationRole | null | undefined): boolean {
  return role === 'COMPANY_OWNER' || role === 'INSTITUTION_OWNER';
}

export function isOrganizationAdminRole(role: OrganizationRole | null | undefined): boolean {
  return role === 'COMPANY_ADMIN' || role === 'INSTITUTION_ADMIN';
}

/** Maps the organization-specific role to the existing shared policy tier. */
export function effectiveWorkspaceRole(
  workspaceType: WorkspaceType,
  legacyRole: WorkspaceRole,
  organizationRole: OrganizationRole | null | undefined,
): WorkspaceRole {
  if (!organizationRole) return legacyRole;
  if (!isOrganizationRoleForWorkspace(workspaceType, organizationRole)) return 'VIEWER';

  switch (organizationRole) {
    case 'COMPANY_OWNER':
    case 'INSTITUTION_OWNER':
      return 'OWNER';
    case 'COMPANY_ADMIN':
    case 'INSTITUTION_ADMIN':
      return 'PROJECT_MANAGER';
    case 'COMPANY_MEMBER':
    case 'COMPANY_PROJECT_MANAGER':
    case 'INSTITUTION_LECTURER_STAFF':
    case 'COMPANY_COLLABORATOR':
    case 'COMPANY_VIEWER':
    case 'INSTITUTION_DEPARTMENT_HEAD':
    case 'INSTITUTION_STUDENT':
    case 'INSTITUTION_COLLABORATOR':
    case 'INSTITUTION_VIEWER':
      return organizationRole.endsWith('VIEWER') ? 'VIEWER' : 'COLLABORATOR';
  }
}

export function assertCanAssignOrganizationRole(input: {
  workspaceType: WorkspaceType;
  actorLegacyRole: WorkspaceRole;
  actorOrganizationRole: OrganizationRole | null;
  requestedRole: OrganizationRole;
}): void {
  requireOrganizationRoleForWorkspace(input.workspaceType, input.requestedRole);

  const actorIsOwner =
    isOrganizationOwnerRole(input.actorOrganizationRole) ||
    (!input.actorOrganizationRole && input.actorLegacyRole === 'OWNER');
  const actorIsAdmin =
    isOrganizationAdminRole(input.actorOrganizationRole) ||
    (!input.actorOrganizationRole && input.actorLegacyRole === 'PROJECT_MANAGER');

  if (isOrganizationOwnerRole(input.requestedRole) && !actorIsOwner) {
    throw new AppError(
      403,
      'OWNER_ROLE_REQUIRES_OWNER',
      'Only an organization owner can assign an owner role',
    );
  }

  if (!actorIsOwner && !actorIsAdmin) {
    throw new AppError(
      403,
      'INSUFFICIENT_ROLE',
      'Your organization role cannot assign member roles',
    );
  }
}

export function assertMayManageOrganizationMember(input: {
  actorLegacyRole: WorkspaceRole;
  actorOrganizationRole: OrganizationRole | null;
  targetOrganizationRole: OrganizationRole | null;
  targetLegacyRole: WorkspaceRole;
  targetIsPrimaryOwner: boolean;
}): void {
  const actorIsOwner =
    isOrganizationOwnerRole(input.actorOrganizationRole) ||
    (!input.actorOrganizationRole && input.actorLegacyRole === 'OWNER');
  const targetIsOwner =
    isOrganizationOwnerRole(input.targetOrganizationRole) ||
    (!input.targetOrganizationRole &&
      input.targetLegacyRole === 'OWNER' &&
      input.targetIsPrimaryOwner);
  const targetIsAdmin = isOrganizationAdminRole(input.targetOrganizationRole);

  if ((targetIsOwner || targetIsAdmin) && !actorIsOwner) {
    throw new AppError(
      403,
      'ORGANIZATION_OWNER_REQUIRED',
      'Only an organization owner can manage an owner or administrator',
    );
  }
}
