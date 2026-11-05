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
  visibility: 'PRIVATE',
  startDate: null,
  dueDate: null,
  ownerId: 'owner-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
} as unknown as Project;

function policyClient(
  options: {
    team?: { id: string } | null;
    teamMembership?: { id: string } | null;
    projectMembership?: { id: string; role: 'PROJECT_MANAGER' | 'MEMBER' | 'VIEWER' } | null;
  } = {},
): PrismaClient {
  return {
    project: { findFirst: async () => project },
    workspaceMembership: {
      findUnique: async () => ({
        status: 'ACTIVE',
        role: 'MEMBER',
        organizationRole: null,
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
