import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient, Project } from '@prisma/client';
import {
  ProjectCapability,
  requireProjectAccess,
} from '../src/modules/authorization/project.policy';

const project = {
  id: 'project-1',
  workspaceId: 'workspace-1',
  teamId: 'team-1',
  departmentId: null,
  name: 'Team project',
  key: 'TEAM',
  description: null,
  status: 'ACTIVE',
  visibility: 'DEPARTMENT_TEAM',
  startDate: null,
  dueDate: null,
  ownerId: 'owner-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
} as unknown as Project;

function policyClient(
  options: {
    project?: Project;
    team?: { id: string } | null;
    teamMembership?: { id: string } | null;
    department?: { id: string } | null;
    departmentMembership?: { id: string } | null;
    projectMembership?: { id: string; role: 'PROJECT_MANAGER' | 'MEMBER' | 'VIEWER' } | null;
    organizationRole?: 'COMPANY_ADMIN' | 'COMPANY_OWNER' | null;
  } = {},
): PrismaClient {
  return {
    project: { findFirst: async () => options.project ?? project },
    workspaceMembership: {
      findUnique: async () => ({
        status: 'ACTIVE',
        role: 'MEMBER',
        organizationRole: options.organizationRole ?? null,
        workspace: { type: 'COMPANY' },
      }),
    },
    team: {
      findFirst: async ({ where }: { where: { workspaceId: string } }) => {
        assert.equal(where.workspaceId, project.workspaceId);
        return options.team === undefined ? { id: 'team-1' } : options.team;
      },
    },
    teamMembership: {
      findUnique: async () => options.teamMembership ?? null,
    },
    department: {
      findFirst: async ({ where }: { where: { workspaceId: string } }) => {
        assert.equal(where.workspaceId, project.workspaceId);
        return options.department ?? { id: 'department-1' };
      },
    },
    departmentMembership: {
      findUnique: async () => options.departmentMembership ?? null,
    },
    projectMembership: {
      findUnique: async () => options.projectMembership ?? null,
    },
  } as unknown as PrismaClient;
}

test('active members of a project-associated team receive base project access', async () => {
  const client = policyClient({ teamMembership: { id: 'team-member-1' } });
  const access = await requireProjectAccess(client, {
    userId: 'member-1',
    workspaceId: 'workspace-1',
    projectId: project.id,
    workspaceRole: 'MEMBER',
    capability: ProjectCapability.ViewProject,
  });

  assert.equal(access.project.id, project.id);
  assert.equal(access.projectMembership, null);
  await assert.rejects(
    requireProjectAccess(client, {
      userId: 'member-1',
      workspaceId: 'workspace-1',
      projectId: project.id,
      workspaceRole: 'MEMBER',
      capability: ProjectCapability.UpdateProject,
    }),
    (error: unknown) => (error as { code?: string }).code === 'INSUFFICIENT_PROJECT_ROLE',
  );
});

test('an associated team does not grant access to users outside that team', async () => {
  await assert.rejects(
    requireProjectAccess(policyClient(), {
      userId: 'outsider-1',
      workspaceId: 'workspace-1',
      projectId: project.id,
      workspaceRole: 'MEMBER',
      capability: ProjectCapability.ViewProject,
    }),
    (error: unknown) => (error as { code?: string }).code === 'PROJECT_NOT_FOUND',
  );
});

test('explicit project membership remains valid for a separately invited workspace member', async () => {
  const access = await requireProjectAccess(
    policyClient({ projectMembership: { id: 'project-member-1', role: 'VIEWER' } }),
    {
      userId: 'invited-member-1',
      workspaceId: 'workspace-1',
      projectId: project.id,
      workspaceRole: 'MEMBER',
      capability: ProjectCapability.ViewProject,
    },
  );

  assert.equal(access.projectMembership?.id, 'project-member-1');
});

test('the explicit project owner can manage their private project', async () => {
  const privateProject = { ...project, visibility: 'PRIVATE' } as Project;
  const access = await requireProjectAccess(policyClient({ project: privateProject }), {
    userId: project.ownerId,
    workspaceId: project.workspaceId,
    projectId: project.id,
    workspaceRole: 'MEMBER',
    capability: ProjectCapability.UpdateProject,
  });

  assert.equal(access.project.ownerId, project.ownerId);
  assert.equal(access.projectMembership, null);
});

test('team association cannot grant project access across workspace boundaries', async () => {
  await assert.rejects(
    requireProjectAccess(
      policyClient({ team: null, teamMembership: { id: 'foreign-team-member' } }),
      {
        userId: 'member-1',
        workspaceId: 'workspace-1',
        projectId: project.id,
        workspaceRole: 'MEMBER',
        capability: ProjectCapability.ViewProject,
      },
    ),
    (error: unknown) => (error as { code?: string }).code === 'PROJECT_NOT_FOUND',
  );
});

test('department-only project access is inherited by same-department members', async () => {
  const departmentProject = { ...project, teamId: null, departmentId: 'department-1' } as Project;
  const access = await requireProjectAccess(
    policyClient({
      project: departmentProject,
      departmentMembership: { id: 'department-member-1' },
    }),
    {
      userId: 'department-member-1',
      workspaceId: project.workspaceId,
      projectId: project.id,
      workspaceRole: 'MEMBER',
      capability: ProjectCapability.ViewProject,
    },
  );
  assert.equal(access.project.id, project.id);
});

test('team scope takes precedence over department membership', async () => {
  const departmentProject = { ...project, departmentId: 'department-1' } as Project;
  await assert.rejects(
    requireProjectAccess(
      policyClient({
        project: departmentProject,
        departmentMembership: { id: 'department-member-1' },
      }),
      {
        userId: 'department-member-1',
        workspaceId: project.workspaceId,
        projectId: project.id,
        workspaceRole: 'MEMBER',
        capability: ProjectCapability.ViewProject,
      },
    ),
    (error: unknown) => (error as { code?: string }).code === 'PROJECT_NOT_FOUND',
  );
});

test('WORKSPACE projects are readable by active workspace members without project membership', async () => {
  const workspaceProject = {
    ...project,
    teamId: null,
    departmentId: null,
    visibility: 'WORKSPACE',
  } as Project;
  const access = await requireProjectAccess(policyClient({ project: workspaceProject }), {
    userId: 'workspace-member-1',
    workspaceId: project.workspaceId,
    projectId: project.id,
    workspaceRole: 'MEMBER',
    capability: ProjectCapability.ViewProject,
  });
  assert.equal(access.project.visibility, 'WORKSPACE');
  await assert.rejects(
    requireProjectAccess(policyClient({ project: workspaceProject }), {
      userId: 'workspace-member-1',
      workspaceId: project.workspaceId,
      projectId: project.id,
      workspaceRole: 'MEMBER',
      capability: ProjectCapability.UpdateProject,
    }),
    (error: unknown) => (error as { code?: string }).code === 'PROJECT_ACCESS_DENIED',
  );
});

test('an organization administrator does not receive implicit access to a private project', async () => {
  const privateProject = {
    ...project,
    teamId: null,
    departmentId: null,
    visibility: 'PRIVATE',
  } as Project;
  await assert.rejects(
    requireProjectAccess(
      policyClient({ project: privateProject, organizationRole: 'COMPANY_ADMIN' }),
      {
        userId: 'organization-admin-1',
        workspaceId: project.workspaceId,
        projectId: project.id,
        workspaceRole: 'PROJECT_MANAGER',
        capability: ProjectCapability.ViewProject,
      },
    ),
    (error: unknown) => (error as { code?: string }).code === 'PROJECT_NOT_FOUND',
  );
});

test('team and department membership do not grant access to private projects', async () => {
  const privateProject = { ...project, visibility: 'PRIVATE' } as Project;
  await assert.rejects(
    requireProjectAccess(
      policyClient({ project: privateProject, teamMembership: { id: 'team-member-1' } }),
      {
        userId: 'team-member-1',
        workspaceId: project.workspaceId,
        projectId: project.id,
        workspaceRole: 'MEMBER',
        capability: ProjectCapability.ViewProject,
      },
    ),
    (error: unknown) => (error as { code?: string }).code === 'PROJECT_NOT_FOUND',
  );

  const privateDepartmentProject = {
    ...privateProject,
    teamId: null,
    departmentId: 'department-1',
  } as Project;
  await assert.rejects(
    requireProjectAccess(
      policyClient({
        project: privateDepartmentProject,
        departmentMembership: { id: 'dept-member' },
      }),
      {
        userId: 'dept-member',
        workspaceId: project.workspaceId,
        projectId: project.id,
        workspaceRole: 'MEMBER',
        capability: ProjectCapability.ViewProject,
      },
    ),
    (error: unknown) => (error as { code?: string }).code === 'PROJECT_NOT_FOUND',
  );
});

test('DEPARTMENT_TEAM projects require explicit project or current parent membership', async () => {
  const scopedProject = { ...project, visibility: 'DEPARTMENT_TEAM' } as Project;
  await assert.rejects(
    requireProjectAccess(policyClient({ project: scopedProject }), {
      userId: 'outside-team-1',
      workspaceId: project.workspaceId,
      projectId: project.id,
      workspaceRole: 'MEMBER',
      capability: ProjectCapability.ViewProject,
    }),
    (error: unknown) => (error as { code?: string }).code === 'PROJECT_NOT_FOUND',
  );
  const access = await requireProjectAccess(
    policyClient({ project: scopedProject, teamMembership: { id: 'current-team-member' } }),
    {
      userId: 'current-team-member',
      workspaceId: project.workspaceId,
      projectId: project.id,
      workspaceRole: 'MEMBER',
      capability: ProjectCapability.ViewProject,
    },
  );
  assert.equal(access.project.visibility, 'DEPARTMENT_TEAM');
});
