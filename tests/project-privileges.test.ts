import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  PROJECT_ROLE_PERMISSIONS,
  ProjectPermission,
  assertNotSelfReview,
  assignableProjectRoles,
  maximumProjectRoleForMember,
  projectRoleExceedsCeiling,
} from '../src/modules/authorization/project.permissions';
import { effectiveWorkspaceRole } from '../src/modules/authorization/organization-role';

describe('project permission matrix', () => {
  test('task.update never implies submission.approve', () => {
    assert.equal(PROJECT_ROLE_PERMISSIONS.MEMBER.includes(ProjectPermission.TaskUpdate), true);
    assert.equal(PROJECT_ROLE_PERMISSIONS.MEMBER.includes(ProjectPermission.SubmissionApprove), false);
    assert.equal(PROJECT_ROLE_PERMISSIONS.PROJECT_MANAGER.includes(ProjectPermission.TaskUpdate), true);
    assert.equal(PROJECT_ROLE_PERMISSIONS.PROJECT_MANAGER.includes(ProjectPermission.SubmissionApprove), true);
  });

  test('project.delete is not granted by project roles', () => {
    for (const role of ['PROJECT_MANAGER', 'MEMBER', 'COLLABORATOR', 'VIEWER'] as const) {
      assert.equal(PROJECT_ROLE_PERMISSIONS[role].includes(ProjectPermission.Delete), false);
    }
  });

  test('collaborator cannot create or edit tasks', () => {
    assert.equal(PROJECT_ROLE_PERMISSIONS.COLLABORATOR.includes(ProjectPermission.TaskCreate), false);
    assert.equal(PROJECT_ROLE_PERMISSIONS.COLLABORATOR.includes(ProjectPermission.TaskUpdate), false);
    assert.equal(PROJECT_ROLE_PERMISSIONS.COLLABORATOR.includes(ProjectPermission.TaskComplete), true);
  });

  test('viewer is read-only', () => {
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
      maximumProjectRoleForMember({ workspaceRole: 'MEMBER', organizationRole: 'INSTITUTION_STUDENT' }),
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
      assertNotSelfReview({ actorId: 'u1', subjectUserId: 'u2', action: 'approve' }),
    );
  });

  test('role ceiling violations are detected', () => {
    assert.equal(projectRoleExceedsCeiling('PROJECT_MANAGER', 'MEMBER'), true);
    assert.equal(projectRoleExceedsCeiling('MEMBER', 'MEMBER'), false);
  });

  test('organization admins map to project-manager capable workspace role', () => {
    assert.equal(
      effectiveWorkspaceRole('COMPANY', 'MEMBER', 'COMPANY_ADMIN'),
      'PROJECT_MANAGER',
    );
  });
});
