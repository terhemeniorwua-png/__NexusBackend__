import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import {
  PROJECT_ROLE_PERMISSIONS,
  ProjectPermission,
  assertMayManageProjectMember,
  assertNotSelfReview,
  assignableProjectRoles,
  maximumProjectRoleForMember,
  projectRoleExceedsCeiling,
} from '../src/modules/authorization/project.permissions';
import {
  authorizeProject,
  resolveProjectAuthorization,
} from '../src/modules/authorization/project.authorization';
import { effectiveWorkspaceRole } from '../src/modules/authorization/organization-role';

function projectAuthClient(overrides: Record<string, unknown> = {}): PrismaClient {
  const base = {
    project: {
      findFirst: async () => null,
    },
    workspaceMembership: {
      findUnique: async () => null,
    },
    team: { findFirst: async () => null },
    teamMembership: { findUnique: async () => null },
    department: { findFirst: async () => null },
    departmentMembership: { findUnique: async () => null },
    projectMembership: {
      findUnique: async () => null,
      count: async () => 0,
    },
    task: { findFirst: async () => null },
    taskAssignee: {},
    comment: { findFirst: async () => null },
    fileAttachment: { findFirst: async () => null },
  };
  const deepMerge = (target: any, source: any): any => {
    const out = { ...target };
    for (const [k, v] of Object.entries(source)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
        out[k] = deepMerge(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  return deepMerge(base, overrides) as unknown as PrismaClient;
}

const activeWorkspaceMembership = (role = 'MEMBER', organizationRole: any = null) => ({
  userId: 'u1',
  workspaceId: 'w1',
  role,
  organizationRole,
  status: 'ACTIVE',
  workspace: { type: 'COMPANY' },
});

describe('project permission matrix', () => {
  test('task.update never implies submission.approve', () => {
    assert.equal(PROJECT_ROLE_PERMISSIONS.MEMBER.includes(ProjectPermission.TaskUpdate), true);
    assert.equal(
      PROJECT_ROLE_PERMISSIONS.MEMBER.includes(ProjectPermission.SubmissionApprove),
      false,
    );
    assert.equal(
      PROJECT_ROLE_PERMISSIONS.PROJECT_MANAGER.includes(ProjectPermission.TaskUpdate),
      true,
    );
    assert.equal(
      PROJECT_ROLE_PERMISSIONS.PROJECT_MANAGER.includes(ProjectPermission.SubmissionApprove),
      true,
    );
  });

  test('project.delete is not granted by project roles', () => {
    for (const role of ['PROJECT_MANAGER', 'MEMBER', 'COLLABORATOR', 'VIEWER'] as const) {
      assert.equal(PROJECT_ROLE_PERMISSIONS[role].includes(ProjectPermission.Delete), false);
    }
  });

  test('collaborator cannot create or edit tasks', () => {
    assert.equal(
      PROJECT_ROLE_PERMISSIONS.COLLABORATOR.includes(ProjectPermission.TaskCreate),
      false,
    );
    assert.equal(
      PROJECT_ROLE_PERMISSIONS.COLLABORATOR.includes(ProjectPermission.TaskUpdate),
      false,
    );
    assert.equal(
      PROJECT_ROLE_PERMISSIONS.COLLABORATOR.includes(ProjectPermission.TaskComplete),
      true,
    );
  });

  test('viewer is read-only for core access', () => {
    assert.deepEqual([...PROJECT_ROLE_PERMISSIONS.VIEWER], [
      ProjectPermission.View,
      ProjectPermission.TaskView,
      ProjectPermission.ViewReport,
    ]);
  });

  test('institution role mapping and ceilings', () => {
    assert.equal(
      maximumProjectRoleForMember({
        workspaceRole: 'MEMBER',
        organizationRole: 'INSTITUTION_DEPARTMENT_HEAD',
      }),
      'PROJECT_MANAGER',
    );
    assert.equal(
      maximumProjectRoleForMember({
        workspaceRole: 'MEMBER',
        organizationRole: 'INSTITUTION_LECTURER_STAFF',
      }),
      'PROJECT_MANAGER',
    );
    assert.equal(
      maximumProjectRoleForMember({
        workspaceRole: 'MEMBER',
        organizationRole: 'INSTITUTION_STUDENT',
      }),
      'MEMBER',
    );
    assert.equal(
      maximumProjectRoleForMember({
        workspaceRole: 'MEMBER',
        organizationRole: 'INSTITUTION_COLLABORATOR',
      }),
      'COLLABORATOR',
    );
    assert.equal(
      maximumProjectRoleForMember({ workspaceRole: 'VIEWER', organizationRole: null }),
      'VIEWER',
    );
    assert.equal(
      maximumProjectRoleForMember({ workspaceRole: 'COLLABORATOR', organizationRole: null }),
      'COLLABORATOR',
    );
    assert.equal(
      maximumProjectRoleForMember({ workspaceRole: 'MEMBER', organizationRole: null }),
      'PROJECT_MANAGER',
    );
  });

  test('assignable roles respect actor role and ceiling', () => {
    assert.deepEqual(
      assignableProjectRoles({
        isWorkspaceAdmin: true,
        actorProjectRole: null,
        actorCeiling: 'PROJECT_MANAGER',
      }),
      ['PROJECT_MANAGER', 'MEMBER', 'COLLABORATOR', 'VIEWER'],
    );
    assert.deepEqual(
      assignableProjectRoles({
        isWorkspaceAdmin: false,
        actorProjectRole: 'MEMBER',
        actorCeiling: 'PROJECT_MANAGER',
      }),
      [],
    );
    assert.deepEqual(
      assignableProjectRoles({
        isWorkspaceAdmin: false,
        actorProjectRole: 'PROJECT_MANAGER',
        actorCeiling: 'PROJECT_MANAGER',
      }),
      ['PROJECT_MANAGER', 'MEMBER', 'COLLABORATOR', 'VIEWER'],
    );
  });

  test('self approval/review is forbidden', () => {
    assert.throws(
      () => assertNotSelfReview({ actorId: 'u1', subjectUserId: 'u1', action: 'approve' }),
      /cannot approve/i,
    );
    assert.doesNotThrow(() =>
      assertNotSelfReview({ actorId: 'u1', subjectUserId: 'u2', action: 'review' }),
    );
  });

  test('role ceiling violations are detected', () => {
    assert.equal(projectRoleExceedsCeiling('PROJECT_MANAGER', 'MEMBER'), true);
    assert.equal(projectRoleExceedsCeiling('MEMBER', 'MEMBER'), false);
  });

  test('organization admins map to project-manager capable workspace role', () => {
    assert.equal(effectiveWorkspaceRole('COMPANY', 'MEMBER', 'COMPANY_ADMIN'), 'PROJECT_MANAGER');
  });

  test('self-role change and escalation guards', () => {
    assert.throws(
      () =>
        assertMayManageProjectMember({
          actorId: 'u1',
          actorIsWorkspaceAdmin: false,
          actorProjectRole: 'PROJECT_MANAGER',
          targetUserId: 'u1',
          targetProjectRole: 'PROJECT_MANAGER',
          targetIsOwner: false,
          targetCeiling: 'PROJECT_MANAGER',
          requestedRole: 'MEMBER',
          action: 'update',
        }),
      /cannot change your own/i,
    );
    assert.throws(
      () =>
        assertMayManageProjectMember({
          actorId: 'u1',
          actorIsWorkspaceAdmin: false,
          actorProjectRole: 'MEMBER',
          targetUserId: 'u2',
          targetProjectRole: 'VIEWER',
          targetIsOwner: false,
          targetCeiling: 'PROJECT_MANAGER',
          requestedRole: 'PROJECT_MANAGER',
          action: 'update',
        }),
      /above your own/i,
    );
    assert.throws(
      () =>
        assertMayManageProjectMember({
          actorId: 'u1',
          actorIsWorkspaceAdmin: true,
          actorProjectRole: null,
          targetUserId: 'u2',
          targetProjectRole: 'VIEWER',
          targetIsOwner: false,
          targetCeiling: 'MEMBER',
          requestedRole: 'PROJECT_MANAGER',
          action: 'update',
        }),
      /above the target member/i,
    );
  });
});

describe('authorizeProject core behavior', () => {
  test('cross-workspace or missing project resolves to 404', async () => {
    const client = projectAuthClient({
      workspaceMembership: { findUnique: async () => activeWorkspaceMembership() },
      project: { findFirst: async () => null },
    });
    await assert.rejects(
      () =>
        resolveProjectAuthorization(
          client,
          { userId: 'u1', workspaceId: 'w1', workspaceRole: 'MEMBER' },
          'p-missing',
        ),
      (e: any) => e?.statusCode === 404 && e?.code === 'PROJECT_NOT_FOUND',
    );
  });

  test('legacy workspace admin gets implicit full access (workspace_admin)', async () => {
    const client = projectAuthClient({
      workspaceMembership: { findUnique: async () => activeWorkspaceMembership('PROJECT_MANAGER', null) },
      project: {
        findFirst: async () => ({
          id: 'p1',
          workspaceId: 'w1',
          ownerId: 'owner',
          visibility: 'PRIVATE',
          status: 'ACTIVE',
          deletedAt: null,
          teamId: null,
          departmentId: null,
        }),
      },
    });
    const auth = await resolveProjectAuthorization(
      client,
      { userId: 'u1', workspaceId: 'w1', workspaceRole: 'PROJECT_MANAGER' },
      'p1',
    );
    assert.equal(auth.accessSource, 'workspace_admin');
    assert.equal(auth.projectRole, 'PROJECT_MANAGER');
    assert.equal(auth.permissions.includes(ProjectPermission.Delete), true);
  });

  test('org admin (organization role) does not get implicit private access', async () => {
    const client = projectAuthClient({
      workspaceMembership: { findUnique: async () => activeWorkspaceMembership('MEMBER', 'COMPANY_ADMIN') },
      project: {
        findFirst: async () => ({
          id: 'p1',
          workspaceId: 'w1',
          ownerId: 'owner',
          visibility: 'PRIVATE',
          status: 'ACTIVE',
          deletedAt: null,
          teamId: null,
          departmentId: null,
        }),
      },
      projectMembership: { findUnique: async () => null },
    });
    await assert.rejects(
      () =>
        resolveProjectAuthorization(
          client,
          { userId: 'u1', workspaceId: 'w1', workspaceRole: 'PROJECT_MANAGER' },
          'p1',
        ),
      (e: any) => e?.statusCode === 404 && e?.code === 'PROJECT_NOT_FOUND',
    );
  });

  test('visible member lacking permission gets 403 with requiredPermission', async () => {
    const client = projectAuthClient({
      workspaceMembership: { findUnique: async () => activeWorkspaceMembership('MEMBER', null) },
      project: {
        findFirst: async () => ({
          id: 'p1',
          workspaceId: 'w1',
          ownerId: 'owner',
          visibility: 'WORKSPACE',
          status: 'ACTIVE',
          deletedAt: null,
          teamId: null,
          departmentId: null,
        }),
      },
      projectMembership: { findUnique: async () => null },
    });
    await assert.rejects(
      () =>
        authorizeProject(client, {
          actor: { userId: 'u1', workspaceId: 'w1', workspaceRole: 'MEMBER' },
          projectId: 'p1',
          permission: ProjectPermission.Update,
        }),
      (e: any) =>
        e?.statusCode === 403 &&
        e?.code === 'PERMISSION_DENIED' &&
        e?.requiredPermission === 'project.update',
    );
  });

  test('collaborator cannot access unassigned task resource', async () => {
    const client = projectAuthClient({
      workspaceMembership: { findUnique: async () => activeWorkspaceMembership('MEMBER', null) },
      project: {
        findFirst: async () => ({
          id: 'p1',
          workspaceId: 'w1',
          ownerId: 'owner',
          visibility: 'WORKSPACE',
          status: 'ACTIVE',
          deletedAt: null,
          teamId: null,
          departmentId: null,
        }),
      },
      projectMembership: {
        findUnique: async () => ({ projectId: 'p1', userId: 'u1', role: 'COLLABORATOR' }),
      },
      task: {
        findFirst: async () => ({ id: 't1', creatorId: 'other', assignees: [] }),
      },
    });
    await assert.rejects(
      () =>
        authorizeProject(client, {
          actor: { userId: 'u1', workspaceId: 'w1', workspaceRole: 'MEMBER' },
          projectId: 'p1',
          permission: ProjectPermission.TaskView,
          resource: { kind: 'task', taskId: 't1' },
        }),
      (e: any) => e?.statusCode === 403 && e?.code === 'PERMISSION_DENIED',
    );
  });

  test('submission self-approval is forbidden via resource scope', async () => {
    const client = projectAuthClient({
      workspaceMembership: { findUnique: async () => activeWorkspaceMembership('MEMBER', null) },
      project: {
        findFirst: async () => ({
          id: 'p1',
          workspaceId: 'w1',
          ownerId: 'owner',
          visibility: 'WORKSPACE',
          status: 'ACTIVE',
          deletedAt: null,
          teamId: null,
          departmentId: null,
        }),
      },
      projectMembership: {
        findUnique: async () => ({ projectId: 'p1', userId: 'u1', role: 'PROJECT_MANAGER' }),
      },
    });
    await assert.rejects(
      () =>
        authorizeProject(client, {
          actor: { userId: 'u1', workspaceId: 'w1', workspaceRole: 'MEMBER' },
          projectId: 'p1',
          permission: ProjectPermission.SubmissionApprove,
          resource: { kind: 'submission', submissionId: 's1', subjectUserId: 'u1', action: 'approve' },
        }),
      (e: any) => e?.statusCode === 403 && e?.code === 'SELF_REVIEW_FORBIDDEN',
    );
  });
});
