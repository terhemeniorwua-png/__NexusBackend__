import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  workspaceRoleCan,
  WorkspaceCapability,
  assertMayManageMember,
  assertOwnershipSafe,
} from '../src/modules/authorization/workspace.policy';
import {
  workspaceRoleCanOnProject,
  projectRoleCan,
  ProjectCapability,
} from '../src/modules/authorization/project.policy';
import {
  workspaceRoleCanOnTeam,
  teamRoleCan,
  TeamCapability,
} from '../src/modules/authorization/team.policy';
import { transferOwnershipSchema } from '../src/modules/workspaces/workspace.schemas';

/**
 * Phase 6 unit tests — authorization policies.
 *
 * These tests verify the full permission matrix for workspace, project, and
 * team scopes, the ownership transfer rules, the self-removal guard, and the
 * validation schema.  No database is required.
 */

// ---------------------------------------------------------------------------
// Workspace policy
// ---------------------------------------------------------------------------

describe('Phase 6 workspace policy', () => {
  describe('workspaceRoleCan — basic read capabilities', () => {
    test('every role may view a workspace', () => {
      for (const role of [
        'OWNER',
        'PROJECT_MANAGER',
        'MEMBER',
        'COLLABORATOR',
        'VIEWER',
      ] as const) {
        assert.equal(
          workspaceRoleCan(role, WorkspaceCapability.ViewWorkspace),
          true,
          `${role} should be able to view workspace`,
        );
        assert.equal(
          workspaceRoleCan(role, WorkspaceCapability.ViewMembers),
          true,
          `${role} should be able to view members`,
        );
      }
    });

    test('only OWNER and PROJECT_MANAGER may update a workspace', () => {
      assert.equal(workspaceRoleCan('OWNER', WorkspaceCapability.UpdateWorkspace), true);
      assert.equal(workspaceRoleCan('PROJECT_MANAGER', WorkspaceCapability.UpdateWorkspace), true);
      assert.equal(workspaceRoleCan('MEMBER', WorkspaceCapability.UpdateWorkspace), false);
      assert.equal(workspaceRoleCan('COLLABORATOR', WorkspaceCapability.UpdateWorkspace), false);
      assert.equal(workspaceRoleCan('VIEWER', WorkspaceCapability.UpdateWorkspace), false);
    });

    test('only OWNER may archive or delete a workspace', () => {
      assert.equal(workspaceRoleCan('OWNER', WorkspaceCapability.ArchiveWorkspace), true);
      assert.equal(workspaceRoleCan('OWNER', WorkspaceCapability.DeleteWorkspace), true);
      assert.equal(
        workspaceRoleCan('PROJECT_MANAGER', WorkspaceCapability.ArchiveWorkspace),
        false,
      );
      assert.equal(workspaceRoleCan('PROJECT_MANAGER', WorkspaceCapability.DeleteWorkspace), false);
      assert.equal(workspaceRoleCan('MEMBER', WorkspaceCapability.DeleteWorkspace), false);
      assert.equal(workspaceRoleCan('COLLABORATOR', WorkspaceCapability.DeleteWorkspace), false);
      assert.equal(workspaceRoleCan('VIEWER', WorkspaceCapability.DeleteWorkspace), false);
    });

    test('only OWNER may transfer ownership', () => {
      assert.equal(workspaceRoleCan('OWNER', WorkspaceCapability.TransferOwnership), true);
      assert.equal(
        workspaceRoleCan('PROJECT_MANAGER', WorkspaceCapability.TransferOwnership),
        false,
      );
      assert.equal(workspaceRoleCan('MEMBER', WorkspaceCapability.TransferOwnership), false);
      assert.equal(workspaceRoleCan('COLLABORATOR', WorkspaceCapability.TransferOwnership), false);
      assert.equal(workspaceRoleCan('VIEWER', WorkspaceCapability.TransferOwnership), false);
    });

    test('only OWNER and PROJECT_MANAGER may manage members and invitations', () => {
      for (const cap of [
        WorkspaceCapability.ManageMembers,
        WorkspaceCapability.ViewInvitations,
        WorkspaceCapability.ManageInvitations,
      ] as const) {
        assert.equal(workspaceRoleCan('OWNER', cap), true, `OWNER should have ${cap}`);
        assert.equal(
          workspaceRoleCan('PROJECT_MANAGER', cap),
          true,
          `PROJECT_MANAGER should have ${cap}`,
        );
        assert.equal(workspaceRoleCan('MEMBER', cap), false, `MEMBER should not have ${cap}`);
        assert.equal(
          workspaceRoleCan('COLLABORATOR', cap),
          false,
          `COLLABORATOR should not have ${cap}`,
        );
        assert.equal(workspaceRoleCan('VIEWER', cap), false, `VIEWER should not have ${cap}`);
      }
    });
  });

  describe('assertMayManageMember', () => {
    test('the owner cannot be changed or removed', () => {
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
    });

    test('a project manager can manage a lower role', () => {
      assert.doesNotThrow(() =>
        assertMayManageMember({
          actorRole: 'PROJECT_MANAGER',
          targetRole: 'MEMBER',
          targetIsOwner: false,
        }),
      );

      assert.doesNotThrow(() =>
        assertMayManageMember({
          actorRole: 'PROJECT_MANAGER',
          targetRole: 'COLLABORATOR',
          targetIsOwner: false,
        }),
      );

      assert.doesNotThrow(() =>
        assertMayManageMember({
          actorRole: 'PROJECT_MANAGER',
          targetRole: 'VIEWER',
          targetIsOwner: false,
        }),
      );
    });

    test('the owner can manage any non-owner member including a project manager', () => {
      assert.doesNotThrow(() =>
        assertMayManageMember({
          actorRole: 'OWNER',
          targetRole: 'PROJECT_MANAGER',
          targetIsOwner: false,
        }),
      );
    });
  });

  describe('assertOwnershipSafe', () => {
    const ownerId = 'user-owner-id';

    test('owner cannot remove themselves (self-removal block)', () => {
      assert.throws(
        () =>
          assertOwnershipSafe({
            actorId: ownerId,
            targetUserId: ownerId,
            targetRole: 'OWNER',
            workspaceOwnerId: ownerId,
          }),
        /OWNER_CANNOT_LEAVE|owner cannot remove themselves/i,
      );
    });

    test('owner removing another member is allowed', () => {
      assert.doesNotThrow(() =>
        assertOwnershipSafe({
          actorId: ownerId,
          targetUserId: 'user-member-id',
          targetRole: 'MEMBER',
          workspaceOwnerId: ownerId,
        }),
      );
    });

    test('non-owner self-removal is allowed', () => {
      assert.doesNotThrow(() =>
        assertOwnershipSafe({
          actorId: 'user-member-id',
          targetUserId: 'user-member-id',
          targetRole: 'MEMBER',
          workspaceOwnerId: ownerId,
        }),
      );
    });

    test('non-owner removing another non-owner is allowed', () => {
      assert.doesNotThrow(() =>
        assertOwnershipSafe({
          actorId: 'user-pm-id',
          targetUserId: 'user-member-id',
          targetRole: 'MEMBER',
          workspaceOwnerId: ownerId,
        }),
      );
    });
  });

  describe('transferOwnershipSchema', () => {
    test('accepts a valid role for the outgoing owner', () => {
      const result = transferOwnershipSchema.safeParse({ newOwnerRole: 'PROJECT_MANAGER' });
      assert.equal(result.success, true);
    });

    test('defaults newOwnerRole to PROJECT_MANAGER', () => {
      const result = transferOwnershipSchema.safeParse({});
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.newOwnerRole, 'PROJECT_MANAGER');
      }
    });

    test('rejects OWNER as the post-transfer role', () => {
      const result = transferOwnershipSchema.safeParse({ newOwnerRole: 'OWNER' });
      assert.equal(result.success, false);
    });

    test('rejects unknown fields (strict schema)', () => {
      const result = transferOwnershipSchema.safeParse({
        newOwnerRole: 'MEMBER',
        extraField: 'bad',
      });
      assert.equal(result.success, false);
    });
  });
});

// ---------------------------------------------------------------------------
// Project policy
// ---------------------------------------------------------------------------

describe('Phase 6 project policy', () => {
  describe('workspaceRoleCanOnProject', () => {
    test('OWNER has all project capabilities', () => {
      for (const cap of Object.values(ProjectCapability)) {
        assert.equal(
          workspaceRoleCanOnProject('OWNER', cap),
          true,
          `OWNER should have project:${cap}`,
        );
      }
    });

    test('PROJECT_MANAGER has all project capabilities', () => {
      for (const cap of Object.values(ProjectCapability)) {
        assert.equal(
          workspaceRoleCanOnProject('PROJECT_MANAGER', cap),
          true,
          `PROJECT_MANAGER should have project:${cap}`,
        );
      }
    });

    test('MEMBER, COLLABORATOR, VIEWER have no default project capabilities', () => {
      for (const role of ['MEMBER', 'COLLABORATOR', 'VIEWER'] as const) {
        for (const cap of Object.values(ProjectCapability)) {
          assert.equal(
            workspaceRoleCanOnProject(role, cap),
            false,
            `${role} should not have ${cap} via workspace role alone`,
          );
        }
      }
    });
  });

  describe('projectRoleCan', () => {
    test('project PROJECT_MANAGER can view, update, archive, manage members, tasks and files', () => {
      assert.equal(projectRoleCan('PROJECT_MANAGER', ProjectCapability.ViewProject), true);
      assert.equal(projectRoleCan('PROJECT_MANAGER', ProjectCapability.UpdateProject), true);
      assert.equal(projectRoleCan('PROJECT_MANAGER', ProjectCapability.ArchiveProject), true);
      assert.equal(projectRoleCan('PROJECT_MANAGER', ProjectCapability.ManageMembers), true);
      assert.equal(projectRoleCan('PROJECT_MANAGER', ProjectCapability.CreateTask), true);
      assert.equal(projectRoleCan('PROJECT_MANAGER', ProjectCapability.ManageTask), true);
      assert.equal(projectRoleCan('PROJECT_MANAGER', ProjectCapability.ViewTasks), true);
      assert.equal(projectRoleCan('PROJECT_MANAGER', ProjectCapability.ManageFiles), true);
    });

    test('project PROJECT_MANAGER cannot delete a project', () => {
      assert.equal(projectRoleCan('PROJECT_MANAGER', ProjectCapability.DeleteProject), false);
    });

    test('project MEMBER can create and manage tasks but not change the project itself', () => {
      assert.equal(projectRoleCan('MEMBER', ProjectCapability.ViewProject), true);
      assert.equal(projectRoleCan('MEMBER', ProjectCapability.CreateTask), true);
      assert.equal(projectRoleCan('MEMBER', ProjectCapability.ManageTask), true);
      assert.equal(projectRoleCan('MEMBER', ProjectCapability.UpdateProject), false);
      assert.equal(projectRoleCan('MEMBER', ProjectCapability.ArchiveProject), false);
      assert.equal(projectRoleCan('MEMBER', ProjectCapability.DeleteProject), false);
      assert.equal(projectRoleCan('MEMBER', ProjectCapability.ManageMembers), false);
      assert.equal(projectRoleCan('MEMBER', ProjectCapability.ManageFiles), false);
    });

    test('project VIEWER can only view', () => {
      assert.equal(projectRoleCan('VIEWER', ProjectCapability.ViewProject), true);
      assert.equal(projectRoleCan('VIEWER', ProjectCapability.ViewTasks), true);
      assert.equal(projectRoleCan('VIEWER', ProjectCapability.ViewFiles), true);
      assert.equal(projectRoleCan('VIEWER', ProjectCapability.CreateTask), false);
      assert.equal(projectRoleCan('VIEWER', ProjectCapability.ManageTask), false);
      assert.equal(projectRoleCan('VIEWER', ProjectCapability.UpdateProject), false);
      assert.equal(projectRoleCan('VIEWER', ProjectCapability.ManageMembers), false);
    });
  });
});

// ---------------------------------------------------------------------------
// Team policy
// ---------------------------------------------------------------------------

describe('Phase 6 team policy', () => {
  describe('workspaceRoleCanOnTeam', () => {
    test('OWNER has all team capabilities', () => {
      for (const cap of Object.values(TeamCapability)) {
        assert.equal(workspaceRoleCanOnTeam('OWNER', cap), true, `OWNER should have ${cap}`);
      }
    });

    test('PROJECT_MANAGER has all team capabilities', () => {
      for (const cap of Object.values(TeamCapability)) {
        assert.equal(
          workspaceRoleCanOnTeam('PROJECT_MANAGER', cap),
          true,
          `PROJECT_MANAGER should have ${cap}`,
        );
      }
    });

    test('MEMBER can view teams and members but not manage them', () => {
      assert.equal(workspaceRoleCanOnTeam('MEMBER', TeamCapability.ViewTeam), true);
      assert.equal(workspaceRoleCanOnTeam('MEMBER', TeamCapability.ViewMembers), true);
      assert.equal(workspaceRoleCanOnTeam('MEMBER', TeamCapability.UpdateTeam), false);
      assert.equal(workspaceRoleCanOnTeam('MEMBER', TeamCapability.ArchiveTeam), false);
      assert.equal(workspaceRoleCanOnTeam('MEMBER', TeamCapability.DeleteTeam), false);
      assert.equal(workspaceRoleCanOnTeam('MEMBER', TeamCapability.ManageMembers), false);
    });

    test('COLLABORATOR and VIEWER have no default team capabilities via workspace role', () => {
      for (const role of ['COLLABORATOR', 'VIEWER'] as const) {
        for (const cap of Object.values(TeamCapability)) {
          assert.equal(
            workspaceRoleCanOnTeam(role, cap),
            false,
            `${role} should not have ${cap} via workspace role alone`,
          );
        }
      }
    });
  });

  describe('teamRoleCan', () => {
    test('TEAM_LEAD can view, update and manage members', () => {
      assert.equal(teamRoleCan('TEAM_LEAD', TeamCapability.ViewTeam), true);
      assert.equal(teamRoleCan('TEAM_LEAD', TeamCapability.UpdateTeam), true);
      assert.equal(teamRoleCan('TEAM_LEAD', TeamCapability.ManageMembers), true);
      assert.equal(teamRoleCan('TEAM_LEAD', TeamCapability.ViewMembers), true);
    });

    test('TEAM_LEAD cannot archive or delete a team', () => {
      assert.equal(teamRoleCan('TEAM_LEAD', TeamCapability.ArchiveTeam), false);
      assert.equal(teamRoleCan('TEAM_LEAD', TeamCapability.DeleteTeam), false);
    });

    test('team MEMBER can view but not manage', () => {
      assert.equal(teamRoleCan('MEMBER', TeamCapability.ViewTeam), true);
      assert.equal(teamRoleCan('MEMBER', TeamCapability.ViewMembers), true);
      assert.equal(teamRoleCan('MEMBER', TeamCapability.UpdateTeam), false);
      assert.equal(teamRoleCan('MEMBER', TeamCapability.ManageMembers), false);
      assert.equal(teamRoleCan('MEMBER', TeamCapability.ArchiveTeam), false);
      assert.equal(teamRoleCan('MEMBER', TeamCapability.DeleteTeam), false);
    });
  });
});
