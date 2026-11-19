import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { TeamAuditAction } from '../src/services/audit';
import {
  addTeamMemberSchema,
  bulkAddTeamMembersSchema,
  changeTeamLeadSchema,
  createTeamSchema,
  teamActivityQuerySchema,
  updateTeamSchema,
} from '../src/modules/teams/team.schemas';
import {
  addProjectTeamSchema,
  assignProjectManagersSchema,
  bulkAddProjectMembersByTeamSchema,
  completeProjectSchema,
  createProjectMilestoneSchema,
  createProjectSchema,
  listProjectsQuerySchema,
  updateProjectMilestoneSchema,
  updateProjectSchema,
} from '../src/modules/projects/project.schemas';
import { createTaskSchema, updateTaskSchema } from '../src/modules/tasks/task.schemas';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('teams/projects gaps - audit constants and schemas', () => {
  test('team audit actions include project link/unlink events for team activity feeds', () => {
    assert.equal(TeamAuditAction.ProjectLinked, 'team.project_linked');
    assert.equal(TeamAuditAction.ProjectUnlinked, 'team.project_unlinked');
  });

  describe('team schemas', () => {
    test('create and update accept responsibilities/scope field', () => {
      assert.equal(
        createTeamSchema.safeParse({ name: 'Platform', responsibilities: 'Owns CI and releases' })
          .success,
        true,
      );
      assert.equal(
        updateTeamSchema.safeParse({ responsibilities: null }).success,
        true,
      );
      assert.equal(
        updateTeamSchema.safeParse({ responsibilities: 'R'.repeat(2001) }).success,
        false,
      );
    });

    test('bulk add team members requires at least one member and validates entries', () => {
      assert.equal(bulkAddTeamMembersSchema.safeParse({ members: [] }).success, false);
      assert.equal(
        bulkAddTeamMembersSchema.safeParse({
          members: [{ userId: uuid(1) }, { userId: uuid(2), role: 'TEAM_LEAD' }],
        }).success,
        true,
      );
      assert.equal(
        bulkAddTeamMembersSchema.safeParse({
          members: [{ userId: 'not-a-uuid' }],
        }).success,
        false,
      );
    });

    test('team activity query supports cursor pagination', () => {
      const ok = teamActivityQuerySchema.safeParse({
        cursor: '2026-11-19T12:00:00.000Z',
        limit: '25',
      });
      assert.equal(ok.success, true);
      if (ok.success) assert.equal(ok.data.limit, 25);
      assert.equal(teamActivityQuerySchema.safeParse({ cursor: 'bad' }).success, false);
    });

    test('change lead schema still allows explicit clear for service-level replacement rules', () => {
      assert.equal(changeTeamLeadSchema.safeParse({ leadId: null }).success, true);
      assert.equal(changeTeamLeadSchema.safeParse({ leadId: uuid(3) }).success, true);
    });

    test('single add member schema remains valid', () => {
      const parsed = addTeamMemberSchema.safeParse({ userId: uuid(4) });
      assert.equal(parsed.success, true);
      if (parsed.success) assert.equal(parsed.data.role, 'MEMBER');
    });
  });

  describe('project schemas', () => {
    test('create accepts structured objectives and multiple teams', () => {
      const result = createProjectSchema.safeParse({
        name: 'Roadmap',
        key: 'ROAD',
        objectives: [
          { title: 'Ship MVP', description: 'First release', completed: false },
          { title: 'Stabilize', completed: true },
        ],
        teamIds: [uuid(1), uuid(2)],
        visibility: 'DEPARTMENT_TEAM',
      });
      assert.equal(result.success, true);
    });

    test('department/team visibility accepts teamIds scope', () => {
      assert.equal(
        createProjectSchema.safeParse({
          name: 'Scoped',
          key: 'SCOP',
          visibility: 'DEPARTMENT_TEAM',
          teamIds: [uuid(1)],
        }).success,
        true,
      );
    });

    test('update accepts objectives and teamIds additively', () => {
      assert.equal(
        updateProjectSchema.safeParse({
          objectives: [{ title: 'New objective' }],
          teamIds: [uuid(1)],
        }).success,
        true,
      );
      assert.equal(
        updateProjectSchema.safeParse({ objectives: null }).success,
        true,
      );
    });

    test('complete project schema supports explicit force flag', () => {
      const parsed = completeProjectSchema.safeParse({ force: true });
      assert.equal(parsed.success, true);
      if (parsed.success) assert.equal(parsed.data.force, true);
      const defaults = completeProjectSchema.safeParse({});
      assert.equal(defaults.success, true);
      if (defaults.success) assert.equal(defaults.data.force, false);
    });

    test('bulk add by team and manager assignment schemas validate input', () => {
      assert.equal(
        bulkAddProjectMembersByTeamSchema.safeParse({ teamId: uuid(1), role: 'VIEWER' }).success,
        true,
      );
      assert.equal(
        assignProjectManagersSchema.safeParse({ userIds: [uuid(1), uuid(2)] }).success,
        true,
      );
      assert.equal(assignProjectManagersSchema.safeParse({ userIds: [] }).success, false);
    });

    test('project team association schema validates team id', () => {
      assert.equal(addProjectTeamSchema.safeParse({ teamId: uuid(1) }).success, true);
      assert.equal(addProjectTeamSchema.safeParse({ teamId: 'bad' }).success, false);
    });

    test('project list query remains compatible', () => {
      const parsed = listProjectsQuerySchema.safeParse({ limit: '10', includeArchived: 'false' });
      assert.equal(parsed.success, true);
      if (parsed.success) {
        assert.equal(parsed.data.limit, 10);
        assert.equal(parsed.data.includeArchived, false);
      }
    });

    test('milestone schemas remain strict and valid', () => {
      assert.equal(
        createProjectMilestoneSchema.safeParse({ name: 'M1', position: 2 }).success,
        true,
      );
      assert.equal(updateProjectMilestoneSchema.safeParse({ completed: false }).success, true);
    });
  });

  describe('task milestone linking schemas', () => {
    test('create task accepts milestoneId', () => {
      assert.equal(
        createTaskSchema.safeParse({ title: 'Task A', milestoneId: uuid(1) }).success,
        true,
      );
      assert.equal(
        createTaskSchema.safeParse({ title: 'Task A', milestoneId: null }).success,
        true,
      );
    });

    test('update task accepts milestoneId changes', () => {
      assert.equal(updateTaskSchema.safeParse({ milestoneId: uuid(2) }).success, true);
      assert.equal(updateTaskSchema.safeParse({ milestoneId: null }).success, true);
    });
  });
});
