import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  workspaceRoleCanOnTeam,
  teamRoleCan,
  TeamCapability,
} from '../src/modules/authorization/team.policy';
import {
  createTeamSchema,
  updateTeamSchema,
  addTeamMemberSchema,
  updateTeamMemberRoleSchema,
  changeTeamLeadSchema,
  teamMemberRoleSchema,
} from '../src/modules/teams/team.schemas';
import { TeamAuditAction } from '../src/services/audit';

/**
 * Phase 7 unit tests — team authorization policies and schema validation.
 *
 * These tests verify:
 *  - The team capability matrix for every workspace role and team role.
 *  - The Zod schemas for team creation, update, member management and lead change.
 *  - The TeamAuditAction constants are correctly defined.
 *
 * No database connection is required.
 */

// ---------------------------------------------------------------------------
// Team authorization policy
// ---------------------------------------------------------------------------

describe('Phase 7 team authorization policy', () => {
  describe('workspaceRoleCanOnTeam — workspace-level capabilities', () => {
    test('OWNER has full team capabilities', () => {
      assert.equal(workspaceRoleCanOnTeam('OWNER', TeamCapability.ViewTeam), true);
      assert.equal(workspaceRoleCanOnTeam('OWNER', TeamCapability.UpdateTeam), true);
      assert.equal(workspaceRoleCanOnTeam('OWNER', TeamCapability.ArchiveTeam), true);
      assert.equal(workspaceRoleCanOnTeam('OWNER', TeamCapability.DeleteTeam), true);
      assert.equal(workspaceRoleCanOnTeam('OWNER', TeamCapability.ManageMembers), true);
      assert.equal(workspaceRoleCanOnTeam('OWNER', TeamCapability.ViewMembers), true);
    });

    test('PROJECT_MANAGER has full team capabilities', () => {
      assert.equal(workspaceRoleCanOnTeam('PROJECT_MANAGER', TeamCapability.ViewTeam), true);
      assert.equal(workspaceRoleCanOnTeam('PROJECT_MANAGER', TeamCapability.UpdateTeam), true);
      assert.equal(workspaceRoleCanOnTeam('PROJECT_MANAGER', TeamCapability.ArchiveTeam), true);
      assert.equal(workspaceRoleCanOnTeam('PROJECT_MANAGER', TeamCapability.DeleteTeam), true);
      assert.equal(workspaceRoleCanOnTeam('PROJECT_MANAGER', TeamCapability.ManageMembers), true);
      assert.equal(workspaceRoleCanOnTeam('PROJECT_MANAGER', TeamCapability.ViewMembers), true);
    });

    test('MEMBER can view teams and members but not manage them', () => {
      assert.equal(workspaceRoleCanOnTeam('MEMBER', TeamCapability.ViewTeam), true);
      assert.equal(workspaceRoleCanOnTeam('MEMBER', TeamCapability.ViewMembers), true);
      assert.equal(workspaceRoleCanOnTeam('MEMBER', TeamCapability.UpdateTeam), false);
      assert.equal(workspaceRoleCanOnTeam('MEMBER', TeamCapability.ArchiveTeam), false);
      assert.equal(workspaceRoleCanOnTeam('MEMBER', TeamCapability.DeleteTeam), false);
      assert.equal(workspaceRoleCanOnTeam('MEMBER', TeamCapability.ManageMembers), false);
    });

    test('COLLABORATOR has no team capabilities via workspace role', () => {
      assert.equal(workspaceRoleCanOnTeam('COLLABORATOR', TeamCapability.ViewTeam), false);
      assert.equal(workspaceRoleCanOnTeam('COLLABORATOR', TeamCapability.ViewMembers), false);
      assert.equal(workspaceRoleCanOnTeam('COLLABORATOR', TeamCapability.UpdateTeam), false);
      assert.equal(workspaceRoleCanOnTeam('COLLABORATOR', TeamCapability.ManageMembers), false);
    });

    test('VIEWER has no team capabilities via workspace role', () => {
      assert.equal(workspaceRoleCanOnTeam('VIEWER', TeamCapability.ViewTeam), false);
      assert.equal(workspaceRoleCanOnTeam('VIEWER', TeamCapability.ViewMembers), false);
      assert.equal(workspaceRoleCanOnTeam('VIEWER', TeamCapability.UpdateTeam), false);
      assert.equal(workspaceRoleCanOnTeam('VIEWER', TeamCapability.ManageMembers), false);
    });
  });

  describe('teamRoleCan — team-level role capabilities', () => {
    test('TEAM_LEAD can view, update and manage members', () => {
      assert.equal(teamRoleCan('TEAM_LEAD', TeamCapability.ViewTeam), true);
      assert.equal(teamRoleCan('TEAM_LEAD', TeamCapability.ViewMembers), true);
      assert.equal(teamRoleCan('TEAM_LEAD', TeamCapability.UpdateTeam), true);
      assert.equal(teamRoleCan('TEAM_LEAD', TeamCapability.ManageMembers), true);
    });

    test('TEAM_LEAD cannot archive or delete a team', () => {
      assert.equal(teamRoleCan('TEAM_LEAD', TeamCapability.ArchiveTeam), false);
      assert.equal(teamRoleCan('TEAM_LEAD', TeamCapability.DeleteTeam), false);
    });

    test('MEMBER can view team and members', () => {
      assert.equal(teamRoleCan('MEMBER', TeamCapability.ViewTeam), true);
      assert.equal(teamRoleCan('MEMBER', TeamCapability.ViewMembers), true);
    });

    test('MEMBER cannot update, archive, delete or manage members', () => {
      assert.equal(teamRoleCan('MEMBER', TeamCapability.UpdateTeam), false);
      assert.equal(teamRoleCan('MEMBER', TeamCapability.ArchiveTeam), false);
      assert.equal(teamRoleCan('MEMBER', TeamCapability.DeleteTeam), false);
      assert.equal(teamRoleCan('MEMBER', TeamCapability.ManageMembers), false);
    });
  });

  describe('TeamCapability constants are correctly defined', () => {
    test('all expected capability strings are present', () => {
      assert.equal(TeamCapability.ViewTeam, 'team:view');
      assert.equal(TeamCapability.UpdateTeam, 'team:update');
      assert.equal(TeamCapability.ArchiveTeam, 'team:archive');
      assert.equal(TeamCapability.DeleteTeam, 'team:delete');
      assert.equal(TeamCapability.ManageMembers, 'team:manage_members');
      assert.equal(TeamCapability.ViewMembers, 'team:view_members');
    });
  });
});

// ---------------------------------------------------------------------------
// Team audit actions
// ---------------------------------------------------------------------------

describe('Phase 7 TeamAuditAction constants', () => {
  test('all expected audit action strings are defined', () => {
    assert.equal(TeamAuditAction.TeamCreated, 'team.created');
    assert.equal(TeamAuditAction.TeamUpdated, 'team.updated');
    assert.equal(TeamAuditAction.TeamArchived, 'team.archived');
    assert.equal(TeamAuditAction.TeamDeleted, 'team.deleted');
    assert.equal(TeamAuditAction.MemberAdded, 'team.member_added');
    assert.equal(TeamAuditAction.MemberRoleChanged, 'team.member_role_changed');
    assert.equal(TeamAuditAction.MemberRemoved, 'team.member_removed');
    assert.equal(TeamAuditAction.LeadChanged, 'team.lead_changed');
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('Phase 7 team schema validation', () => {
  describe('createTeamSchema', () => {
    test('accepts a valid name', () => {
      const result = createTeamSchema.safeParse({ name: 'Engineering' });
      assert.equal(result.success, true);
    });

    test('accepts name, description and leadId', () => {
      const result = createTeamSchema.safeParse({
        name: 'Engineering',
        description: 'The core engineering team',
        leadId: '550e8400-e29b-41d4-a716-446655440000',
      });
      assert.equal(result.success, true);
    });

    test('accepts a same-workspace department relationship for later authorization', () => {
      const result = createTeamSchema.safeParse({
        name: 'Engineering',
        departmentId: '550e8400-e29b-41d4-a716-446655440000',
      });
      assert.equal(result.success, true);
    });

    test('rejects a name that is too short', () => {
      const result = createTeamSchema.safeParse({ name: 'A' });
      assert.equal(result.success, false);
    });

    test('rejects a name that is too long', () => {
      const result = createTeamSchema.safeParse({ name: 'A'.repeat(81) });
      assert.equal(result.success, false);
    });

    test('rejects a description that is too long', () => {
      const result = createTeamSchema.safeParse({
        name: 'Engineering',
        description: 'D'.repeat(501),
      });
      assert.equal(result.success, false);
    });

    test('rejects an invalid UUID for leadId', () => {
      const result = createTeamSchema.safeParse({
        name: 'Engineering',
        leadId: 'not-a-uuid',
      });
      assert.equal(result.success, false);
    });

    test('rejects unknown fields (strict mode)', () => {
      const result = createTeamSchema.safeParse({
        name: 'Engineering',
        status: 'ARCHIVED',
      });
      assert.equal(result.success, false);
    });
  });

  describe('updateTeamSchema', () => {
    test('accepts a name update', () => {
      const result = updateTeamSchema.safeParse({ name: 'Updated Name' });
      assert.equal(result.success, true);
    });

    test('accepts a description update', () => {
      const result = updateTeamSchema.safeParse({ description: 'New description' });
      assert.equal(result.success, true);
    });

    test('accepts a null description to clear it', () => {
      const result = updateTeamSchema.safeParse({ description: null });
      assert.equal(result.success, true);
    });

    test('accepts department reassignment and explicit unassignment', () => {
      assert.equal(
        updateTeamSchema.safeParse({ departmentId: '550e8400-e29b-41d4-a716-446655440000' })
          .success,
        true,
      );
      assert.equal(updateTeamSchema.safeParse({ departmentId: null }).success, true);
    });

    test('rejects an empty body (at least one field required)', () => {
      const result = updateTeamSchema.safeParse({});
      assert.equal(result.success, false);
    });

    test('rejects unknown fields', () => {
      const result = updateTeamSchema.safeParse({ status: 'ARCHIVED' });
      assert.equal(result.success, false);
    });
  });

  describe('teamMemberRoleSchema', () => {
    test('accepts TEAM_LEAD', () => {
      const result = teamMemberRoleSchema.safeParse('TEAM_LEAD');
      assert.equal(result.success, true);
    });

    test('accepts MEMBER', () => {
      const result = teamMemberRoleSchema.safeParse('MEMBER');
      assert.equal(result.success, true);
    });

    test('rejects unknown roles', () => {
      const result = teamMemberRoleSchema.safeParse('OWNER');
      assert.equal(result.success, false);
    });
  });

  describe('addTeamMemberSchema', () => {
    test('accepts a valid userId with default role', () => {
      const result = addTeamMemberSchema.safeParse({
        userId: '550e8400-e29b-41d4-a716-446655440000',
      });
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.role, 'MEMBER');
      }
    });

    test('accepts TEAM_LEAD role', () => {
      const result = addTeamMemberSchema.safeParse({
        userId: '550e8400-e29b-41d4-a716-446655440000',
        role: 'TEAM_LEAD',
      });
      assert.equal(result.success, true);
    });

    test('rejects an invalid UUID for userId', () => {
      const result = addTeamMemberSchema.safeParse({ userId: 'not-a-uuid' });
      assert.equal(result.success, false);
    });

    test('rejects unknown fields', () => {
      const result = addTeamMemberSchema.safeParse({
        userId: '550e8400-e29b-41d4-a716-446655440000',
        extra: 'field',
      });
      assert.equal(result.success, false);
    });
  });

  describe('updateTeamMemberRoleSchema', () => {
    test('accepts TEAM_LEAD', () => {
      const result = updateTeamMemberRoleSchema.safeParse({ role: 'TEAM_LEAD' });
      assert.equal(result.success, true);
    });

    test('accepts MEMBER', () => {
      const result = updateTeamMemberRoleSchema.safeParse({ role: 'MEMBER' });
      assert.equal(result.success, true);
    });

    test('rejects missing role', () => {
      const result = updateTeamMemberRoleSchema.safeParse({});
      assert.equal(result.success, false);
    });

    test('rejects an unknown role', () => {
      const result = updateTeamMemberRoleSchema.safeParse({ role: 'ADMIN' });
      assert.equal(result.success, false);
    });
  });

  describe('changeTeamLeadSchema', () => {
    test('accepts a valid UUID for leadId', () => {
      const result = changeTeamLeadSchema.safeParse({
        leadId: '550e8400-e29b-41d4-a716-446655440000',
      });
      assert.equal(result.success, true);
    });

    test('accepts null to clear the lead', () => {
      const result = changeTeamLeadSchema.safeParse({ leadId: null });
      assert.equal(result.success, true);
    });

    test('rejects an invalid UUID', () => {
      const result = changeTeamLeadSchema.safeParse({ leadId: 'not-a-uuid' });
      assert.equal(result.success, false);
    });

    test('rejects unknown fields', () => {
      const result = changeTeamLeadSchema.safeParse({
        leadId: null,
        extra: 'field',
      });
      assert.equal(result.success, false);
    });
  });
});
