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
  teamId: null,
  departmentId: null,
  name: 'Task Test Project',
  key: 'TASK',
  description: null,
  category: null,
  labels: [],
  status: 'ACTIVE',
  visibility: 'WORKSPACE',
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
    projectMembership?: { id: string; role: 'PROJECT_MANAGER' | 'MEMBER' | 'VIEWER' } | null;
  } = {},
): PrismaClient {
  return {
    project: { findFirst: async () => options.project ?? project },
    workspaceMembership: {
      findUnique: async () => ({
        status: 'ACTIVE',
        role: 'MEMBER',
        organizationRole: null,
        workspace: { type: 'COMPANY' },
      }),
    },
    team: { findFirst: async () => null },
    teamMembership: { findUnique: async () => null },
    department: { findFirst: async () => null },
    departmentMembership: { findUnique: async () => null },
    projectMembership: {
      findUnique: async () => options.projectMembership ?? null,
    },
  } as unknown as PrismaClient;
}

test('ViewTasks capability is available for workspace members on WORKSPACE projects', async () => {
  // A workspace member without project membership can view tasks on a
  // WORKSPACE-visibility project (WORKSPACE bypass applies to ViewProject,
  // which is the capability used for listing/viewing tasks).
  const access = await requireProjectAccess(policyClient(), {
    userId: 'member-1',
    workspaceId: project.workspaceId,
    projectId: project.id,
    workspaceRole: 'MEMBER',
    capability: ProjectCapability.ViewProject,
  });
  assert.equal(access.project.id, project.id);
});

test('CreateTask capability requires project membership on WORKSPACE projects', async () => {
  // CreateTask maps to 'project:create_task'. A workspace MEMBER has no
  // project:create_task capability from their workspace role alone.
  // Without explicit project membership, the access should be denied.
  await assert.rejects(
    requireProjectAccess(policyClient(), {
      userId: 'member-1',
      workspaceId: project.workspaceId,
      projectId: project.id,
      workspaceRole: 'MEMBER',
      capability: ProjectCapability.CreateTask,
    }),
    (error: unknown) => {
      const code = (error as { code?: string }).code;
      return code === 'PROJECT_ACCESS_DENIED' || code === 'PROJECT_NOT_FOUND';
    },
  );
});

test('CreateTask is allowed for project members with MEMBER role', async () => {
  const access = await requireProjectAccess(
    policyClient({ projectMembership: { id: 'pm-1', role: 'MEMBER' } }),
    {
      userId: 'member-1',
      workspaceId: project.workspaceId,
      projectId: project.id,
      workspaceRole: 'MEMBER',
      capability: ProjectCapability.CreateTask,
    },
  );
  assert.equal(access.project.id, project.id);
  assert.equal(access.projectMembership?.id, 'pm-1');
});

test('ManageTask is allowed for project managers', async () => {
  const access = await requireProjectAccess(
    policyClient({ projectMembership: { id: 'pm-1', role: 'PROJECT_MANAGER' } }),
    {
      userId: 'pm-1',
      workspaceId: project.workspaceId,
      projectId: project.id,
      workspaceRole: 'MEMBER',
      capability: ProjectCapability.ManageTask,
    },
  );
  assert.equal(access.project.id, project.id);
});

test('ManageTask is denied for VIEWER project members', async () => {
  await assert.rejects(
    requireProjectAccess(
      policyClient({ projectMembership: { id: 'pm-1', role: 'VIEWER' } }),
      {
        userId: 'viewer-1',
        workspaceId: project.workspaceId,
        projectId: project.id,
        workspaceRole: 'MEMBER',
        capability: ProjectCapability.ManageTask,
      },
    ),
    (error: unknown) => (error as { code?: string }).code === 'INSUFFICIENT_PROJECT_ROLE',
  );
});

test('task access on a PRIVATE project requires explicit membership', async () => {
  const privateProject = { ...project, visibility: 'PRIVATE' } as Project;
  await assert.rejects(
    requireProjectAccess(policyClient({ project: privateProject }), {
      userId: 'outsider-1',
      workspaceId: project.workspaceId,
      projectId: project.id,
      workspaceRole: 'MEMBER',
      capability: ProjectCapability.ViewProject,
    }),
    (error: unknown) => (error as { code?: string }).code === 'PROJECT_NOT_FOUND',
  );
});
