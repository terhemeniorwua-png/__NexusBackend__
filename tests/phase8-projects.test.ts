import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProjectSchema,
  updateProjectSchema,
  listProjectsQuerySchema,
  createProjectMilestoneSchema,
  updateProjectMilestoneSchema,
  transferProjectOwnershipSchema,
} from '../src/modules/projects/project.schemas';
import {
  organizationRoleCanOwnProjects,
  ProjectCapability,
  projectRoleCan,
  workspaceRoleCanOnProject,
} from '../src/modules/authorization/project.policy';

const teamId = '11111111-1111-4111-8111-111111111111';

test('project creation validates each supported visibility and requires a parent for department/team scope', () => {
  for (const visibility of ['PRIVATE', 'WORKSPACE'] as const) {
    assert.equal(
      createProjectSchema.safeParse({ name: 'Project One', key: 'one', visibility }).success,
      true,
    );
  }
  assert.equal(
    createProjectSchema.safeParse({ name: 'Scoped', key: 'scoped', visibility: 'DEPARTMENT_TEAM' })
      .success,
    false,
  );
  assert.equal(
    createProjectSchema.safeParse({
      name: 'Scoped',
      key: 'scoped',
      visibility: 'DEPARTMENT_TEAM',
      teamId,
    }).success,
    true,
  );
});

test('project creation rejects client-controlled ownership and unknown fields', () => {
  const result = createProjectSchema.safeParse({
    name: 'Project One',
    key: 'one',
    ownerId: 'user-controlled',
  });
  assert.equal(result.success, false);
});

test('project updates are non-empty, strict and validate visibility scope', () => {
  assert.equal(updateProjectSchema.safeParse({}).success, false);
  assert.equal(updateProjectSchema.safeParse({ ownerId: 'user-controlled' }).success, false);
  assert.equal(updateProjectSchema.safeParse({ visibility: 'DEPARTMENT_TEAM' }).success, true);
  assert.equal(updateProjectSchema.safeParse({ status: 'ACTIVE' }).success, true);
});

test('project listing validates pagination, filters and archive flag', () => {
  const result = listProjectsQuerySchema.safeParse({
    limit: '20',
    visibility: 'DEPARTMENT_TEAM',
    includeArchived: 'true',
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.limit, 20);
    assert.equal(result.data.includeArchived, true);
  }
  assert.equal(listProjectsQuerySchema.safeParse({ limit: 101 }).success, false);
});

test('project category and labels are bounded and reject client-controlled fields', () => {
  assert.equal(
    createProjectSchema.safeParse({
      name: 'Project One',
      key: 'one',
      category: 'Delivery',
      labels: ['urgent'],
    }).success,
    true,
  );
  assert.equal(
    createProjectSchema.safeParse({
      name: 'Project One',
      key: 'one',
      labels: Array(31).fill('label'),
    }).success,
    false,
  );
  assert.equal(
    updateProjectSchema.safeParse({ visibility: 'PRIVATE', ownerId: 'client' }).success,
    false,
  );
});

test('milestone schemas validate mutation fields and reject empty/unknown updates', () => {
  assert.equal(
    createProjectMilestoneSchema.safeParse({ name: 'Launch', position: 1 }).success,
    true,
  );
  assert.equal(
    createProjectMilestoneSchema.safeParse({ name: 'Launch', completedAt: '2026-12-01T00:00:00Z' })
      .success,
    false,
  );
  assert.equal(updateProjectMilestoneSchema.safeParse({}).success, false);
  assert.equal(updateProjectMilestoneSchema.safeParse({ completed: true }).success, true);
  assert.equal(
    createProjectMilestoneSchema.safeParse({ name: 'Launch', dueDate: 'not-a-date' }).success,
    false,
  );
  assert.equal(
    createProjectSchema.safeParse({
      name: 'Project One',
      key: 'one',
      startDate: '2026-12-02T00:00:00Z',
      dueDate: '2026-12-01T00:00:00Z',
    }).success,
    false,
  );
});

test('ownership transfer defaults the former owner to MANAGER and rejects client fields', () => {
  const result = transferProjectOwnershipSchema.safeParse({ newOwnerId: teamId });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.previousOwnerRole, 'MANAGER');
  assert.equal(
    transferProjectOwnershipSchema.safeParse({ newOwnerId: teamId, role: 'PROJECT_MANAGER' })
      .success,
    false,
  );
  assert.equal(
    transferProjectOwnershipSchema.safeParse({ newOwnerId: teamId, previousOwnerRole: 'REMOVE' })
      .success,
    true,
  );
});

test('organization role caps decide which members may receive project ownership', () => {
  assert.equal(organizationRoleCanOwnProjects(null), true);
  assert.equal(organizationRoleCanOwnProjects('COMPANY_OWNER'), true);
  assert.equal(organizationRoleCanOwnProjects('COMPANY_ADMIN'), true);
  assert.equal(organizationRoleCanOwnProjects('COMPANY_PROJECT_MANAGER'), true);
  assert.equal(organizationRoleCanOwnProjects('COMPANY_MEMBER'), false);
  assert.equal(organizationRoleCanOwnProjects('COMPANY_VIEWER'), false);
  assert.equal(organizationRoleCanOwnProjects('INSTITUTION_DEPARTMENT_HEAD'), false);
});

test('project role capability matrix enforces project management, membership and milestone permissions', () => {
  const actions = [
    ProjectCapability.ViewProject,
    ProjectCapability.UpdateProject,
    ProjectCapability.ArchiveProject,
    ProjectCapability.DeleteProject,
    ProjectCapability.ManageMembers,
    ProjectCapability.CreateTask,
    ProjectCapability.ViewTasks,
  ] as const;
  const matrix = {
    PROJECT_MANAGER: [true, true, true, false, true, true, true],
    MEMBER: [true, false, false, false, false, true, true],
    VIEWER: [true, false, false, false, false, false, true],
  } as const;
  for (const role of ['PROJECT_MANAGER', 'MEMBER', 'VIEWER'] as const) {
    actions.forEach((action, index) =>
      assert.equal(projectRoleCan(role, action), matrix[role][index], `${role} ${action}`),
    );
  }
  for (const role of ['OWNER', 'PROJECT_MANAGER'] as const) {
    assert.equal(workspaceRoleCanOnProject(role, ProjectCapability.UpdateProject), true);
    assert.equal(workspaceRoleCanOnProject(role, ProjectCapability.DeleteProject), true);
  }
  for (const role of ['MEMBER', 'COLLABORATOR', 'VIEWER'] as const) {
    assert.equal(workspaceRoleCanOnProject(role, ProjectCapability.UpdateProject), false);
    assert.equal(workspaceRoleCanOnProject(role, ProjectCapability.ViewProject), false);
  }
});
