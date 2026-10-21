import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  assertMayManageMember,
  roleCan,
  WorkspaceCapability,
} from '../src/modules/workspaces/authorization';
import { maskInvitationEmail } from '../src/modules/workspaces/invitation.service';
import { slugifyWorkspaceName } from '../src/modules/workspaces/workspace.service';
import {
  addMemberSchema,
  assignableRoleSchema,
  createInvitationSchema,
  createWorkspaceSchema,
  updateWorkspaceSchema,
} from '../src/modules/workspaces/workspace.schemas';

/**
 * Phase 5 unit tests.
 *
 * These cover the parts of the workspace module that do not need a database:
 * the role matrix, the slug of a workspace, the masking of an address and the
 * validation of the request bodies.
 */

describe('Phase 5 workspace rules', () => {
  test('every role may read a workspace', () => {
    for (const role of ['OWNER', 'PROJECT_MANAGER', 'MEMBER', 'COLLABORATOR', 'VIEWER'] as const) {
      assert.equal(roleCan(role, WorkspaceCapability.ViewWorkspace), true, role);
      assert.equal(roleCan(role, WorkspaceCapability.ViewMembers), true, role);
    }
  });

  test('only the owner and a project manager may change a workspace', () => {
    assert.equal(roleCan('OWNER', WorkspaceCapability.UpdateWorkspace), true);
    assert.equal(roleCan('PROJECT_MANAGER', WorkspaceCapability.UpdateWorkspace), true);
    assert.equal(roleCan('MEMBER', WorkspaceCapability.UpdateWorkspace), false);
    assert.equal(roleCan('COLLABORATOR', WorkspaceCapability.UpdateWorkspace), false);
    assert.equal(roleCan('VIEWER', WorkspaceCapability.UpdateWorkspace), false);
  });

  test('only the owner may archive or delete a workspace', () => {
    assert.equal(roleCan('OWNER', WorkspaceCapability.ArchiveWorkspace), true);
    assert.equal(roleCan('OWNER', WorkspaceCapability.DeleteWorkspace), true);
    assert.equal(roleCan('PROJECT_MANAGER', WorkspaceCapability.ArchiveWorkspace), false);
    assert.equal(roleCan('PROJECT_MANAGER', WorkspaceCapability.DeleteWorkspace), false);
    assert.equal(roleCan('MEMBER', WorkspaceCapability.DeleteWorkspace), false);
  });

  test('the owner of a workspace cannot be changed or removed', () => {
    assert.throws(
      () =>
        assertMayManageMember({
          actorRole: 'OWNER',
          targetRole: 'OWNER',
          targetIsOwner: true,
        }),
      /owner of a workspace cannot be changed or removed/i,
    );
  });

  test('a project manager cannot manage another project manager', () => {
    assert.throws(
      () =>
        assertMayManageMember({
          actorRole: 'PROJECT_MANAGER',
          targetRole: 'PROJECT_MANAGER',
          targetIsOwner: false,
        }),
      /Only the owner of a workspace can manage a project manager/i,
    );

    assert.doesNotThrow(() =>
      assertMayManageMember({
        actorRole: 'PROJECT_MANAGER',
        targetRole: 'MEMBER',
        targetIsOwner: false,
      }),
    );
  });

  test('a slug keeps the name readable', () => {
    assert.equal(slugifyWorkspaceName('Acme Rockets'), 'acme-rockets');
    assert.equal(slugifyWorkspaceName('  Ünïcode & Spaces  '), 'unicode-spaces');
    assert.equal(slugifyWorkspaceName('Team 42'), 'team-42');
    assert.equal(slugifyWorkspaceName('---'), '');
  });

  test('the address of an invitation is masked', () => {
    assert.equal(maskInvitationEmail('philip@example.com'), 'p***@example.com');
    assert.equal(maskInvitationEmail('broken'), '***');
  });

  test('the owner role cannot be handed out', () => {
    assert.equal(assignableRoleSchema.safeParse('OWNER').success, false);
    assert.equal(assignableRoleSchema.safeParse('MEMBER').success, true);
    assert.equal(assignableRoleSchema.safeParse('PROJECT_MANAGER').success, true);
  });

  test('a workspace needs a name', () => {
    assert.equal(createWorkspaceSchema.safeParse({ name: 'Acme' }).success, true);
    assert.equal(createWorkspaceSchema.safeParse({ name: 'A' }).success, false);
    assert.equal(createWorkspaceSchema.safeParse({}).success, false);
  });

  test('unknown fields are rejected', () => {
    assert.equal(
      createWorkspaceSchema.safeParse({ name: 'Acme', ownerId: 'someone-else' }).success,
      false,
    );
    assert.equal(
      addMemberSchema.safeParse({ email: 'a@example.com', role: 'OWNER' }).success,
      false,
    );
    assert.equal(
      updateWorkspaceSchema.safeParse({ name: 'Acme', status: 'ARCHIVED' }).success,
      false,
    );
  });

  test('an invitation needs a valid address', () => {
    assert.equal(createInvitationSchema.safeParse({ email: 'a@example.com' }).success, true);
    assert.equal(createInvitationSchema.safeParse({ email: 'not-an-address' }).success, false);
  });

  test('an address is stored in lower case', () => {
    const parsed = createInvitationSchema.parse({ email: '  Person@Example.COM ' });

    assert.equal(parsed.email, 'person@example.com');
  });
});
